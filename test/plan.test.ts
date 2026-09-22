import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  IMPORT_SCHEMA_VERSION,
  MemoryManifestStore,
  PubkyShopError,
  SYNC_MANY_LIMIT,
  actionFor,
  browserFileSource,
  canonicalCsvRowIdentity,
  checkpointImportRow,
  chunkSyncManyListings,
  classifySyncManyItem,
  deterministicIdempotencyKey,
  dryRunCounts,
  exportCanonicalCsv,
  normalizedCsvRowHash,
  planImport,
  planImportStream,
  resumeTasks,
  streamResumeTasks,
  type ImportManifest,
  type ManifestStore,
} from "../src/index.js";
import { sampleRow } from "./helpers.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function code(error: unknown, expected: string): boolean {
  return error instanceof PubkyShopError && error.code === expected;
}

class CountingStore extends MemoryManifestStore {
  creates = 0;

  override async create(manifest: ImportManifest): Promise<void> {
    this.creates += 1;
    await super.create(manifest);
  }
}

class CasOnlyStore implements ManifestStore {
  readonly inner = new MemoryManifestStore();

  create(manifest: ImportManifest): Promise<void> {
    return this.inner.create(manifest);
  }

  load(manifestId: string): Promise<ImportManifest | null> {
    return this.inner.load(manifestId);
  }

  compareAndSwap(
    manifestId: string,
    expectedVersion: number,
    update: (manifest: ImportManifest) => ImportManifest,
  ): Promise<ImportManifest> {
    return this.inner.compareAndSwap(manifestId, expectedVersion, update);
  }
}

function nodeIdempotencyKey(
  manifestId: string,
  rowIdentity: string,
  normalizedHash: string,
): string {
  const bytes = createHash("sha256")
    .update(IMPORT_SCHEMA_VERSION)
    .update("\0")
    .update(manifestId)
    .update("\0")
    .update(rowIdentity)
    .update("\0")
    .update(normalizedHash)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const item of items) {
    values.push(item);
  }
  return values;
}

test("planImport streams CSV into a memory store with create actions", async () => {
  const store = new CountingStore();
  const bytes = exportCanonicalCsv([sampleRow()]);
  const planned = await planImport(bytes, {
    store,
    manifestId: "manifest-browser-1",
    now: () => new Date("2026-09-22T10:00:00.000Z"),
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) {
    return;
  }
  assert.equal(store.creates, 1);
  assert.equal(planned.value.manifestId, "manifest-browser-1");
  assert.equal(planned.value.rowCount, 1);
  assert.equal(planned.value.rows[0]?.intendedAction, "create");
  assert.equal(planned.value.rows[0]?.checkpoint, "planned");
  assert.equal(planned.value.rows[0]?.listingId, "boots_01");
  assert.deepEqual(dryRunCounts(planned.value), {
    create: 1,
    update: 0,
    end: 0,
    unchanged: 0,
    conflict: 0,
  });
});

test("JSON array and {rows:[]} plan without creating a Node spool", async () => {
  const store = new CountingStore();
  const row = sampleRow({
    listingId: "json_01",
    recordUri: sampleRow().recordUri.replace("boots_01", "json_01"),
    sku: "JSON-01",
  });
  const arrayBytes = encoder.encode(JSON.stringify([row]));
  const wrappedBytes = encoder.encode(JSON.stringify({ rows: [row] }));
  const fromArray = await planImport(arrayBytes, { store, manifestId: "json-array" });
  const fromWrapped = await planImport(wrappedBytes, { store, manifestId: "json-wrapped" });
  assert.equal(fromArray.ok, true);
  assert.equal(fromWrapped.ok, true);
  assert.equal(store.creates, 2);
  if (fromArray.ok && fromWrapped.ok) {
    assert.equal(fromArray.value.rows[0]?.intendedAction, "create");
    assert.equal(fromWrapped.value.rows[0]?.sku, "JSON-01");
  }
});

test("parse failures never call store.create (D6.19)", async () => {
  const store = new CountingStore();
  const valid = decoder.decode(exportCanonicalCsv([sampleRow()]));
  const malformed = await planImport(encoder.encode(valid.replace(/\r\n/g, "\n")), { store });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.equal(malformed.error.code, "malformed_csv");
  }
  const formula = valid.replace(
    "'=literal formula-like description",
    '=HYPERLINK(""https://attacker.example"")',
  );
  const injected = await planImport(encoder.encode(formula), { store });
  assert.equal(injected.ok, false);
  if (!injected.ok) {
    assert.equal(injected.error.code, "formula_payload");
  }
  const invalidJson = await planImport(encoder.encode("{not-json"), { store });
  assert.equal(invalidJson.ok, false);
  assert.equal(store.creates, 0);
});

test("identity collisions fail before commit", async () => {
  const cases: Array<{ bytes: Uint8Array; code: string }> = [
    { bytes: encoder.encode(JSON.stringify([sampleRow(), sampleRow()])), code: "duplicate_row" },
    {
      bytes: encoder.encode(
        JSON.stringify([sampleRow(), sampleRow({ sku: "DIFFERENT-SKU", variantQuantity: 4 })]),
      ),
      code: "duplicate_variant_id",
    },
    {
      bytes: encoder.encode(
        JSON.stringify([
          sampleRow(),
          sampleRow({
            listingId: "other",
            recordUri: sampleRow().recordUri.replace("boots_01", "other"),
            variantId: "other_variant",
          }),
        ]),
      ),
      code: "ambiguous_sku",
    },
    {
      bytes: encoder.encode(
        JSON.stringify([
          sampleRow(),
          sampleRow({ variantId: "second_variant", sku: "SECOND", title: "changed title" }),
        ]),
      ),
      code: "conflicting_listing_fields",
    },
  ];
  for (const item of cases) {
    const store = new CountingStore();
    const planned = await planImport(item.bytes, { store, manifestId: `fail-${item.code}` });
    assert.equal(planned.ok, false, item.code);
    if (!planned.ok) {
      assert.equal(planned.error.code, item.code, item.code);
    }
    assert.equal(store.creates, 0, item.code);
  }
});

test("byte and row caps fail closed with typed observed values", async () => {
  const store = new CountingStore();
  const bytes = exportCanonicalCsv([sampleRow()]);
  const oversize = await planImport(bytes, { store, limits: { maxBytes: 8 } });
  assert.equal(oversize.ok, false);
  if (!oversize.ok) {
    assert.equal(oversize.error.code, "limit_exceeded");
    assert.equal(oversize.error.details.field, "csv_bytes");
    assert.equal(oversize.error.details.limit, 8);
  }
  const twoRows = encoder.encode(
    JSON.stringify([
      sampleRow(),
      sampleRow({
        listingId: "second",
        recordUri: sampleRow().recordUri.replace("boots_01", "second"),
        variantId: "second_variant",
        sku: "SECOND",
      }),
    ]),
  );
  const tooMany = await planImport(twoRows, { store, limits: { maxRows: 1 } });
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) {
    assert.equal(tooMany.error.code, "limit_exceeded");
    assert.equal(tooMany.error.details.field, "csv_rows");
  }
  assert.equal(store.creates, 0);
});

test("browserFileSource rejects oversize Files before streaming", () => {
  let streamed = false;
  const file = {
    size: 64 * 1024 * 1024 + 1,
    stream() {
      streamed = true;
      return new ReadableStream<Uint8Array>();
    },
  };
  assert.throws(
    () => browserFileSource(file),
    (error: unknown) => code(error, "limit_exceeded"),
  );
  assert.equal(streamed, false);
});

test("planImportStream accepts a Web ReadableStream of CSV bytes", async () => {
  const store = new CountingStore();
  const bytes = exportCanonicalCsv([sampleRow()]);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const planned = await planImportStream(source, { store, manifestId: "stream-1" });
  assert.equal(planned.ok, true);
  if (planned.ok) {
    assert.equal(planned.value.manifest.rowCount, 1);
    assert.equal(store.creates, 1);
  }
});

test("chunkSyncManyListings never exceeds the service cap of 100", () => {
  const items = Array.from({ length: 101 }, (_, index) => index);
  const chunks = chunkSyncManyListings(items);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.length, SYNC_MANY_LIMIT);
  assert.equal(chunks[1]?.length, 1);
  assert.throws(
    () => chunkSyncManyListings(items, SYNC_MANY_LIMIT + 1),
    (error: unknown) => code(error, "invalid_configuration"),
  );
});

test("classifySyncManyItem reads per-id 207 results, not the envelope HTTP status", () => {
  assert.equal(classifySyncManyItem({ listing_id: "ok", status: 200 }).ok, true);
  assert.equal(classifySyncManyItem({ listing_id: "ok", status: "201" }).ok, true);
  const failed = classifySyncManyItem({
    listing_id: "boots",
    status: 422,
    result: { error: { message: "invalid_batch" } },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.listingId, "boots");
  assert.equal(failed.message, "invalid_batch");
  const conflict = classifySyncManyItem({
    listing_id: "boots",
    status: 409,
    message: "revision_conflict",
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 409);
});

test("idempotency keys match the Node SHA-256 UUID construction", async () => {
  const store = new MemoryManifestStore();
  const row = sampleRow();
  const planned = await planImport(exportCanonicalCsv([row]), {
    store,
    manifestId: "idem-1",
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) {
    return;
  }
  const plannedRow = planned.value.rows[0];
  assert.ok(plannedRow);
  const expected = nodeIdempotencyKey(
    "idem-1",
    canonicalCsvRowIdentity(row),
    normalizedCsvRowHash(row),
  );
  assert.equal(plannedRow.idempotencyKey, expected);
  assert.equal(
    deterministicIdempotencyKey("idem-1", plannedRow.rowIdentity, plannedRow.normalizedHash),
    expected,
  );
  const again = await planImport(exportCanonicalCsv([row]), {
    store: new MemoryManifestStore(),
    manifestId: "idem-1",
  });
  assert.equal(again.ok, true);
  if (again.ok) {
    assert.equal(again.value.rows[0]?.idempotencyKey, expected);
  }
});

test("resumeTasks maps publishing to reconcile_publish and never repeats a completed row", async () => {
  const store = new CasOnlyStore();
  const planned = await planImport(exportCanonicalCsv([sampleRow()]), {
    store,
    manifestId: "resume-1",
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) {
    return;
  }
  const rowIdentity = planned.value.rows[0]?.rowIdentity;
  assert.ok(rowIdentity);
  assert.deepEqual(resumeTasks(planned.value), [{ rowIdentity, next: "publish" }]);
  const publishing = await checkpointImportRow(store, "resume-1", 1, rowIdentity, "publishing");
  assert.equal(publishing.ok, true);
  if (!publishing.ok) {
    return;
  }
  assert.deepEqual(await collect(streamResumeTasks(store, "resume-1")), [
    { rowIdentity, next: "reconcile_publish" },
  ]);
  const unsynced = await checkpointImportRow(
    store,
    "resume-1",
    publishing.value.manifest.manifestVersion,
    rowIdentity,
    "published_unsynced",
  );
  assert.equal(unsynced.ok, true);
  if (!unsynced.ok) {
    return;
  }
  assert.deepEqual(resumeTasks((await store.load("resume-1")) as ImportManifest), [
    { rowIdentity, next: "sync_service" },
  ]);
  const complete = await checkpointImportRow(
    store,
    "resume-1",
    unsynced.value.manifest.manifestVersion,
    rowIdentity,
    "complete",
  );
  assert.equal(complete.ok, true);
  if (complete.ok) {
    assert.deepEqual(resumeTasks((await store.load("resume-1")) as ImportManifest), [
      { rowIdentity, next: "none" },
    ]);
  }
  const illegal = await checkpointImportRow(
    store,
    "resume-1",
    complete.ok ? complete.value.manifest.manifestVersion : 0,
    rowIdentity,
    "publishing",
  );
  assert.equal(illegal.ok, false);
});

test("currentItems classify create, update, unchanged, end, and CAS conflict", () => {
  const row = sampleRow();
  const hash = normalizedCsvRowHash(row);
  const identity = canonicalCsvRowIdentity(row);
  assert.equal(actionFor(row, hash, {}), "create");
  assert.equal(
    actionFor(row, hash, { [identity]: { normalizedHash: hash, recordRevision: 1 } }),
    "unchanged",
  );
  assert.equal(
    actionFor(
      sampleRow({ amountMinor: 13_500 }),
      normalizedCsvRowHash(sampleRow({ amountMinor: 13_500 })),
      {
        [identity]: { normalizedHash: hash, recordRevision: 1 },
      },
    ),
    "update",
  );
  assert.equal(
    actionFor(sampleRow({ state: "ended" }), normalizedCsvRowHash(sampleRow({ state: "ended" })), {
      [identity]: { normalizedHash: hash, recordRevision: 1 },
    }),
    "end",
  );
  assert.equal(
    actionFor(row, hash, { [identity]: { normalizedHash: hash, recordRevision: 2 } }),
    "conflict",
  );
});
