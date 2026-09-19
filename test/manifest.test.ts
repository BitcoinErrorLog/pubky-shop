import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  FileManifestStore,
  PubkyShopError,
  canonicalCsvRowIdentity,
  checkpointImportRow,
  exportCanonicalCsv,
  normalizedCsvRowHash,
  planImport,
  planImportStream,
  replayImport,
  resumeTasks,
} from "../src/index.js";
import { sampleRow } from "./helpers.js";

const evidenceRoot = "/Volumes/vibedrive/vibes-dev/.evidence/phase6/wave2/test-manifests";

async function storeDirectory(): Promise<string> {
  const directory = `${evidenceRoot}/${randomUUID()}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function runLockWorker(directory: string, manifestId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), "test/manifest-lock-worker.mjs"), directory, manifestId],
      {
        cwd: process.cwd(),
        stdio: "ignore",
      },
    );
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
      assert.deepEqual(replay.value.manifest.rows, result.value.rows);
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
    assert.deepEqual(resumeTasks(publishing.value), [{ rowIdentity, next: "reconcile_publish" }]);
    const unsynced = await checkpointImportRow(
      store,
      publishing.value.manifestId,
      publishing.value.manifestVersion,
      rowIdentity,
      "published_unsynced",
    );
    assert.equal(unsynced.ok, true);
    if (!unsynced.ok) {
      return;
    }
    assert.deepEqual(resumeTasks(unsynced.value), [{ rowIdentity, next: "sync_service" }]);
    const complete = await checkpointImportRow(
      store,
      unsynced.value.manifestId,
      unsynced.value.manifestVersion,
      rowIdentity,
      "complete",
    );
    assert.equal(complete.ok, true);
    if (complete.ok) {
      assert.deepEqual(resumeTasks(complete.value), [{ rowIdentity, next: "none" }]);
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
      assert.deepEqual(
        replay.value.conflicts.map((row) => row.reason),
        ["changed_hash"],
      );
      assert.equal(replay.value.manifest.rows[0]?.checkpoint, "planned");
      assert.equal(replay.value.quarantine.quarantineVersion, 1);
    }
    const restarted = await new FileManifestStore(directory).load(planned.value.manifestId);
    assert.equal(restarted?.rows[0]?.checkpoint, "planned");
    const quarantines = await new FileManifestStore(directory).loadReplayQuarantines(
      planned.value.manifestId,
    );
    assert.equal(quarantines.length, 1);
    assert.equal(quarantines[0]?.conflicts[0]?.reason, "changed_hash");
    const persisted = quarantines[0];
    assert.ok(persisted);
    const { quarantineVersion: _quarantineVersion, ...staleAppend } = persisted;
    await assert.rejects(
      () =>
        store.compareAndAppendReplayQuarantine(
          planned.value.manifestId,
          planned.value.manifestVersion,
          0,
          staleAppend,
        ),
      (error: unknown) => error instanceof PubkyShopError && error.code === "manifest_conflict",
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
      let current = planned.value;
      const transitions =
        terminal === "complete"
          ? (["publishing", "published_unsynced", "complete"] as const)
          : ([terminal] as const);
      for (const checkpoint of transitions) {
        const transitioned = await checkpointImportRow(
          store,
          current.manifestId,
          current.manifestVersion,
          rowIdentity,
          checkpoint,
          checkpoint === "failed" ? "transport_error" : undefined,
        );
        assert.equal(transitioned.ok, true);
        if (!transitioned.ok) {
          break;
        }
        current = transitioned.value;
      }
      assert.equal(current.rows[0]?.checkpoint, terminal);

      const replayed = await replayImport(
        store,
        current.manifestId,
        exportCanonicalCsv([sampleRow({ amountMinor: 13_501 })]),
      );
      assert.equal(replayed.ok, true);
      if (replayed.ok) {
        assert.equal(replayed.value.kind, "quarantined");
        assert.equal(replayed.value.manifest.rows[0]?.checkpoint, terminal);
      }

      const restarted = new FileManifestStore(directory);
      const loaded = await restarted.load(current.manifestId);
      assert.equal(loaded?.rows[0]?.checkpoint, terminal);
      const quarantine = await restarted.loadReplayQuarantines(current.manifestId);
      assert.equal(quarantine.length, 1);
      assert.equal(quarantine[0]?.manifestVersion, current.manifestVersion);
      assert.equal(quarantine[0]?.conflicts[0]?.reason, "changed_hash");
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
