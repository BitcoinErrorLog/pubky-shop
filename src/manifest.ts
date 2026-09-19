import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  type CanonicalCsvRow,
  type ParsedCanonicalCsv,
  canonicalCsvRowIdentity,
  listingIdentity,
  normalizedCsvRowHash,
  parseCanonicalCsv,
} from "./csv.js";
import { ERROR_CODES, type ErrorCode, PubkyShopError, type SdkResult, err, ok } from "./errors.js";
import { type JsonObject, type JsonValue, encodeCanonicalJson, parseBoundedJson } from "./json.js";

export const IMPORT_PARSER_VERSION = "pubky-shop-csv-rfc4180-v1";
export const IMPORT_MAPPING_VERSION = "pubky-shop-canonical-v1";
export const IMPORT_SCHEMA_VERSION = "pubky-shop-import-manifest-v1";

export const IMPORT_ACTIONS = ["create", "update", "end", "unchanged", "conflict"] as const;
export type ImportAction = (typeof IMPORT_ACTIONS)[number];

export const IMPORT_CHECKPOINTS = [
  "planned",
  "publishing",
  "published_unsynced",
  "complete",
  "conflict",
  "failed",
] as const;
export type ImportCheckpoint = (typeof IMPORT_CHECKPOINTS)[number];

export interface PlannedImportRow {
  readonly sourceRow: number;
  readonly sourceIdentity: string;
  readonly rowIdentity: string;
  readonly normalizedHash: string;
  readonly listingIdentity: string;
  readonly listingId: string;
  readonly generatedListingId: string | null;
  readonly variantId: string;
  readonly sku: string;
  readonly intendedAction: ImportAction;
  readonly idempotencyKey: string;
  readonly checkpoint: ImportCheckpoint;
  readonly failureCode?: ErrorCode;
}

export interface ImportManifest {
  readonly schemaVersion: 1;
  readonly kind: "pubky-shop-import-manifest";
  readonly manifestId: string;
  readonly manifestVersion: number;
  readonly sourceSha256: string;
  readonly parserVersion: string;
  readonly mappingVersion: string;
  readonly recordSchemaVersion: string;
  readonly createdAt: string;
  readonly rows: readonly PlannedImportRow[];
}

export interface CurrentImportItem {
  readonly normalizedHash: string;
  readonly recordRevision: number;
}

export interface PlanImportOptions {
  readonly store: ManifestStore;
  readonly manifestId?: string;
  readonly now?: () => Date;
  readonly generateListingId?: () => string;
  readonly currentItems?: Readonly<Record<string, CurrentImportItem>>;
}

export interface ReplayConflictRow {
  readonly rowIdentity: string;
  readonly sourceRow: number;
  readonly reason: "changed_hash" | "missing_from_replay" | "not_in_manifest";
}

export type ImportReplayResult =
  | { readonly kind: "same"; readonly manifest: ImportManifest }
  | {
      readonly kind: "quarantined";
      readonly manifest: ImportManifest;
      readonly conflicts: readonly ReplayConflictRow[];
    };

export interface ResumeTask {
  readonly rowIdentity: string;
  readonly next: "publish" | "reconcile_publish" | "sync_service" | "none";
}

export interface ManifestStore {
  create(manifest: ImportManifest): Promise<void>;
  load(manifestId: string): Promise<ImportManifest | null>;
  compareAndSwap(
    manifestId: string,
    expectedVersion: number,
    update: (manifest: ImportManifest) => ImportManifest,
  ): Promise<ImportManifest>;
}

const manifestIdPattern = /^[A-Za-z0-9_.-]{1,128}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const listingIdPattern = /^[A-Za-z0-9_.-]{1,128}$/;
const idempotencyKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const actions = new Set<string>(IMPORT_ACTIONS);
const checkpoints = new Set<string>(IMPORT_CHECKPOINTS);
const errorCodes = new Set<string>(ERROR_CODES);

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

function validManifestId(value: string): boolean {
  return manifestIdPattern.test(value);
}

function cloneManifest(manifest: ImportManifest): ImportManifest {
  return structuredClone(manifest);
}

function manifestJson(manifest: ImportManifest): JsonObject {
  return structuredClone(manifest) as unknown as JsonObject;
}

function parseManifestValue(value: JsonValue): ImportManifest {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "kind",
      "manifestId",
      "manifestVersion",
      "sourceSha256",
      "parserVersion",
      "mappingVersion",
      "recordSchemaVersion",
      "createdAt",
      "rows",
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "pubky-shop-import-manifest" ||
    typeof value.manifestId !== "string" ||
    !validManifestId(value.manifestId) ||
    typeof value.manifestVersion !== "number" ||
    !Number.isSafeInteger(value.manifestVersion) ||
    value.manifestVersion < 1 ||
    typeof value.sourceSha256 !== "string" ||
    !hashPattern.test(value.sourceSha256) ||
    value.parserVersion !== IMPORT_PARSER_VERSION ||
    value.mappingVersion !== IMPORT_MAPPING_VERSION ||
    value.recordSchemaVersion !== IMPORT_SCHEMA_VERSION ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    !Array.isArray(value.rows)
  ) {
    throw new PubkyShopError("manifest_store_error");
  }
  const rows: PlannedImportRow[] = value.rows.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      !hasOnlyKeys(candidate, [
        "sourceRow",
        "sourceIdentity",
        "rowIdentity",
        "normalizedHash",
        "listingIdentity",
        "listingId",
        "generatedListingId",
        "variantId",
        "sku",
        "intendedAction",
        "idempotencyKey",
        "checkpoint",
        "failureCode",
      ]) ||
      typeof candidate.sourceRow !== "number" ||
      !Number.isSafeInteger(candidate.sourceRow) ||
      candidate.sourceRow < 2 ||
      typeof candidate.sourceIdentity !== "string" ||
      candidate.sourceIdentity.length < 1 ||
      candidate.sourceIdentity.length > 2048 ||
      typeof candidate.rowIdentity !== "string" ||
      candidate.rowIdentity.length < 1 ||
      candidate.rowIdentity.length > 2048 ||
      typeof candidate.normalizedHash !== "string" ||
      !hashPattern.test(candidate.normalizedHash) ||
      typeof candidate.listingIdentity !== "string" ||
      candidate.listingIdentity.length < 1 ||
      candidate.listingIdentity.length > 2048 ||
      typeof candidate.listingId !== "string" ||
      !listingIdPattern.test(candidate.listingId) ||
      !(
        candidate.generatedListingId === null ||
        (typeof candidate.generatedListingId === "string" &&
          listingIdPattern.test(candidate.generatedListingId))
      ) ||
      typeof candidate.variantId !== "string" ||
      !listingIdPattern.test(candidate.variantId) ||
      typeof candidate.sku !== "string" ||
      candidate.sku.length > 128 ||
      typeof candidate.intendedAction !== "string" ||
      !actions.has(candidate.intendedAction) ||
      typeof candidate.idempotencyKey !== "string" ||
      !idempotencyKeyPattern.test(candidate.idempotencyKey) ||
      typeof candidate.checkpoint !== "string" ||
      !checkpoints.has(candidate.checkpoint) ||
      !(
        candidate.failureCode === undefined ||
        (typeof candidate.failureCode === "string" && errorCodes.has(candidate.failureCode))
      )
    ) {
      throw new PubkyShopError("manifest_store_error");
    }
    return { ...candidate } as unknown as PlannedImportRow;
  });
  if (new Set(rows.map((row) => row.rowIdentity)).size !== rows.length) {
    throw new PubkyShopError("manifest_store_error");
  }
  return { ...(value as unknown as ImportManifest), rows };
}

function parseManifest(bytes: Uint8Array): ImportManifest {
  try {
    return parseManifestValue(
      parseBoundedJson(bytes, {
        maxBytes: 64 * 1024 * 1024,
        maxDepth: 16,
        maxNodes: 500_000,
        maxStringBytes: 1024 * 1024,
      }),
    );
  } catch (error) {
    if (error instanceof PubkyShopError && error.code === "manifest_store_error") {
      throw error;
    }
    throw new PubkyShopError("manifest_store_error");
  }
}

function sameImmutableManifest(left: ImportManifest, right: ImportManifest): boolean {
  const immutableRow = (row: PlannedImportRow): JsonObject => ({
    sourceRow: row.sourceRow,
    sourceIdentity: row.sourceIdentity,
    rowIdentity: row.rowIdentity,
    normalizedHash: row.normalizedHash,
    listingIdentity: row.listingIdentity,
    listingId: row.listingId,
    generatedListingId: row.generatedListingId,
    variantId: row.variantId,
    sku: row.sku,
    intendedAction: row.intendedAction,
    idempotencyKey: row.idempotencyKey,
  });
  return (
    left.manifestId === right.manifestId &&
    left.sourceSha256 === right.sourceSha256 &&
    left.parserVersion === right.parserVersion &&
    left.mappingVersion === right.mappingVersion &&
    left.recordSchemaVersion === right.recordSchemaVersion &&
    left.createdAt === right.createdAt &&
    JSON.stringify(left.rows.map(immutableRow)) === JSON.stringify(right.rows.map(immutableRow))
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT" ? Promise.reject(error) : false;
  }
}

/**
 * Host-supplied durable adapter backed by one canonical manifest file per id.
 * Updates take an inter-process exclusive lock, verify the expected version,
 * fsync a mode-0600 temporary file, atomically rename it, then fsync the
 * containing mode-0700 directory.
 */
export class FileManifestStore implements ManifestStore {
  readonly #directory: string;
  readonly #lockTimeoutMs: number;

  constructor(directory: string, options: { readonly lockTimeoutMs?: number } = {}) {
    if (directory.length === 0) {
      throw new PubkyShopError("invalid_configuration", { field: "directory" });
    }
    const timeout = options.lockTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
      throw new PubkyShopError("invalid_configuration", { field: "lockTimeoutMs" });
    }
    this.#directory = directory;
    this.#lockTimeoutMs = timeout;
  }

  async create(manifest: ImportManifest): Promise<void> {
    this.#validateId(manifest.manifestId);
    const validated = parseManifestValue(manifestJson(manifest));
    if (validated.manifestVersion !== 1) {
      throw new PubkyShopError("manifest_conflict", {
        manifestId: manifest.manifestId,
      });
    }
    await this.#withLock(manifest.manifestId, async () => {
      const path = this.#path(manifest.manifestId);
      if (await fileExists(path)) {
        throw new PubkyShopError("manifest_conflict", {
          manifestId: manifest.manifestId,
        });
      }
      await this.#atomicWrite(path, manifest);
    });
  }

  async load(manifestId: string): Promise<ImportManifest | null> {
    this.#validateId(manifestId);
    await this.#ensureSecureDirectory(manifestId);
    try {
      return parseManifest(await readFile(this.#path(manifestId)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      if (error instanceof PubkyShopError) {
        throw error;
      }
      throw new PubkyShopError("manifest_store_error", { manifestId });
    }
  }

  async compareAndSwap(
    manifestId: string,
    expectedVersion: number,
    update: (manifest: ImportManifest) => ImportManifest,
  ): Promise<ImportManifest> {
    this.#validateId(manifestId);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new PubkyShopError("manifest_conflict", { manifestId });
    }
    return this.#withLock(manifestId, async () => {
      const current = await this.load(manifestId);
      if (current === null || current.manifestVersion !== expectedVersion) {
        throw new PubkyShopError("manifest_conflict", { manifestId });
      }
      let next: ImportManifest;
      try {
        next = update(cloneManifest(current));
      } catch (error) {
        if (error instanceof PubkyShopError) {
          throw error;
        }
        throw new PubkyShopError("manifest_store_error", { manifestId });
      }
      if (
        next.manifestVersion !== current.manifestVersion + 1 ||
        !sameImmutableManifest(current, next)
      ) {
        throw new PubkyShopError("manifest_conflict", { manifestId });
      }
      parseManifestValue(manifestJson(next));
      await this.#atomicWrite(this.#path(manifestId), next);
      return cloneManifest(next);
    });
  }

  #validateId(manifestId: string): void {
    if (!validManifestId(manifestId)) {
      throw new PubkyShopError("manifest_store_error");
    }
  }

  #path(manifestId: string): string {
    return join(this.#directory, `${manifestId}.json`);
  }

  async #withLock<T>(manifestId: string, operation: () => Promise<T>): Promise<T> {
    await this.#ensureSecureDirectory(manifestId);
    const lockPath = join(this.#directory, `${manifestId}.lock`);
    const started = Date.now();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    while (handle === undefined) {
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new PubkyShopError("manifest_store_error", { manifestId });
        }
        if (await this.#removeStaleLock(lockPath)) {
          continue;
        }
        if (Date.now() - started >= this.#lockTimeoutMs) {
          throw new PubkyShopError("manifest_store_error", { manifestId });
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      await handle.writeFile(`${process.pid}\n`);
      await handle.sync();
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async #ensureSecureDirectory(manifestId: string): Promise<void> {
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const facts = await lstat(this.#directory);
      if (!facts.isDirectory() || facts.isSymbolicLink() || (facts.mode & 0o077) !== 0) {
        throw new PubkyShopError("manifest_store_error", { manifestId });
      }
    } catch (error) {
      if (error instanceof PubkyShopError) {
        throw error;
      }
      throw new PubkyShopError("manifest_store_error", { manifestId });
    }
  }

  async #removeStaleLock(lockPath: string): Promise<boolean> {
    try {
      const facts = await lstat(lockPath);
      if (!facts.isFile() || facts.isSymbolicLink()) {
        return false;
      }
      const contents = await readFile(lockPath, "utf8");
      const pid = Number(contents.trim());
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            return false;
          }
          return this.#unlinkObservedLock(lockPath, facts);
        }
      }
      if (Date.now() - facts.mtimeMs >= this.#lockTimeoutMs) {
        return this.#unlinkObservedLock(lockPath, facts);
      }
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  async #unlinkObservedLock(
    lockPath: string,
    observed: Awaited<ReturnType<typeof lstat>>,
  ): Promise<boolean> {
    try {
      const current = await lstat(lockPath);
      if (
        current.dev !== observed.dev ||
        current.ino !== observed.ino ||
        current.size !== observed.size ||
        current.mtimeMs !== observed.mtimeMs ||
        current.birthtimeMs !== observed.birthtimeMs
      ) {
        return false;
      }
      await unlink(lockPath);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  async #atomicWrite(path: string, manifest: ImportManifest): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(encodeCanonicalJson(manifestJson(manifest)));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
      const directory = await open(this.#directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      if (error instanceof PubkyShopError) {
        throw error;
      }
      throw new PubkyShopError("manifest_store_error", {
        manifestId: manifest.manifestId,
      });
    }
  }
}

function deterministicIdempotencyKey(
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

function actionFor(
  row: CanonicalCsvRow,
  hash: string,
  currentItems: Readonly<Record<string, CurrentImportItem>>,
): ImportAction {
  const current = currentItems[canonicalCsvRowIdentity(row)];
  if (current === undefined) {
    return "create";
  }
  if (
    !hashPattern.test(current.normalizedHash) ||
    !Number.isSafeInteger(current.recordRevision) ||
    current.recordRevision < 1
  ) {
    throw new PubkyShopError("invalid_mapping", {
      ...(row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow }),
    });
  }
  if (row.recordRevision !== null && row.recordRevision !== current.recordRevision) {
    return "conflict";
  }
  if (current.normalizedHash === hash) {
    return "unchanged";
  }
  return row.state === "ended" ? "end" : "update";
}

function sourceIdentity(row: CanonicalCsvRow): string {
  return `${listingIdentity(row)}#variant:${row.variantId}`;
}

function plannedRows(
  rows: readonly CanonicalCsvRow[],
  manifestId: string,
  currentItems: Readonly<Record<string, CurrentImportItem>>,
  generateListingId: () => string,
): PlannedImportRow[] {
  const generatedByListing = new Map<string, string>();
  const generatedListingIds = new Set<string>();
  return rows.map((row) => {
    const identity = listingIdentity(row);
    const needsGenerated = row.recordUri === "" && row.listingId === "";
    let generatedListingId: string | null = null;
    let listingId = row.listingId;
    if (needsGenerated) {
      const existingGenerated = generatedByListing.get(identity);
      generatedListingId = existingGenerated ?? generateListingId();
      if (!listingIdPattern.test(generatedListingId)) {
        throw new PubkyShopError("invalid_identity", {
          ...(row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow }),
        });
      }
      if (existingGenerated === undefined && generatedListingIds.has(generatedListingId)) {
        throw new PubkyShopError("invalid_identity", {
          ...(row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow }),
        });
      }
      generatedByListing.set(identity, generatedListingId);
      generatedListingIds.add(generatedListingId);
      listingId = generatedListingId;
    }
    const normalizedHash = normalizedCsvRowHash(row);
    const rowIdentity = canonicalCsvRowIdentity(row);
    const intendedAction = actionFor(row, normalizedHash, currentItems);
    return {
      sourceRow: row.sourceRow ?? 0,
      sourceIdentity: sourceIdentity(row),
      rowIdentity,
      normalizedHash,
      listingIdentity: identity,
      listingId,
      generatedListingId,
      variantId: row.variantId,
      sku: row.sku,
      intendedAction,
      idempotencyKey: deterministicIdempotencyKey(manifestId, rowIdentity, normalizedHash),
      checkpoint: intendedAction === "conflict" ? "conflict" : "planned",
    };
  });
}

/**
 * Parses and validates the entire source before the first durable write.
 * Wave 2 contains no remote publication callback or API.
 */
export async function planImport(
  csvBytes: Uint8Array,
  options: PlanImportOptions,
): Promise<SdkResult<ImportManifest>> {
  let parsed: ParsedCanonicalCsv;
  try {
    parsed = parseCanonicalCsv(csvBytes);
  } catch (error) {
    return err(error instanceof PubkyShopError ? error : new PubkyShopError("malformed_csv"));
  }
  const manifestId = options.manifestId ?? randomUUID();
  if (!validManifestId(manifestId)) {
    return err(new PubkyShopError("invalid_identity", { field: "manifestId" }));
  }
  let rows: PlannedImportRow[];
  try {
    rows = plannedRows(
      parsed.rows,
      manifestId,
      options.currentItems ?? {},
      options.generateListingId ?? randomUUID,
    );
  } catch (error) {
    return err(error instanceof PubkyShopError ? error : new PubkyShopError("invalid_identity"));
  }
  const manifest: ImportManifest = {
    schemaVersion: 1,
    kind: "pubky-shop-import-manifest",
    manifestId,
    manifestVersion: 1,
    sourceSha256: parsed.sourceSha256,
    parserVersion: IMPORT_PARSER_VERSION,
    mappingVersion: IMPORT_MAPPING_VERSION,
    recordSchemaVersion: IMPORT_SCHEMA_VERSION,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    rows,
  };
  try {
    await options.store.create(manifest);
    return ok(cloneManifest(manifest));
  } catch (error) {
    return err(
      error instanceof PubkyShopError
        ? error
        : new PubkyShopError("manifest_store_error", { manifestId }),
    );
  }
}

const allowedTransitions: Readonly<Record<ImportCheckpoint, readonly ImportCheckpoint[]>> = {
  planned: ["publishing", "conflict", "failed"],
  publishing: ["published_unsynced", "conflict", "failed"],
  published_unsynced: ["complete", "conflict", "failed"],
  complete: [],
  conflict: [],
  failed: ["publishing", "conflict"],
};

export async function checkpointImportRow(
  store: ManifestStore,
  manifestId: string,
  expectedManifestVersion: number,
  rowIdentity: string,
  checkpoint: ImportCheckpoint,
  failureCode?: ErrorCode,
): Promise<SdkResult<ImportManifest>> {
  try {
    const updated = await store.compareAndSwap(manifestId, expectedManifestVersion, (manifest) => {
      let found = false;
      const rows = manifest.rows.map((row) => {
        if (row.rowIdentity !== rowIdentity) {
          return row;
        }
        found = true;
        if (!allowedTransitions[row.checkpoint].includes(checkpoint)) {
          throw new PubkyShopError("manifest_conflict", {
            manifestId,
            rowIdentity,
          });
        }
        return {
          ...row,
          checkpoint,
          ...(failureCode === undefined ? {} : { failureCode }),
        };
      });
      if (!found) {
        throw new PubkyShopError("manifest_conflict", {
          manifestId,
          rowIdentity,
        });
      }
      return { ...manifest, manifestVersion: manifest.manifestVersion + 1, rows };
    });
    return ok(updated);
  } catch (error) {
    return err(
      error instanceof PubkyShopError
        ? error
        : new PubkyShopError("manifest_store_error", { manifestId }),
    );
  }
}

export function resumeTasks(manifest: ImportManifest): readonly ResumeTask[] {
  return manifest.rows.map((row) => ({
    rowIdentity: row.rowIdentity,
    next:
      row.checkpoint === "planned"
        ? "publish"
        : row.checkpoint === "publishing"
          ? "reconcile_publish"
          : row.checkpoint === "published_unsynced"
            ? "sync_service"
            : "none",
  }));
}

export async function replayImport(
  store: ManifestStore,
  manifestId: string,
  csvBytes: Uint8Array,
): Promise<SdkResult<ImportReplayResult>> {
  let parsed: ParsedCanonicalCsv;
  try {
    parsed = parseCanonicalCsv(csvBytes);
  } catch (error) {
    return err(error instanceof PubkyShopError ? error : new PubkyShopError("malformed_csv"));
  }
  let existing: ImportManifest | null;
  try {
    existing = await store.load(manifestId);
  } catch (error) {
    return err(
      error instanceof PubkyShopError
        ? error
        : new PubkyShopError("manifest_store_error", { manifestId }),
    );
  }
  if (existing === null) {
    return err(new PubkyShopError("manifest_conflict", { manifestId }));
  }
  const replayRows = new Map(
    parsed.rows.map((row) => [
      canonicalCsvRowIdentity(row),
      {
        hash: normalizedCsvRowHash(row),
        sourceRow: row.sourceRow ?? 0,
      },
    ]),
  );
  const existingRows = new Map(existing.rows.map((row) => [row.rowIdentity, row]));
  const conflicts: ReplayConflictRow[] = [];
  for (const row of existing.rows) {
    const replay = replayRows.get(row.rowIdentity);
    if (replay === undefined) {
      conflicts.push({
        rowIdentity: row.rowIdentity,
        sourceRow: row.sourceRow,
        reason: "missing_from_replay",
      });
    } else if (replay.hash !== row.normalizedHash) {
      conflicts.push({
        rowIdentity: row.rowIdentity,
        sourceRow: replay.sourceRow,
        reason: "changed_hash",
      });
    }
  }
  for (const [rowIdentity, replay] of replayRows) {
    if (!existingRows.has(rowIdentity)) {
      conflicts.push({
        rowIdentity,
        sourceRow: replay.sourceRow,
        reason: "not_in_manifest",
      });
    }
  }
  if (conflicts.length === 0) {
    return ok({ kind: "same", manifest: existing });
  }
  try {
    const conflictIds = new Set(conflicts.map((conflict) => conflict.rowIdentity));
    const quarantined = await store.compareAndSwap(
      manifestId,
      existing.manifestVersion,
      (manifest) => ({
        ...manifest,
        manifestVersion: manifest.manifestVersion + 1,
        rows: manifest.rows.map((row) =>
          conflictIds.has(row.rowIdentity) ? { ...row, checkpoint: "conflict" as const } : row,
        ),
      }),
    );
    return ok({
      kind: "quarantined",
      manifest: quarantined,
      conflicts: Object.freeze(conflicts),
    });
  } catch (error) {
    return err(
      error instanceof PubkyShopError
        ? error
        : new PubkyShopError("manifest_store_error", { manifestId }),
    );
  }
}
