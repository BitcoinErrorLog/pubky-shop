import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PubkyShopError,
  canonicalCsvRowIdentity,
  exportCanonicalCsv,
  normalizedCsvRowHash,
} from "../src/index.js";
import {
  FileManifestStore,
  checkpointImportRow,
  planImport,
  planImportStream,
  replayImport,
  streamResumeTasks,
} from "../src/node.js";
import { externalSortLines, minimumExternalSortWorkingSetBytes } from "../src/external-sort.js";
import { sampleRow } from "./helpers.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const lockWorkerPath = fileURLToPath(
  new URL("../../test/manifest-lock-worker.mjs", import.meta.url),
);
const scratchRoot = mkdtempSync(join(tmpdir(), "pubky-shop-"));

async function storeDirectory(): Promise<string> {
  return mkdtempSync(join(scratchRoot, "store-"));
}

test.after(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) {
    values.push(value);
  }
  return values;
}

function streamedCanonicalSource(count: number, changedIndex = -1): AsyncIterable<Uint8Array> {
  const compact = sampleRow({
    title: "x",
    description: "",
    taxonomy: {},
    category: "x",
    condition: "x",
    tags: [],
    options: {},
    media: [],
    shippingOptions: [],
    returnPolicy: {},
    sale: {},
    externalRefs: {},
    extraFields: {},
  });
  const normal = new TextDecoder().decode(exportCanonicalCsv([compact]));
  const changed = new TextDecoder().decode(
    exportCanonicalCsv([{ ...compact, amountMinor: 12_501 }]),
  );
  const boundary = normal.indexOf("\r\n");
  const header = normal.slice(0, boundary + 2);
  const normalRow = normal.slice(boundary + 2);
  const changedRow = changed.slice(changed.indexOf("\r\n") + 2);
  return {
    async *[Symbol.asyncIterator]() {
      yield new TextEncoder().encode(header);
      for (let index = 0; index < count; index += 1) {
        const suffix = String(index).padStart(6, "0");
        const row = (index === changedIndex ? changedRow : normalRow)
          .replaceAll("boots_01", `item_${suffix}`)
          .replaceAll("black_m", `variant_${suffix}`)
          .replaceAll("BOOTS-BLK-M", `SKU_${suffix}`);
        yield new TextEncoder().encode(row);
      }
    },
  };
}

function streamedRows(rows: readonly ReturnType<typeof sampleRow>[]): AsyncIterable<Uint8Array> {
  const rendered = rows.map((row) => new TextDecoder().decode(exportCanonicalCsv([row])));
  const boundary = rendered[0]?.indexOf("\r\n") ?? -1;
  assert.ok(boundary > 0);
  const header = rendered[0]?.slice(0, boundary + 2) ?? "";
  const body = rendered.map((csv) => csv.slice(csv.indexOf("\r\n") + 2));
  return {
    async *[Symbol.asyncIterator]() {
      yield new TextEncoder().encode(header);
      for (const row of body) {
        yield new TextEncoder().encode(row);
      }
    },
  };
}

async function runLockWorker(directory: string, manifestId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [lockWorkerPath, directory, manifestId], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null || code === null) {
        reject(new Error("manifest lock worker did not exit normally"));
      } else {
        resolve(code);
      }
    });
  });
}

test("real file store persists immutable plan, generated ids, and deterministic keys", async () => {
  const directory = await storeDirectory();
  try {
    const bytes = exportCanonicalCsv([
      sampleRow({
        recordUri: "",
        sellerPubky: "",
        listingId: "",
        sourceListingKey: "shopify-product-1",
        recordRevision: null,
      }),
      sampleRow({
        recordUri: "",
        sellerPubky: "",
        listingId: "",
        sourceListingKey: "shopify-product-1",
        recordRevision: null,
        variantId: "black_l",
        sku: "BOOTS-BLK-L",
        options: { color: "black", size: "L" },
      }),
    ]);
    const store = new FileManifestStore(directory);
    const result = await planImport(bytes, {
      store,
      manifestId: "manifest-create-1",
      now: () => new Date("2026-09-19T10:00:00.000Z"),
      generateListingId: () => "generated-listing-1",
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.rows.length, 2);
    assert.deepEqual(
      result.value.rows.map((row) => row.generatedListingId),
      ["generated-listing-1", "generated-listing-1"],
    );
    assert.equal(new Set(result.value.rows.map((row) => row.idempotencyKey)).size, 2);
    assert.ok(result.value.rows.every((row) => row.intendedAction === "create"));

    const restarted = new FileManifestStore(directory);
    const loaded = await restarted.load("manifest-create-1");
    assert.deepEqual(loaded, result.value);
    const replay = await replayImport(restarted, "manifest-create-1", bytes);
    assert.equal(replay.ok, true);
    if (replay.ok) {
      assert.equal(replay.value.kind, "same");
      assert.equal(replay.value.manifest.rowCount, result.value.rows.length);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomic checkpoints and restart semantics never repeat an uncertain publishing leg", async () => {
  const directory = await storeDirectory();
  try {
    const store = new FileManifestStore(directory);
    const planned = await planImport(exportCanonicalCsv([sampleRow()]), {
      store,
      manifestId: "manifest-resume-1",
      now: () => new Date("2026-09-19T10:00:00.000Z"),
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) {
      return;
    }
    const rowIdentity = planned.value.rows[0]?.rowIdentity;
    assert.ok(rowIdentity);
    const publishing = await checkpointImportRow(
      store,
      planned.value.manifestId,
      planned.value.manifestVersion,
      rowIdentity,
      "publishing",
    );
    assert.equal(publishing.ok, true);
    if (!publishing.ok) {
      return;
    }
    assert.deepEqual(await collect(streamResumeTasks(store, planned.value.manifestId)), [
      { rowIdentity, next: "reconcile_publish" },
    ]);
    const unsynced = await checkpointImportRow(
      store,
      publishing.value.manifest.manifestId,
      publishing.value.manifest.manifestVersion,
      rowIdentity,
      "published_unsynced",
    );
    assert.equal(unsynced.ok, true);
    if (!unsynced.ok) {
      return;
    }
    assert.deepEqual(await collect(streamResumeTasks(store, planned.value.manifestId)), [
      { rowIdentity, next: "sync_service" },
    ]);
    const complete = await checkpointImportRow(
      store,
      unsynced.value.manifest.manifestId,
      unsynced.value.manifest.manifestVersion,
      rowIdentity,
      "complete",
    );
    assert.equal(complete.ok, true);
    if (complete.ok) {
      assert.deepEqual(await collect(streamResumeTasks(store, planned.value.manifestId)), [
        { rowIdentity, next: "none" },
      ]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("same identity with a different normalized hash is durably quarantined", async () => {
  const directory = await storeDirectory();
  try {
    const store = new FileManifestStore(directory);
    const original = exportCanonicalCsv([sampleRow()]);
    const planned = await planImport(original, {
      store,
      manifestId: "manifest-quarantine-1",
      now: () => new Date("2026-09-19T10:00:00.000Z"),
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) {
      return;
    }
    const changed = exportCanonicalCsv([sampleRow({ amountMinor: 13_500 })]);
    const replay = await replayImport(store, planned.value.manifestId, changed);
    assert.equal(replay.ok, true);
    if (!replay.ok) {
      return;
    }
    assert.equal(replay.value.kind, "quarantined");
    if (replay.value.kind === "quarantined") {
      const conflicts = await collect(
        store.streamReplayConflicts(planned.value.manifestId, replay.value.quarantine.quarantineId),
      );
      assert.deepEqual(
        conflicts.map((row) => row.reason),
        ["changed_hash"],
      );
      assert.equal((await store.load(planned.value.manifestId))?.rows[0]?.checkpoint, "planned");
      assert.equal(replay.value.quarantine.quarantineVersion, 1);
    }
    const restarted = await new FileManifestStore(directory).load(planned.value.manifestId);
    assert.equal(restarted?.rows[0]?.checkpoint, "planned");
    const quarantines = await new FileManifestStore(directory).loadReplayQuarantines(
      planned.value.manifestId,
    );
    assert.equal(quarantines.length, 1);
    assert.equal(quarantines[0]?.conflictCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("duplicate replay quarantine is idempotent across concurrency and restart", async () => {
  const directory = await storeDirectory();
  try {
    const store = new FileManifestStore(directory);
    const planned = await planImport(exportCanonicalCsv([sampleRow()]), {
      store,
      manifestId: "quarantine-idempotent",
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) {
      return;
    }
    const firstChanged = exportCanonicalCsv([sampleRow({ amountMinor: 13_001 })]);
    const concurrent = await Promise.all([
      replayImport(store, planned.value.manifestId, firstChanged),
      replayImport(store, planned.value.manifestId, firstChanged),
    ]);
    assert.ok(concurrent.every((result) => result.ok));
    const ids = concurrent.flatMap((result) =>
      result.ok && result.value.kind === "quarantined"
        ? [result.value.quarantine.quarantineId]
        : [],
    );
    assert.equal(new Set(ids).size, 1);
    assert.equal((await store.scanReplayQuarantines(planned.value.manifestId)).recordCount, 1);

    const restarted = new FileManifestStore(directory);
    const restartDuplicate = await replayImport(restarted, planned.value.manifestId, firstChanged);
    assert.equal(restartDuplicate.ok, true);
    if (restartDuplicate.ok && restartDuplicate.value.kind === "quarantined") {
      assert.equal(restartDuplicate.value.quarantine.quarantineId, ids[0]);
      assert.equal(restartDuplicate.value.quarantine.quarantineVersion, 1);
    }
    const unique = await replayImport(
      restarted,
      planned.value.manifestId,
      exportCanonicalCsv([sampleRow({ amountMinor: 13_002 })]),
    );
    assert.equal(unique.ok, true);
    if (unique.ok && unique.value.kind === "quarantined") {
      assert.equal(unique.value.quarantine.quarantineVersion, 2);
    }
    assert.deepEqual(
      (await collect(restarted.streamReplayQuarantines(planned.value.manifestId))).map(
        (record) => record.quarantineVersion,
      ),
      [1, 2],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("quarantine reader stays bounded and truncated tails require explicit repair", async (t) => {
  const directory = await storeDirectory();
  try {
    const store = new FileManifestStore(directory);
    const planned = await planImport(exportCanonicalCsv([sampleRow()]), {
      store,
      manifestId: "quarantine-bounded",
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) {
      return;
    }
    for (let index = 0; index < 40; index += 1) {
      const replayed = await replayImport(
        store,
        planned.value.manifestId,
        exportCanonicalCsv([sampleRow({ amountMinor: 20_000 + index })]),
        { now: () => new Date(1_800_000_000_000 + index * 1000) },
      );
      assert.equal(replayed.ok, true);
    }
    const scan = await store.scanReplayQuarantines(planned.value.manifestId);
    assert.equal(scan.recordCount, 40);
    assert.equal(scan.lastVersion, 40);
    assert.ok(scan.peakBufferedBytes <= 128 * 1024);
    t.diagnostic(
      `records=${scan.recordCount} lastVersion=${scan.lastVersion} readerPeak=${scan.peakBufferedBytes}`,
    );

    const path = join(directory, "quarantine-bounded.replay-quarantine.jsonl");
    const before = await readFile(path);
    await truncate(path, before.byteLength - 10);
    await assert.rejects(
      () => store.scanReplayQuarantines(planned.value.manifestId),
      (error: unknown) => error instanceof PubkyShopError && error.code === "manifest_store_error",
    );
    assert.equal(
      await store.repairReplayQuarantineTail(
        planned.value.manifestId,
        planned.value.manifestVersion,
      ),
      true,
    );
    const repaired = await store.scanReplayQuarantines(planned.value.manifestId);
    assert.equal(repaired.recordCount, 39);
    assert.equal(repaired.lastVersion, 39);
    assert.equal(
      (await readdir(directory)).filter(
        (name) => !name.startsWith("._") && name.startsWith("quarantine-bounded.replay-conflicts."),
      ).length,
      39,
    );

    const compacted = await store.compactReplayQuarantines(
      planned.value.manifestId,
      planned.value.manifestVersion,
      new Date(1_800_000_020_000).toISOString(),
    );
    assert.equal(compacted.removed, 20);
    assert.equal(compacted.retained, 19);
    assert.equal((await store.scanReplayQuarantines(planned.value.manifestId)).recordCount, 19);
    assert.equal(
      (await readdir(directory)).filter(
        (name) => !name.startsWith("._") && name.startsWith("quarantine-bounded.replay-conflicts."),
      ).length,
      19,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("D6.19 discard atomically removes a manifest and retained replay history", async () => {
  const directory = await storeDirectory();
  try {
    const store = new FileManifestStore(directory);
    const planned = await planImport(exportCanonicalCsv([sampleRow()]), {
      store,
      manifestId: "discard-retained-history",
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) {
      return;
    }
    const replayed = await replayImport(
      store,
      planned.value.manifestId,
      exportCanonicalCsv([sampleRow({ amountMinor: 13_333 })]),
    );
    assert.equal(replayed.ok, true);
    assert.equal(
      await store.discardManifest(planned.value.manifestId, planned.value.manifestVersion),
      true,
    );
    assert.equal(await store.loadSummary(planned.value.manifestId), null);
    assert.deepEqual(
      (await readdir(directory)).filter((name) => !name.startsWith("._")),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("changed replay never rewrites complete, conflict, or failed checkpoint history", async () => {
  for (const terminal of ["complete", "conflict", "failed"] as const) {
    const directory = await storeDirectory();
    try {
      const store = new FileManifestStore(directory);
      const planned = await planImport(exportCanonicalCsv([sampleRow()]), {
        store,
        manifestId: `terminal-${terminal}`,
      });
      assert.equal(planned.ok, true);
      if (!planned.ok) {
        continue;
      }
      const rowIdentity = planned.value.rows[0]?.rowIdentity;
      assert.ok(rowIdentity);
      let currentVersion = planned.value.manifestVersion;
      const transitions =
        terminal === "complete"
          ? (["publishing", "published_unsynced", "complete"] as const)
          : ([terminal] as const);
      for (const checkpoint of transitions) {
        const transitioned = await checkpointImportRow(
          store,
          planned.value.manifestId,
          currentVersion,
          rowIdentity,
          checkpoint,
          checkpoint === "failed" ? "transport_error" : undefined,
        );
        assert.equal(transitioned.ok, true);
        if (!transitioned.ok) {
          break;
        }
        currentVersion = transitioned.value.manifest.manifestVersion;
      }
      assert.equal((await store.load(planned.value.manifestId))?.rows[0]?.checkpoint, terminal);

      const replayed = await replayImport(
        store,
        planned.value.manifestId,
        exportCanonicalCsv([sampleRow({ amountMinor: 13_501 })]),
      );
      assert.equal(replayed.ok, true);
      if (replayed.ok) {
        assert.equal(replayed.value.kind, "quarantined");
        assert.equal((await store.load(planned.value.manifestId))?.rows[0]?.checkpoint, terminal);
      }

      const restarted = new FileManifestStore(directory);
      const loaded = await restarted.load(planned.value.manifestId);
      assert.equal(loaded?.rows[0]?.checkpoint, terminal);
      const quarantine = await restarted.loadReplayQuarantines(planned.value.manifestId);
      assert.equal(quarantine.length, 1);
      assert.equal(quarantine[0]?.manifestVersion, currentVersion);
      assert.equal(quarantine[0]?.conflictCount, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("late malformed stream leaves no committed manifest or planning spool", async () => {
  const directory = await storeDirectory();
  try {
    const valid = exportCanonicalCsv([sampleRow()]);
    async function* lateMalformed(): AsyncGenerator<Uint8Array> {
      yield valid;
      yield new TextEncoder().encode('"unterminated');
    }
    const store = new FileManifestStore(directory);
    const result = await planImportStream(lateMalformed(), {
      store,
      manifestId: "late-malformed",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "malformed_csv");
    }
    assert.equal(await store.loadSummary("late-malformed"), null);
    assert.deepEqual(await readdir(directory), []);
    assert.equal("publish" in store, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("streamRows validates the complete trailing count before yielding", async () => {
  const directory = await storeDirectory();
  try {
    const store = new FileManifestStore(directory);
    const planned = await planImport(
      exportCanonicalCsv([
        sampleRow(),
        sampleRow({
          recordUri: sampleRow().recordUri.replace("boots_01", "second"),
          listingId: "second",
          variantId: "second_variant",
          sku: "SECOND",
        }),
      ]),
      { store, manifestId: "verified-stream" },
    );
    assert.equal(planned.ok, true);
    const path = join(directory, "verified-stream.manifest.jsonl");
    const bytes = await readFile(path);
    const finalLineStart = bytes.lastIndexOf(0x0a, bytes.length - 2) + 1;
    await truncate(path, finalLineStart);
    const yielded: unknown[] = [];
    await assert.rejects(async () => {
      for await (const row of store.streamRows("verified-stream")) {
        yielded.push(row);
      }
    });
    assert.deepEqual(yielded, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup reaps only old dead-owner planning and temporary artifacts", async () => {
  const directory = await storeDirectory();
  const deadPid = 2_147_483_646;
  const oldPlanning = `.abandoned.${deadPid}.00000000-0000-4000-8000-000000000001.planning`;
  const oldTemporary = `abandoned.manifest.jsonl.${deadPid}.00000000-0000-4000-8000-000000000002.tmp`;
  const activePlanning = `.active.${process.pid}.00000000-0000-4000-8000-000000000003.planning`;
  const youngPlanning = `.young.${deadPid}.00000000-0000-4000-8000-000000000004.planning`;
  try {
    await mkdir(join(directory, oldPlanning), { mode: 0o700 });
    await writeFile(join(directory, oldTemporary), "partial", { mode: 0o600 });
    await mkdir(join(directory, activePlanning), { mode: 0o700 });
    await mkdir(join(directory, youngPlanning), { mode: 0o700 });
    const old = new Date(Date.now() - 120_000);
    await utimes(join(directory, oldPlanning), old, old);
    await utimes(join(directory, oldTemporary), old, old);
    const store = new FileManifestStore(directory, { recoveryAgeMs: 60_000 });
    assert.equal(await store.loadSummary("reaper-trigger"), null);
    const remaining = (await readdir(directory)).filter((name) => !name.startsWith("._")).sort();
    assert.deepEqual(remaining, [activePlanning, youngPlanning].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stream planner accepts a source over 64 MiB with asserted bounded buffers", async (t) => {
  const directory = await storeDirectory();
  try {
    const template = exportCanonicalCsv([
      sampleRow({
        recordUri: "",
        sellerPubky: "",
        listingId: "",
        sourceListingKey: "source-template",
        recordRevision: null,
        variantId: "variant_template",
        sku: "SKU_TEMPLATE",
        title: "large stream row",
        description: "x".repeat(70 * 1024),
      }),
    ]);
    const rendered = new TextDecoder().decode(template);
    const boundary = rendered.indexOf("\r\n");
    assert.ok(boundary > 0);
    const header = rendered.slice(0, boundary + 2);
    const templateRow = rendered.slice(boundary + 2);
    const rowBytes = Buffer.byteLength(templateRow);
    const count = Math.ceil((65 * 1024 * 1024 - Buffer.byteLength(header)) / rowBytes) + 1;
    let emittedBytes = 0;
    async function* largeSource(): AsyncGenerator<Uint8Array> {
      const encodedHeader = new TextEncoder().encode(header);
      emittedBytes += encodedHeader.byteLength;
      yield encodedHeader;
      for (let index = 0; index < count; index += 1) {
        const suffix = String(index).padStart(6, "0");
        const row = templateRow
          .replace("source-template", `source-${suffix}`)
          .replace("variant_template", `variant_${suffix}`)
          .replace("SKU_TEMPLATE", `SKU_${suffix}`);
        const bytes = new TextEncoder().encode(row);
        emittedBytes += bytes.byteLength;
        yield bytes;
      }
    }
    const result = await planImportStream(largeSource(), {
      store: new FileManifestStore(directory),
      manifestId: "over-64-mib",
      now: () => new Date("2026-09-19T10:00:00.000Z"),
      generateListingId: () => randomUUID(),
      limits: {
        maxCellBytes: 128 * 1024,
        maxRowBytes: 256 * 1024,
        maxWorkingSetBytes: 4 * 1024 * 1024,
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.value.resourceUsage.sourceBytes > 64n * 1024n * 1024n);
      assert.equal(result.value.resourceUsage.sourceBytes, BigInt(emittedBytes));
      assert.equal(result.value.manifest.rowCount, count);
      assert.ok(
        result.value.resourceUsage.peakParserBufferedBytes <=
          result.value.resourceUsage.maxWorkingSetBytes,
      );
      assert.ok(
        result.value.resourceUsage.peakPlannerBufferedBytes <=
          result.value.resourceUsage.maxWorkingSetBytes,
      );
      t.diagnostic(
        `sourceBytes=${result.value.resourceUsage.sourceBytes} rows=${result.value.resourceUsage.rowCount} parserPeak=${result.value.resourceUsage.peakParserBufferedBytes} plannerPeak=${result.value.resourceUsage.peakPlannerBufferedBytes} bound=${result.value.resourceUsage.maxWorkingSetBytes}`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("100001-row manifest checkpoints resumes and replays without materialization", async (t) => {
  const directory = await storeDirectory();
  try {
    const store = new FileManifestStore(directory);
    const planned = await planImportStream(streamedCanonicalSource(100_001), {
      store,
      manifestId: "large-operable",
      now: () => new Date("2026-09-19T10:00:00.000Z"),
      limits: { maxWorkingSetBytes: 4 * 1024 * 1024 },
      maxSortOpenFiles: 4,
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) {
      return;
    }
    assert.equal(planned.value.manifest.rowCount, 100_001);
    await assert.rejects(
      () => store.load("large-operable"),
      (error: unknown) => error instanceof PubkyShopError && error.code === "limit_exceeded",
    );

    let firstRow:
      | {
          readonly rowIdentity: string;
        }
      | undefined;
    for await (const row of store.streamRows("large-operable")) {
      firstRow = row;
      break;
    }
    assert.ok(firstRow);
    const checkpoint = await checkpointImportRow(
      store,
      "large-operable",
      1,
      firstRow.rowIdentity,
      "publishing",
    );
    assert.equal(checkpoint.ok, true);
    if (!checkpoint.ok) {
      return;
    }
    assert.equal(checkpoint.value.manifest.manifestVersion, 2);

    let resumeCount = 0;
    let reconcileCount = 0;
    for await (const task of streamResumeTasks(store, "large-operable")) {
      resumeCount += 1;
      if (task.next === "reconcile_publish") {
        reconcileCount += 1;
      }
    }
    assert.equal(resumeCount, 100_001);
    assert.equal(reconcileCount, 1);

    const same = await replayImport(store, "large-operable", streamedCanonicalSource(100_001), {
      limits: { maxWorkingSetBytes: 4 * 1024 * 1024 },
      maxSortOpenFiles: 4,
    });
    assert.equal(same.ok, true);
    if (!same.ok) {
      return;
    }
    assert.equal(same.value.kind, "same");
    assert.equal(same.value.resourceUsage.rowCount, 100_001);
    assert.ok(
      same.value.resourceUsage.peakPlannerMetadataBytes <=
        same.value.resourceUsage.maxWorkingSetBytes,
    );
    assert.equal(same.value.resourceUsage.maxPlannerOpenFiles, 4);
    assert.ok(same.value.resourceUsage.peakPlannerOpenFiles <= 4);
    assert.ok(
      same.value.resourceUsage.peakPlannerBufferedBytes <=
        same.value.resourceUsage.maxWorkingSetBytes,
    );

    const changed = await replayImport(
      store,
      "large-operable",
      streamedCanonicalSource(100_001, 50_000),
      {
        limits: { maxWorkingSetBytes: 4 * 1024 * 1024 },
        maxSortOpenFiles: 4,
        now: () => new Date("2026-09-19T11:00:00.000Z"),
      },
    );
    assert.equal(changed.ok, true);
    if (!changed.ok || changed.value.kind !== "quarantined") {
      return;
    }
    assert.equal(changed.value.conflictCount, 1);
    assert.equal(changed.value.quarantine.manifestVersion, 2);
    assert.ok(
      changed.value.resourceUsage.peakPlannerMetadataBytes <=
        changed.value.resourceUsage.maxWorkingSetBytes,
    );
    assert.equal(changed.value.resourceUsage.maxPlannerOpenFiles, 4);
    assert.ok(changed.value.resourceUsage.peakPlannerOpenFiles <= 4);
    assert.ok(
      changed.value.resourceUsage.peakPlannerBufferedBytes <=
        changed.value.resourceUsage.maxWorkingSetBytes,
    );
    assert.equal(
      (
        await collect(
          store.streamReplayConflicts("large-operable", changed.value.quarantine.quarantineId),
        )
      )[0]?.reason,
      "changed_hash",
    );
    t.diagnostic(
      `rows=${resumeCount} checkpointVersion=${checkpoint.value.manifest.manifestVersion} replayParserPeak=${same.value.resourceUsage.peakParserBufferedBytes} replayPlannerPeak=${same.value.resourceUsage.peakPlannerBufferedBytes} replayMetadataPeak=${same.value.resourceUsage.peakPlannerMetadataBytes} replayFdPeak=${same.value.resourceUsage.peakPlannerOpenFiles} bound=${same.value.resourceUsage.maxWorkingSetBytes}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stream planning produces byte-identical deterministic manifests", async () => {
  const left = await storeDirectory();
  const right = await storeDirectory();
  try {
    const bytes = exportCanonicalCsv([
      sampleRow({
        recordUri: "",
        sellerPubky: "",
        listingId: "",
        sourceListingKey: "deterministic-source",
        recordRevision: null,
      }),
    ]);
    const options = {
      manifestId: "deterministic-manifest",
      now: () => new Date("2026-09-19T10:00:00.000Z"),
      generateListingId: () => "deterministic-listing",
    };
    const first = await planImportStream([bytes], {
      store: new FileManifestStore(left),
      ...options,
    });
    const second = await planImportStream([bytes], {
      store: new FileManifestStore(right),
      ...options,
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    const filename = "deterministic-manifest.manifest.jsonl";
    assert.deepEqual(await readFile(join(left, filename)), await readFile(join(right, filename)));
  } finally {
    await rm(left, { recursive: true, force: true });
    await rm(right, { recursive: true, force: true });
  }
});

test("file-backed compare-and-swap permits only one concurrent checkpoint winner", async () => {
  const directory = await storeDirectory();
  try {
    const store = new FileManifestStore(directory);
    const planned = await planImport(exportCanonicalCsv([sampleRow()]), {
      store,
      manifestId: "manifest-cas-1",
      now: () => new Date("2026-09-19T10:00:00.000Z"),
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) {
      return;
    }
    const rowIdentity = planned.value.rows[0]?.rowIdentity;
    assert.ok(rowIdentity);
    const attempts = await Promise.all([
      checkpointImportRow(
        store,
        planned.value.manifestId,
        planned.value.manifestVersion,
        rowIdentity,
        "publishing",
      ),
      checkpointImportRow(
        store,
        planned.value.manifestId,
        planned.value.manifestVersion,
        rowIdentity,
        "publishing",
      ),
    ]);
    assert.equal(attempts.filter((result) => result.ok).length, 1);
    const loser = attempts.find((result) => !result.ok);
    assert.ok(loser);
    if (loser && !loser.ok) {
      assert.equal(loser.error.code, "manifest_conflict");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inter-process compare-and-swap permits exactly one host process winner", async () => {
  const directory = await storeDirectory();
  try {
    const store = new FileManifestStore(directory);
    const planned = await planImport(exportCanonicalCsv([sampleRow()]), {
      store,
      manifestId: "manifest-process-cas",
    });
    assert.equal(planned.ok, true);
    const exitCodes = await Promise.all([
      runLockWorker(directory, "manifest-process-cas"),
      runLockWorker(directory, "manifest-process-cas"),
    ]);
    assert.deepEqual(exitCodes.sort(), [0, 2]);
    const loaded = await store.load("manifest-process-cas");
    assert.equal(loaded?.manifestVersion, 2);
    assert.equal(loaded?.rows[0]?.checkpoint, "publishing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed or truncated CSV creates no manifest and has no publication surface", async () => {
  const directory = await storeDirectory();
  try {
    const store = new FileManifestStore(directory);
    const malformed = new TextEncoder().encode('"record_uri","listing_id"\r\n"truncated');
    const result = await planImport(malformed, {
      store,
      manifestId: "must-not-exist",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.error.code === "malformed_csv" || result.error.code === "invalid_csv_header",
      );
    }
    assert.deepEqual(await readdir(directory), []);
    assert.equal(
      "publish" in store,
      false,
      "Wave 2 planner/store expose no remote publication operation",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safe errors never serialize source cells or store exception text", async () => {
  const directory = await storeDirectory();
  try {
    const secretCell = "attacker-secret-cell";
    const bytes = exportCanonicalCsv([sampleRow({ title: secretCell })]);
    const store = new FileManifestStore(directory);
    const first = await planImport(bytes, {
      store,
      manifestId: "manifest-redaction-1",
    });
    assert.equal(first.ok, true);
    const second = await planImport(bytes, {
      store,
      manifestId: "manifest-redaction-1",
    });
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.error.code, "manifest_conflict");
      assert.doesNotMatch(JSON.stringify(second.error), new RegExp(secretCell));
      assert.ok(second.error instanceof PubkyShopError);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable store recovers a dead-process lock without weakening compare-and-swap", async () => {
  const directory = await storeDirectory();
  try {
    await writeFile(`${directory}/manifest-stale-lock.lock`, "2147483646\n", {
      mode: 0o600,
    });
    const store = new FileManifestStore(directory, { lockTimeoutMs: 100 });
    const planned = await planImport(exportCanonicalCsv([sampleRow()]), {
      store,
      manifestId: "manifest-stale-lock",
    });
    assert.equal(planned.ok, true);
    assert.deepEqual((await readdir(directory)).filter((name) => !name.startsWith("._")).sort(), [
      "manifest-stale-lock.manifest.jsonl",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generated listing ids are persisted once and collisions fail before manifest creation", async () => {
  const directory = await storeDirectory();
  try {
    const store = new FileManifestStore(directory);
    const bytes = exportCanonicalCsv([
      sampleRow({
        recordUri: "",
        sellerPubky: "",
        listingId: "",
        sourceListingKey: "source-one",
        recordRevision: null,
      }),
      sampleRow({
        recordUri: "",
        sellerPubky: "",
        listingId: "",
        sourceListingKey: "source-two",
        recordRevision: null,
        variantId: "other",
        sku: "OTHER-SKU",
      }),
    ]);
    const result = await planImport(bytes, {
      store,
      manifestId: "manifest-id-collision",
      generateListingId: () => "same-generated-id",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "invalid_identity");
    }
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("streaming identity seam rejects every cross-row conflict before commit", async () => {
  const cases = [
    {
      name: "duplicate-row",
      code: "duplicate_row",
      rows: [sampleRow(), sampleRow()],
    },
    {
      name: "duplicate-variant",
      code: "duplicate_variant_id",
      rows: [sampleRow(), sampleRow({ variantQuantity: 4, sku: "DIFFERENT-SKU" })],
    },
    {
      name: "ambiguous-sku",
      code: "ambiguous_sku",
      rows: [
        sampleRow(),
        sampleRow({
          recordUri: sampleRow().recordUri.replace("boots_01", "other"),
          listingId: "other",
          variantId: "other_variant",
        }),
      ],
    },
    {
      name: "listing-facts",
      code: "conflicting_listing_fields",
      rows: [
        sampleRow(),
        sampleRow({ variantId: "second_variant", sku: "SECOND", title: "changed title" }),
      ],
    },
  ] as const;
  for (const fixture of cases) {
    const directory = await storeDirectory();
    try {
      const result = await planImportStream(streamedRows(fixture.rows), {
        store: new FileManifestStore(directory),
        manifestId: `identity-${fixture.name}`,
      });
      assert.equal(result.ok, false, fixture.name);
      if (!result.ok) {
        assert.equal(result.error.code, fixture.code, fixture.name);
      }
      assert.deepEqual(await readdir(directory), [], fixture.name);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("canonical spool and decoder share one legal row limit", async () => {
  const directory = await storeDirectory();
  try {
    const row = sampleRow({
      description: "\u0001".repeat(8_000),
      title: '"quoted" legal row',
    });
    const result = await planImportStream(streamedRows([row]), {
      store: new FileManifestStore(directory),
      manifestId: "spool-limit-unified",
      limits: {
        maxCellBytes: 64 * 1024,
        maxRowBytes: 128 * 1024,
        maxWorkingSetBytes: 1024 * 1024,
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.manifest.rowCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("planning persists create, update, end, unchanged, and revision-conflict intent", async () => {
  const directory = await storeDirectory();
  try {
    const rowFor = (listingId: string, state = "active") =>
      sampleRow({
        recordUri: sampleRow().recordUri.replace("boots_01", listingId),
        listingId,
        variantId: `${listingId}_variant`,
        sku: `${listingId.toUpperCase()}-SKU`,
        state,
      });
    const unchanged = rowFor("unchanged");
    const update = rowFor("update");
    const ended = rowFor("ended", "ended");
    const conflict = rowFor("conflict");
    const created = rowFor("created");
    const result = await planImport(
      exportCanonicalCsv([unchanged, update, ended, conflict, created]),
      {
        store: new FileManifestStore(directory),
        manifestId: "manifest-actions",
        currentItems: {
          [canonicalCsvRowIdentity(unchanged)]: {
            normalizedHash: normalizedCsvRowHash(unchanged),
            recordRevision: 1,
          },
          [canonicalCsvRowIdentity(update)]: {
            normalizedHash: "0".repeat(64),
            recordRevision: 1,
          },
          [canonicalCsvRowIdentity(ended)]: {
            normalizedHash: "1".repeat(64),
            recordRevision: 1,
          },
          [canonicalCsvRowIdentity(conflict)]: {
            normalizedHash: "2".repeat(64),
            recordRevision: 2,
          },
        },
      },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual([...result.value.rows.map((row) => row.intendedAction)].sort(), [
        "conflict",
        "create",
        "end",
        "unchanged",
        "update",
      ]);
      assert.equal(
        result.value.rows.find((row) => row.intendedAction === "conflict")?.checkpoint,
        "conflict",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manifest store refuses a symlinked storage directory", async () => {
  const directory = await storeDirectory();
  const linkedDirectory = `${directory}-link`;
  try {
    await symlink(directory, linkedDirectory, "dir");
    const store = new FileManifestStore(linkedDirectory);
    await assert.rejects(
      () => store.load("manifest-symlink-directory"),
      (error: unknown) => error instanceof PubkyShopError && error.code === "manifest_store_error",
    );
  } finally {
    await unlink(linkedDirectory).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("manifest store canonicalizes a symlinked parent but refuses final file symlinks", async () => {
  const parent = await storeDirectory();
  const linkedParent = `${parent}-parent-link`;
  const outside = `${parent}-outside`;
  try {
    await symlink(parent, linkedParent, "dir");
    const configured = join(linkedParent, "store");
    const store = new FileManifestStore(configured);
    const planned = await planImport(exportCanonicalCsv([sampleRow()]), {
      store,
      manifestId: "symlink-parent",
    });
    assert.equal(planned.ok, true);
    assert.equal((await store.loadSummary("symlink-parent"))?.rowCount, 1);

    await writeFile(outside, "outside-sentinel", { mode: 0o600 });
    await symlink(outside, join(parent, "store", "final-link.manifest.jsonl"));
    await assert.rejects(
      () => store.loadSummary("final-link"),
      (error: unknown) => error instanceof PubkyShopError && error.code === "manifest_store_error",
    );
    assert.equal(await readFile(outside, "utf8"), "outside-sentinel");
  } finally {
    await unlink(linkedParent).catch(() => undefined);
    await unlink(outside).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
});

test("root substitution at the check-use seam fails closed without redirected writes", async () => {
  const directory = await storeDirectory();
  const moved = `${directory}-moved`;
  let armed = false;
  try {
    const store = new FileManifestStore(directory, {
      async filesystemCheckpoint(operation) {
        if (armed && operation === "manifest-read-summary") {
          armed = false;
          await rename(directory, moved);
          await mkdir(directory, { mode: 0o700 });
        }
      },
    });
    assert.equal(await store.loadSummary("root-substitution"), null);
    armed = true;
    await assert.rejects(
      () => store.loadSummary("root-substitution"),
      (error: unknown) => error instanceof PubkyShopError && error.code === "manifest_store_error",
    );
    assert.deepEqual(await readdir(directory), []);
    assert.deepEqual(await readdir(moved), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});

test("manifest ids cannot traverse the host-supplied store directory", async () => {
  const directory = await storeDirectory();
  try {
    const store = new FileManifestStore(directory);
    const planned = await planImport(exportCanonicalCsv([sampleRow()]), {
      store,
      manifestId: "manifest-safe-id",
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) {
      return;
    }
    for (const manifestId of ["../escape", "/absolute", "nested/name"]) {
      await assert.rejects(
        () => store.load(manifestId),
        (error: unknown) =>
          error instanceof PubkyShopError && error.code === "manifest_store_error",
      );
      await assert.rejects(
        () =>
          store.compareAndSwap(manifestId, 1, (manifest) => ({
            ...manifest,
            manifestVersion: 2,
          })),
        (error: unknown) =>
          error instanceof PubkyShopError && error.code === "manifest_store_error",
      );
      await assert.rejects(
        () => store.create({ ...planned.value, manifestId }),
        (error: unknown) =>
          error instanceof PubkyShopError && error.code === "manifest_store_error",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("external sort keeps run metadata and descriptors bounded across many generations", async (t) => {
  const directory = await storeDirectory();
  try {
    const input = join(directory, "many.input");
    const values = Array.from({ length: 100_000 }, (_, index) =>
      String(100_000 - index).padStart(8, "0"),
    );
    await writeFile(input, `${values.join("\n")}\n`, { mode: 0o600 });
    const budget = minimumExternalSortWorkingSetBytes(32, directory, "many-runs") + 1024;
    const sorted = await externalSortLines(input, directory, "many-runs", {
      maxLineBytes: 32,
      maxWorkingSetBytes: budget,
      maxOpenFiles: 4,
    });
    assert.ok(sorted.initialRunCount > 32);
    assert.ok(sorted.mergePasses >= 3);
    assert.ok(sorted.peakMetadataBytes <= 64 * 1024);
    assert.ok(sorted.peakOpenFiles <= 4);
    assert.ok(sorted.peakBufferedBytes <= budget);
    assert.equal(await readFile(sorted.path, "utf8"), `${[...values].sort().join("\n")}\n`);
    t.diagnostic(
      `runs=${sorted.initialRunCount} passes=${sorted.mergePasses} fanIn=${sorted.mergeFanIn} metadataPeak=${sorted.peakMetadataBytes} fdPeak=${sorted.peakOpenFiles} workingPeak=${sorted.peakBufferedBytes} bound=${budget}`,
    );

    const failingInput = join(directory, "failure.input");
    await writeFile(failingInput, `${values.join("\n")}\n`, { mode: 0o600 });
    await assert.rejects(
      () =>
        externalSortLines(
          failingInput,
          directory,
          "failure-runs",
          {
            maxLineBytes: 32,
            maxWorkingSetBytes:
              minimumExternalSortWorkingSetBytes(32, directory, "failure-runs") + 1024,
            maxOpenFiles: 4,
          },
          {
            onMergeGroup(progress) {
              if (progress.generation === 1 && progress.group === 1) {
                throw new Error("deterministic mid-merge failure");
              }
            },
          },
        ),
      /deterministic mid-merge failure/,
    );
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.includes("failure-runs")),
      [],
    );
    assert.equal(await readFile(failingInput, "utf8"), `${values.join("\n")}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("external sort accepts its exact two-way budget and rejects one byte below", async () => {
  const directory = await storeDirectory();
  try {
    const input = join(directory, "minimum.input");
    await writeFile(input, "b\na\n", { mode: 0o600 });
    const minimum = minimumExternalSortWorkingSetBytes(1, directory, "minimum");
    await assert.rejects(
      () =>
        externalSortLines(input, directory, "below", {
          maxLineBytes: 1,
          maxWorkingSetBytes: minimumExternalSortWorkingSetBytes(1, directory, "below") - 1,
          maxOpenFiles: 3,
        }),
      (error: unknown) => error instanceof PubkyShopError && error.code === "invalid_configuration",
    );
    const result = await externalSortLines(input, directory, "minimum", {
      maxLineBytes: 1,
      maxWorkingSetBytes: minimum,
      maxOpenFiles: 3,
    });
    assert.equal(await readFile(result.path, "utf8"), "a\nb\n");
    assert.equal(result.mergeFanIn, 2);
    assert.ok(result.peakBufferedBytes <= minimum);
    assert.ok(result.peakOpenFiles <= 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
