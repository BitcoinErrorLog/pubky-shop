import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  type CanonicalCsvRow,
  type CsvByteSource,
  type CsvStreamLimits,
  canonicalCsvRowIdentity,
  listingIdentity,
  normalizedListingFactsHash,
  normalizedCsvRowHash,
  parseCanonicalCsvStream,
} from "./csv.js";
import { ERROR_CODES, type ErrorCode, PubkyShopError, type SdkResult, err, ok } from "./errors.js";
import {
  type JsonObject,
  type JsonValue,
  canonicalJson,
  encodeCanonicalJson,
  parseBoundedJson,
} from "./json.js";
import {
  DEFAULT_EXTERNAL_SORT_MAX_OPEN_FILES,
  externalSortLines,
  maximumExternalSortLineBytes,
  readBoundedLines,
} from "./external-sort.js";

export const IMPORT_PARSER_VERSION = "pubky-shop-csv-rfc4180-stream-v2";
export const IMPORT_MAPPING_VERSION = "pubky-shop-canonical-v2";
export const IMPORT_SCHEMA_VERSION = "pubky-shop-import-manifest-v2";

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

export interface ImportManifestSummary {
  readonly schemaVersion: 2;
  readonly kind: "pubky-shop-import-manifest";
  readonly manifestId: string;
  readonly manifestVersion: number;
  readonly sourceSha256: string;
  readonly sourceByteLength: string;
  readonly rowCount: number;
  readonly parserVersion: string;
  readonly mappingVersion: string;
  readonly recordSchemaVersion: string;
  readonly createdAt: string;
}

export interface ImportManifest extends ImportManifestSummary {
  readonly rows: readonly PlannedImportRow[];
}

export interface CurrentImportItem {
  readonly normalizedHash: string;
  readonly recordRevision: number;
}

export interface PlanImportOptions {
  readonly store: StreamingManifestStore;
  readonly manifestId?: string;
  readonly now?: () => Date;
  readonly generateListingId?: () => string;
  readonly currentItems?: Readonly<Record<string, CurrentImportItem>>;
  readonly limits?: Partial<CsvStreamLimits>;
  readonly maxSortOpenFiles?: number;
}

export interface StreamingPlanResourceUsage {
  readonly sourceBytes: bigint;
  readonly rowCount: number;
  readonly peakParserBufferedBytes: number;
  readonly peakPlannerBufferedBytes: number;
  readonly peakPlannerMetadataBytes: number;
  readonly peakPlannerOpenFiles: number;
  readonly maxPlannerOpenFiles: number;
  readonly maxWorkingSetBytes: number;
}

export interface PlannedImportStream {
  readonly manifest: ImportManifestSummary;
  readonly resourceUsage: StreamingPlanResourceUsage;
}

export interface ReplayConflictRow {
  readonly rowIdentity: string;
  readonly sourceRow: number;
  readonly reason: "changed_hash" | "missing_from_replay" | "not_in_manifest";
}

export interface ReplayQuarantineRecord {
  readonly schemaVersion: 2;
  readonly kind: "pubky-shop-replay-quarantine";
  readonly quarantineId: string;
  readonly quarantineVersion: number;
  readonly manifestId: string;
  readonly manifestVersion: number;
  readonly replaySourceSha256: string;
  readonly conflictHash: string;
  readonly identityHash: string;
  readonly conflictCount: number;
  readonly recordedAt: string;
}

export interface CheckpointImportResult {
  readonly manifest: ImportManifestSummary;
  readonly row: PlannedImportRow;
}

export interface ReplayQuarantineScan {
  readonly recordCount: number;
  readonly lastVersion: number;
  readonly peakBufferedBytes: number;
}

export interface ReplayQuarantineCompactionResult {
  readonly retained: number;
  readonly removed: number;
  readonly lastVersion: number;
}

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

export interface PlanningWorkspace {
  readonly directory: string;
  verify(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface StreamingManifestStore extends ManifestStore {
  createPlanningWorkspace(manifestId: string): Promise<PlanningWorkspace>;
  createFromRowSpool(summary: ImportManifestSummary, rowsPath: string): Promise<void>;
  loadSummary(manifestId: string): Promise<ImportManifestSummary | null>;
  streamRows(manifestId: string): AsyncIterable<PlannedImportRow>;
  checkpointRow(
    manifestId: string,
    expectedVersion: number,
    rowIdentity: string,
    checkpoint: ImportCheckpoint,
    failureCode?: ErrorCode,
  ): Promise<CheckpointImportResult>;
  streamReplayQuarantines(manifestId: string): AsyncIterable<ReplayQuarantineRecord>;
  scanReplayQuarantines(manifestId: string): Promise<ReplayQuarantineScan>;
  loadReplayQuarantines(manifestId: string): Promise<readonly ReplayQuarantineRecord[]>;
  compareAndAppendReplayQuarantine(
    manifestId: string,
    expectedManifestVersion: number,
    record: Omit<ReplayQuarantineRecord, "quarantineVersion">,
    conflictsPath: string,
  ): Promise<ReplayQuarantineRecord>;
  streamReplayConflicts(manifestId: string, quarantineId: string): AsyncIterable<ReplayConflictRow>;
  compactReplayQuarantines(
    manifestId: string,
    expectedManifestVersion: number,
    retainRecordedAtOrAfter: string,
  ): Promise<ReplayQuarantineCompactionResult>;
  repairReplayQuarantineTail(manifestId: string, expectedManifestVersion: number): Promise<boolean>;
  discardManifest(manifestId: string, expectedManifestVersion: number): Promise<boolean>;
}

const manifestIdPattern = /^[A-Za-z0-9_.-]{1,128}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const listingIdPattern = /^[A-Za-z0-9_.-]{1,128}$/;
const idempotencyKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

function parsePlannedRowValue(candidate: JsonValue): PlannedImportRow {
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
}

function parseReplayQuarantineValue(value: JsonValue): ReplayQuarantineRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "kind",
      "quarantineId",
      "quarantineVersion",
      "manifestId",
      "manifestVersion",
      "replaySourceSha256",
      "conflictHash",
      "identityHash",
      "conflictCount",
      "recordedAt",
    ]) ||
    value.schemaVersion !== 2 ||
    value.kind !== "pubky-shop-replay-quarantine" ||
    typeof value.quarantineId !== "string" ||
    !uuidPattern.test(value.quarantineId) ||
    typeof value.quarantineVersion !== "number" ||
    !Number.isSafeInteger(value.quarantineVersion) ||
    value.quarantineVersion < 1 ||
    typeof value.manifestId !== "string" ||
    !validManifestId(value.manifestId) ||
    typeof value.manifestVersion !== "number" ||
    !Number.isSafeInteger(value.manifestVersion) ||
    value.manifestVersion < 1 ||
    typeof value.replaySourceSha256 !== "string" ||
    !hashPattern.test(value.replaySourceSha256) ||
    typeof value.conflictHash !== "string" ||
    !hashPattern.test(value.conflictHash) ||
    typeof value.identityHash !== "string" ||
    !hashPattern.test(value.identityHash) ||
    typeof value.conflictCount !== "number" ||
    !Number.isSafeInteger(value.conflictCount) ||
    value.conflictCount < 1 ||
    typeof value.recordedAt !== "string" ||
    Number.isNaN(Date.parse(value.recordedAt))
  ) {
    throw new PubkyShopError("manifest_store_error");
  }
  const expectedIdentity = replayQuarantineIdentity(
    value.manifestVersion,
    value.replaySourceSha256,
    value.conflictHash,
  );
  if (
    value.identityHash !== expectedIdentity ||
    value.quarantineId !== uuidFromHash(expectedIdentity)
  ) {
    throw new PubkyShopError("manifest_store_error");
  }
  return value as unknown as ReplayQuarantineRecord;
}

function parseReplayConflictValue(value: JsonValue): ReplayConflictRow {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !hasOnlyKeys(value, ["rowIdentity", "sourceRow", "reason"]) ||
    typeof value.rowIdentity !== "string" ||
    value.rowIdentity.length < 1 ||
    value.rowIdentity.length > 2048 ||
    typeof value.sourceRow !== "number" ||
    !Number.isSafeInteger(value.sourceRow) ||
    value.sourceRow < 2 ||
    !(
      value.reason === "changed_hash" ||
      value.reason === "missing_from_replay" ||
      value.reason === "not_in_manifest"
    )
  ) {
    throw new PubkyShopError("manifest_store_error");
  }
  return value as unknown as ReplayConflictRow;
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
      "sourceByteLength",
      "rowCount",
      "parserVersion",
      "mappingVersion",
      "recordSchemaVersion",
      "createdAt",
      "rows",
    ]) ||
    value.schemaVersion !== 2 ||
    value.kind !== "pubky-shop-import-manifest" ||
    typeof value.manifestId !== "string" ||
    !validManifestId(value.manifestId) ||
    typeof value.manifestVersion !== "number" ||
    !Number.isSafeInteger(value.manifestVersion) ||
    value.manifestVersion < 1 ||
    typeof value.sourceSha256 !== "string" ||
    !hashPattern.test(value.sourceSha256) ||
    typeof value.sourceByteLength !== "string" ||
    !/^[1-9]\d*$/.test(value.sourceByteLength) ||
    typeof value.rowCount !== "number" ||
    !Number.isSafeInteger(value.rowCount) ||
    value.rowCount < 0 ||
    value.parserVersion !== IMPORT_PARSER_VERSION ||
    value.mappingVersion !== IMPORT_MAPPING_VERSION ||
    value.recordSchemaVersion !== IMPORT_SCHEMA_VERSION ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    !Array.isArray(value.rows)
  ) {
    throw new PubkyShopError("manifest_store_error");
  }
  const rows: PlannedImportRow[] = value.rows.map(parsePlannedRowValue);
  if (
    rows.length !== value.rowCount ||
    new Set(rows.map((row) => row.rowIdentity)).size !== rows.length
  ) {
    throw new PubkyShopError("manifest_store_error");
  }
  return { ...(value as unknown as ImportManifest), rows };
}

function parseManifestSummaryValue(value: JsonValue): ImportManifestSummary {
  try {
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
        "sourceByteLength",
        "rowCount",
        "parserVersion",
        "mappingVersion",
        "recordSchemaVersion",
        "createdAt",
      ]) ||
      typeof value.rowCount !== "number"
    ) {
      throw new PubkyShopError("manifest_store_error");
    }
    const rowCount = value.rowCount;
    const checked = parseManifestValue({
      ...value,
      rowCount: 0,
      rows: [],
    });
    return {
      schemaVersion: checked.schemaVersion,
      kind: checked.kind,
      manifestId: checked.manifestId,
      manifestVersion: checked.manifestVersion,
      sourceSha256: checked.sourceSha256,
      sourceByteLength: checked.sourceByteLength,
      rowCount,
      parserVersion: checked.parserVersion,
      mappingVersion: checked.mappingVersion,
      recordSchemaVersion: checked.recordSchemaVersion,
      createdAt: checked.createdAt,
    };
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
    left.sourceByteLength === right.sourceByteLength &&
    left.rowCount === right.rowCount &&
    left.parserVersion === right.parserVersion &&
    left.mappingVersion === right.mappingVersion &&
    left.recordSchemaVersion === right.recordSchemaVersion &&
    left.createdAt === right.createdAt &&
    JSON.stringify(left.rows.map(immutableRow)) === JSON.stringify(right.rows.map(immutableRow))
  );
}

function summaryOf(manifest: ImportManifest): ImportManifestSummary {
  return {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    manifestId: manifest.manifestId,
    manifestVersion: manifest.manifestVersion,
    sourceSha256: manifest.sourceSha256,
    sourceByteLength: manifest.sourceByteLength,
    rowCount: manifest.rowCount,
    parserVersion: manifest.parserVersion,
    mappingVersion: manifest.mappingVersion,
    recordSchemaVersion: manifest.recordSchemaVersion,
    createdAt: manifest.createdAt,
  };
}

function parseSummaryLine(line: string): ImportManifestSummary {
  return parseManifestSummaryValue(
    parseBoundedJson(line, {
      maxBytes: 16 * 1024,
      maxDepth: 4,
      maxNodes: 32,
      maxStringBytes: 4096,
    }),
  );
}

function parsePlannedRowLine(line: string): PlannedImportRow {
  return parsePlannedRowValue(
    parseBoundedJson(line, {
      maxBytes: 64 * 1024,
      maxDepth: 8,
      maxNodes: 64,
      maxStringBytes: 4096,
    }),
  );
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const READ_NOFOLLOW = constants.O_RDONLY | NOFOLLOW;
const CREATE_EXCLUSIVE_NOFOLLOW =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;
const APPEND_CREATE_EXCLUSIVE_NOFOLLOW = CREATE_EXCLUSIVE_NOFOLLOW | constants.O_APPEND;
const APPEND_NOFOLLOW = constants.O_WRONLY | constants.O_APPEND | NOFOLLOW;
const JSONL_READ_QUANTUM = 64 * 1024;
const MANIFEST_LINE_BYTES = 64 * 1024;
const QUARANTINE_LINE_BYTES = 64 * 1024;
const CONFLICT_LINE_BYTES = 16 * 1024;
const MATERIALIZED_ROW_LIMIT = 100_000;
const MATERIALIZED_BYTE_LIMIT = 64 * 1024 * 1024;
const DEFAULT_RECOVERY_AGE_MS = 24 * 60 * 60 * 1000;

type FileHandle = Awaited<ReturnType<typeof open>>;
type FileFacts = Awaited<ReturnType<FileHandle["stat"]>>;

interface PinnedRoot {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

export interface FileManifestStoreOptions {
  readonly lockTimeoutMs?: number;
  readonly recoveryAgeMs?: number;
  /**
   * Host diagnostics and deterministic race-test seam. The root is checked
   * immediately before and after this callback; it grants no filesystem power.
   */
  readonly filesystemCheckpoint?: (operation: string) => void | Promise<void>;
}

function sameFile(
  left: Pick<FileFacts, "dev" | "ino">,
  right: Pick<FileFacts, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function secureFile(facts: FileFacts): boolean {
  return facts.isFile() && (Number(facts.mode) & 0o077) === 0;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PubkyShopError("manifest_store_error");
  }
}

async function* readHandleLines(
  handle: FileHandle,
  maxLineBytes: number,
  requireTerminalNewline = true,
  byteLimit?: number,
): AsyncGenerator<string> {
  const buffer = Buffer.allocUnsafe(JSONL_READ_QUANTUM);
  let pending = Buffer.alloc(0);
  let position = 0;
  while (byteLimit === undefined || position < byteLimit) {
    const requested =
      byteLimit === undefined ? buffer.length : Math.min(buffer.length, byteLimit - position);
    if (requested === 0) {
      break;
    }
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (bytesRead === 0) {
      break;
    }
    position += bytesRead;
    let start = 0;
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] !== 0x0a) {
        continue;
      }
      const part = buffer.subarray(start, index);
      if (pending.byteLength + part.byteLength > maxLineBytes) {
        throw new PubkyShopError("manifest_store_error");
      }
      const line =
        pending.byteLength === 0
          ? Buffer.from(part)
          : Buffer.concat([pending, part], pending.byteLength + part.byteLength);
      yield decodeUtf8(line);
      pending = Buffer.alloc(0);
      start = index + 1;
    }
    if (start < bytesRead) {
      const part = buffer.subarray(start, bytesRead);
      if (pending.byteLength + part.byteLength > maxLineBytes) {
        throw new PubkyShopError("manifest_store_error");
      }
      pending =
        pending.byteLength === 0
          ? Buffer.from(part)
          : Buffer.concat([pending, part], pending.byteLength + part.byteLength);
    }
  }
  if (pending.byteLength !== 0) {
    if (requireTerminalNewline) {
      throw new PubkyShopError("manifest_store_error");
    }
    yield decodeUtf8(pending);
  }
}

function parseQuarantineLine(line: string): ReplayQuarantineRecord {
  return parseReplayQuarantineValue(
    parseBoundedJson(line, {
      maxBytes: QUARANTINE_LINE_BYTES,
      maxDepth: 4,
      maxNodes: 64,
      maxStringBytes: 4096,
    }),
  );
}

function parseConflictLine(line: string): ReplayConflictRow {
  return parseReplayConflictValue(
    parseBoundedJson(line, {
      maxBytes: CONFLICT_LINE_BYTES,
      maxDepth: 3,
      maxNodes: 16,
      maxStringBytes: 4096,
    }),
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Durable host adapter. Node has no openat-style API, so confinement is
 * intentionally narrower: the configured root's parent and host config are
 * trusted and not attacker-renameable. The final root is canonicalized once,
 * pinned by device/inode/mode, and checked before/after every operation.
 * Final files use O_NOFOLLOW where the host supports it. Detected replacement
 * fails closed; this does not claim safety from a privileged parent attacker
 * racing the unavoidable check/open gap.
 */
export class FileManifestStore implements StreamingManifestStore {
  readonly #configuredDirectory: string;
  readonly #lockTimeoutMs: number;
  readonly #recoveryAgeMs: number;
  readonly #filesystemCheckpoint: ((operation: string) => void | Promise<void>) | undefined;
  #rootPromise: Promise<PinnedRoot> | undefined;

  constructor(directory: string, options: FileManifestStoreOptions = {}) {
    if (directory.length === 0) {
      throw new PubkyShopError("invalid_configuration", { field: "directory" });
    }
    const timeout = options.lockTimeoutMs ?? 5000;
    const recoveryAgeMs = options.recoveryAgeMs ?? DEFAULT_RECOVERY_AGE_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
      throw new PubkyShopError("invalid_configuration", { field: "lockTimeoutMs" });
    }
    if (
      !Number.isSafeInteger(recoveryAgeMs) ||
      recoveryAgeMs < 1 ||
      recoveryAgeMs > 365 * 24 * 60 * 60 * 1000
    ) {
      throw new PubkyShopError("invalid_configuration", { field: "recoveryAgeMs" });
    }
    this.#configuredDirectory = directory;
    this.#lockTimeoutMs = timeout;
    this.#recoveryAgeMs = recoveryAgeMs;
    this.#filesystemCheckpoint = options.filesystemCheckpoint;
  }

  async create(manifest: ImportManifest): Promise<void> {
    this.#validateId(manifest.manifestId);
    const validated = parseManifestValue(manifestJson(manifest));
    if (validated.manifestVersion !== 1) {
      throw new PubkyShopError("manifest_conflict", { manifestId: manifest.manifestId });
    }
    await this.#withLock(manifest.manifestId, async (root) => {
      const path = this.#path(root, manifest.manifestId);
      if ((await this.#lstatFinal(path)) !== null) {
        throw new PubkyShopError("manifest_conflict", { manifestId: manifest.manifestId });
      }
      await this.#atomicWrite(root, path, manifest);
    });
  }

  async load(manifestId: string): Promise<ImportManifest | null> {
    this.#validateId(manifestId);
    const summary = await this.loadSummary(manifestId);
    if (summary === null) {
      return null;
    }
    if (summary.rowCount > MATERIALIZED_ROW_LIMIT) {
      throw new PubkyShopError("limit_exceeded", {
        field: "manifest_materialized_rows",
        limit: MATERIALIZED_ROW_LIMIT,
        observed: MATERIALIZED_ROW_LIMIT + 1,
        manifestId,
      });
    }
    const rows: PlannedImportRow[] = [];
    let charged = 0;
    for await (const row of this.streamRows(manifestId)) {
      charged += Buffer.byteLength(JSON.stringify(row));
      if (charged > MATERIALIZED_BYTE_LIMIT) {
        throw new PubkyShopError("limit_exceeded", {
          field: "manifest_materialized_bytes",
          limit: MATERIALIZED_BYTE_LIMIT,
          observed: MATERIALIZED_BYTE_LIMIT + 1,
          manifestId,
        });
      }
      rows.push(row);
    }
    const after = await this.loadSummary(manifestId);
    if (after === null || after.manifestVersion !== summary.manifestVersion) {
      throw new PubkyShopError("manifest_conflict", { manifestId });
    }
    return parseManifestValue({
      ...summary,
      rows: rows as unknown as JsonValue[],
    } as unknown as JsonValue);
  }

  async loadSummary(manifestId: string): Promise<ImportManifestSummary | null> {
    this.#validateId(manifestId);
    const root = await this.#root(manifestId);
    const path = this.#path(root, manifestId);
    try {
      return await this.#rootOperation(root, manifestId, "manifest-read-summary", async () => {
        const handle = await this.#openValidatedRead(path);
        try {
          for await (const line of readHandleLines(handle, MANIFEST_LINE_BYTES)) {
            return parseSummaryLine(line);
          }
          throw new PubkyShopError("manifest_store_error", { manifestId });
        } finally {
          await handle.close();
        }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw this.#storeError(error, manifestId);
    }
  }

  async *streamRows(manifestId: string): AsyncGenerator<PlannedImportRow> {
    this.#validateId(manifestId);
    const root = await this.#root(manifestId);
    const path = this.#path(root, manifestId);
    await this.#verifyRoot(root, manifestId);
    await this.#filesystemCheckpoint?.("manifest-stream-open");
    await this.#verifyRoot(root, manifestId);
    let handle: FileHandle | undefined;
    try {
      handle = await this.#openValidatedRead(path);
      let expected = -1;
      let observed = 0;
      let first = true;
      for await (const line of readHandleLines(handle, MANIFEST_LINE_BYTES)) {
        if (first) {
          expected = parseSummaryLine(line).rowCount;
          first = false;
        } else {
          parsePlannedRowLine(line);
          observed += 1;
        }
      }
      if (first || observed !== expected) {
        throw new PubkyShopError("manifest_store_error", { manifestId });
      }
      first = true;
      for await (const line of readHandleLines(handle, MANIFEST_LINE_BYTES)) {
        if (first) {
          parseSummaryLine(line);
          first = false;
        } else {
          yield parsePlannedRowLine(line);
        }
      }
    } catch (error) {
      throw this.#storeError(error, manifestId);
    } finally {
      await handle?.close().catch(() => undefined);
      await this.#verifyRoot(root, manifestId);
    }
  }

  async createPlanningWorkspace(manifestId: string): Promise<PlanningWorkspace> {
    this.#validateId(manifestId);
    const root = await this.#root(manifestId);
    const directory = join(root.path, `.${manifestId}.${process.pid}.${randomUUID()}.planning`);
    const facts = await this.#rootOperation(root, manifestId, "planning-create", async () => {
      await mkdir(directory, { mode: 0o700 });
      const created = await lstat(directory);
      if (!created.isDirectory() || created.isSymbolicLink() || (created.mode & 0o077) !== 0) {
        throw new PubkyShopError("manifest_store_error", { manifestId });
      }
      return created;
    });
    const store = this;
    return {
      directory,
      async verify() {
        await store.#rootOperation(root, manifestId, "planning-verify", async () => {
          const current = await lstat(directory);
          if (!sameFile(current, facts) || !current.isDirectory() || current.isSymbolicLink()) {
            throw new PubkyShopError("manifest_store_error", { manifestId });
          }
        });
      },
      async cleanup() {
        await store.#rootOperation(root, manifestId, "planning-cleanup", async () => {
          const current = await lstat(directory);
          if (!sameFile(current, facts) || !current.isDirectory() || current.isSymbolicLink()) {
            throw new PubkyShopError("manifest_store_error", { manifestId });
          }
          await rm(directory, { recursive: true });
        });
      },
    };
  }

  async createFromRowSpool(summary: ImportManifestSummary, rowsPath: string): Promise<void> {
    this.#validateId(summary.manifestId);
    parseManifestSummaryValue(summary as unknown as JsonValue);
    const root = await this.#root(summary.manifestId);
    await this.#validateRootOwnedSpool(root, rowsPath, summary.manifestId);
    await this.#withLock(summary.manifestId, async (lockedRoot) => {
      const path = this.#path(lockedRoot, summary.manifestId);
      if ((await this.#lstatFinal(path)) !== null) {
        throw new PubkyShopError("manifest_conflict", { manifestId: summary.manifestId });
      }
      await this.#atomicWriteFromLines(
        lockedRoot,
        path,
        summary,
        readBoundedLines(rowsPath, MANIFEST_LINE_BYTES),
      );
    });
  }

  async checkpointRow(
    manifestId: string,
    expectedVersion: number,
    rowIdentity: string,
    checkpoint: ImportCheckpoint,
    failureCode?: ErrorCode,
  ): Promise<CheckpointImportResult> {
    this.#validateId(manifestId);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new PubkyShopError("manifest_conflict", { manifestId });
    }
    return this.#withLock(manifestId, async (root) => {
      const path = this.#path(root, manifestId);
      const source = await this.#openValidatedRead(path);
      try {
        const sourceFacts = await source.stat();
        let summary: ImportManifestSummary | undefined;
        for await (const line of readHandleLines(source, MANIFEST_LINE_BYTES)) {
          summary = parseSummaryLine(line);
          break;
        }
        if (summary === undefined || summary.manifestVersion !== expectedVersion) {
          throw new PubkyShopError("manifest_conflict", { manifestId });
        }
        const nextSummary = { ...summary, manifestVersion: summary.manifestVersion + 1 };
        let updated: PlannedImportRow | undefined;
        let first = true;
        const rows = async function* (): AsyncGenerator<string> {
          for await (const line of readHandleLines(source, MANIFEST_LINE_BYTES)) {
            if (first) {
              parseSummaryLine(line);
              first = false;
              continue;
            }
            const row = parsePlannedRowLine(line);
            if (row.rowIdentity !== rowIdentity) {
              yield line;
              continue;
            }
            if (updated !== undefined || !allowedTransitions[row.checkpoint].includes(checkpoint)) {
              throw new PubkyShopError("manifest_conflict", { manifestId, rowIdentity });
            }
            updated = {
              ...row,
              checkpoint,
              ...(failureCode === undefined ? {} : { failureCode }),
            };
            yield canonicalJson(updated as unknown as JsonObject);
          }
          if (updated === undefined) {
            throw new PubkyShopError("manifest_conflict", { manifestId, rowIdentity });
          }
        };
        await this.#atomicWriteFromLines(root, path, nextSummary, rows(), sourceFacts);
        const committedRow = updated;
        if (committedRow === undefined) {
          throw new PubkyShopError("manifest_store_error", { manifestId });
        }
        return { manifest: nextSummary, row: committedRow };
      } finally {
        await source.close();
      }
    });
  }

  async *streamReplayQuarantines(manifestId: string): AsyncGenerator<ReplayQuarantineRecord> {
    this.#validateId(manifestId);
    const root = await this.#root(manifestId);
    const path = this.#quarantinePath(root, manifestId);
    await this.#verifyRoot(root, manifestId);
    await this.#filesystemCheckpoint?.("quarantine-stream-open");
    await this.#verifyRoot(root, manifestId);
    let handle: FileHandle | undefined;
    try {
      handle = await this.#openValidatedRead(path);
      let priorVersion = 0;
      for await (const line of readHandleLines(handle, QUARANTINE_LINE_BYTES)) {
        const record = parseQuarantineLine(line);
        if (record.manifestId !== manifestId || record.quarantineVersion <= priorVersion) {
          throw new PubkyShopError("manifest_store_error", { manifestId });
        }
        priorVersion = record.quarantineVersion;
      }
      priorVersion = 0;
      for await (const line of readHandleLines(handle, QUARANTINE_LINE_BYTES)) {
        const record = parseQuarantineLine(line);
        if (record.manifestId !== manifestId || record.quarantineVersion <= priorVersion) {
          throw new PubkyShopError("manifest_store_error", { manifestId });
        }
        priorVersion = record.quarantineVersion;
        yield record;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw this.#storeError(error, manifestId);
    } finally {
      await handle?.close().catch(() => undefined);
      await this.#verifyRoot(root, manifestId);
    }
  }

  async scanReplayQuarantines(manifestId: string): Promise<ReplayQuarantineScan> {
    let recordCount = 0;
    let lastVersion = 0;
    for await (const record of this.streamReplayQuarantines(manifestId)) {
      recordCount += 1;
      lastVersion = record.quarantineVersion;
    }
    return {
      recordCount,
      lastVersion,
      peakBufferedBytes: JSONL_READ_QUANTUM + QUARANTINE_LINE_BYTES,
    };
  }

  async loadReplayQuarantines(manifestId: string): Promise<readonly ReplayQuarantineRecord[]> {
    const records: ReplayQuarantineRecord[] = [];
    let charged = 0;
    for await (const record of this.streamReplayQuarantines(manifestId)) {
      charged += Buffer.byteLength(JSON.stringify(record));
      if (records.length >= MATERIALIZED_ROW_LIMIT || charged > MATERIALIZED_BYTE_LIMIT) {
        throw new PubkyShopError("limit_exceeded", {
          field: "quarantine_materialized_records",
          limit: MATERIALIZED_ROW_LIMIT,
          observed: MATERIALIZED_ROW_LIMIT + 1,
          manifestId,
        });
      }
      records.push(record);
    }
    return Object.freeze(records);
  }

  async compareAndAppendReplayQuarantine(
    manifestId: string,
    expectedManifestVersion: number,
    record: Omit<ReplayQuarantineRecord, "quarantineVersion">,
    conflictsPath: string,
  ): Promise<ReplayQuarantineRecord> {
    this.#validateId(manifestId);
    if (!Number.isSafeInteger(expectedManifestVersion) || expectedManifestVersion < 1) {
      throw new PubkyShopError("manifest_conflict", { manifestId });
    }
    const root = await this.#root(manifestId);
    await this.#validateRootOwnedSpool(root, conflictsPath, manifestId);
    return this.#withLock(manifestId, async (lockedRoot) => {
      const summary = await this.loadSummary(manifestId);
      if (summary === null || summary.manifestVersion !== expectedManifestVersion) {
        throw new PubkyShopError("manifest_conflict", { manifestId });
      }
      let lastVersion = 0;
      let duplicate: ReplayQuarantineRecord | undefined;
      for await (const existing of this.streamReplayQuarantines(manifestId)) {
        lastVersion = existing.quarantineVersion;
        if (existing.identityHash === record.identityHash) {
          duplicate = existing;
        }
      }
      await this.#removeConflictVersionsAfter(lockedRoot, manifestId, lastVersion);
      if (duplicate !== undefined) {
        return duplicate;
      }
      const appended = parseReplayQuarantineValue({
        ...record,
        quarantineVersion: lastVersion + 1,
      } as unknown as JsonValue);
      if (
        appended.manifestId !== manifestId ||
        appended.manifestVersion !== expectedManifestVersion
      ) {
        throw new PubkyShopError("manifest_conflict", { manifestId });
      }
      await this.#persistConflictSpool(lockedRoot, appended, conflictsPath);
      await this.#appendQuarantine(lockedRoot, appended);
      return appended;
    });
  }

  async *streamReplayConflicts(
    manifestId: string,
    quarantineId: string,
  ): AsyncGenerator<ReplayConflictRow> {
    this.#validateId(manifestId);
    let quarantine: ReplayQuarantineRecord | undefined;
    for await (const candidate of this.streamReplayQuarantines(manifestId)) {
      if (candidate.quarantineId === quarantineId) {
        quarantine = candidate;
        break;
      }
    }
    if (quarantine === undefined) {
      throw new PubkyShopError("manifest_store_error", { manifestId });
    }
    const root = await this.#root(manifestId);
    const path = this.#conflictPath(
      root,
      manifestId,
      quarantine.quarantineVersion,
      quarantine.identityHash,
    );
    await this.#verifyRoot(root, manifestId);
    const handle = await this.#openValidatedRead(path);
    try {
      const hash = createHash("sha256");
      let count = 0;
      for await (const line of readHandleLines(handle, CONFLICT_LINE_BYTES)) {
        const conflict = parseConflictLine(line);
        hash.update(encodeCanonicalJson(conflict as unknown as JsonObject));
        count += 1;
      }
      if (count !== quarantine.conflictCount || hash.digest("hex") !== quarantine.conflictHash) {
        throw new PubkyShopError("manifest_store_error", { manifestId });
      }
      for await (const line of readHandleLines(handle, CONFLICT_LINE_BYTES)) {
        yield parseConflictLine(line);
      }
    } finally {
      await handle.close();
      await this.#verifyRoot(root, manifestId);
    }
  }

  async compactReplayQuarantines(
    manifestId: string,
    expectedManifestVersion: number,
    retainRecordedAtOrAfter: string,
  ): Promise<ReplayQuarantineCompactionResult> {
    const cutoff = Date.parse(retainRecordedAtOrAfter);
    if (Number.isNaN(cutoff)) {
      throw new PubkyShopError("invalid_configuration", { field: "retainRecordedAtOrAfter" });
    }
    return this.#withLock(manifestId, async (root) => {
      const summary = await this.loadSummary(manifestId);
      if (summary === null || summary.manifestVersion !== expectedManifestVersion) {
        throw new PubkyShopError("manifest_conflict", { manifestId });
      }
      const path = this.#quarantinePath(root, manifestId);
      if ((await this.#lstatFinal(path)) === null) {
        return { retained: 0, removed: 0, lastVersion: 0 };
      }
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      const deletions = `${temporary}.deletions`;
      let output: FileHandle | undefined;
      let deletionOutput: FileHandle | undefined;
      let retained = 0;
      let removed = 0;
      let lastVersion = 0;
      try {
        output = await open(temporary, CREATE_EXCLUSIVE_NOFOLLOW, 0o600);
        deletionOutput = await open(deletions, CREATE_EXCLUSIVE_NOFOLLOW, 0o600);
        for await (const record of this.streamReplayQuarantines(manifestId)) {
          lastVersion = record.quarantineVersion;
          if (Date.parse(record.recordedAt) >= cutoff) {
            await output.writeFile(encodeCanonicalJson(record as unknown as JsonObject));
            retained += 1;
          } else {
            await deletionOutput.writeFile(`${record.quarantineVersion}\t${record.identityHash}\n`);
            removed += 1;
          }
        }
        await output.sync();
        await deletionOutput.sync();
        await output.close();
        output = undefined;
        await deletionOutput.close();
        deletionOutput = undefined;
        await this.#replaceFinal(root, path, temporary);
        for await (const deletion of readBoundedLines(deletions, 96)) {
          const [versionText, identity] = deletion.split("\t");
          const version = Number(versionText);
          if (
            Number.isSafeInteger(version) &&
            version > 0 &&
            identity !== undefined &&
            hashPattern.test(identity)
          ) {
            await unlink(this.#conflictPath(root, manifestId, version, identity)).catch(
              () => undefined,
            );
          }
        }
        await unlink(deletions);
        await this.#syncRoot(root);
        return { retained, removed, lastVersion };
      } catch (error) {
        await output?.close().catch(() => undefined);
        await deletionOutput?.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
        await unlink(deletions).catch(() => undefined);
        throw this.#storeError(error, manifestId);
      }
    });
  }

  async repairReplayQuarantineTail(
    manifestId: string,
    expectedManifestVersion: number,
  ): Promise<boolean> {
    return this.#withLock(manifestId, async (root) => {
      const summary = await this.loadSummary(manifestId);
      if (summary === null || summary.manifestVersion !== expectedManifestVersion) {
        throw new PubkyShopError("manifest_conflict", { manifestId });
      }
      const path = this.#quarantinePath(root, manifestId);
      let handle: FileHandle;
      try {
        handle = await open(path, constants.O_RDWR | NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw error;
      }
      try {
        const facts = await handle.stat();
        if (!secureFile(facts) || facts.size === 0) {
          return false;
        }
        const tail = Buffer.alloc(1);
        await handle.read(tail, 0, 1, facts.size - 1);
        if (tail[0] === 0x0a) {
          return false;
        }
        let cursor = facts.size;
        let lastNewline = -1;
        const chunk = Buffer.allocUnsafe(JSONL_READ_QUANTUM);
        while (cursor > 0 && lastNewline < 0) {
          const start = Math.max(0, cursor - chunk.length);
          const length = cursor - start;
          await handle.read(chunk, 0, length, start);
          const found = chunk.subarray(0, length).lastIndexOf(0x0a);
          if (found >= 0) {
            lastNewline = start + found;
          }
          cursor = start;
        }
        const keepBytes = lastNewline + 1;
        let priorVersion = 0;
        for await (const line of readHandleLines(handle, QUARANTINE_LINE_BYTES, true, keepBytes)) {
          const record = parseQuarantineLine(line);
          if (record.manifestId !== manifestId || record.quarantineVersion <= priorVersion) {
            throw new PubkyShopError("manifest_store_error", { manifestId });
          }
          priorVersion = record.quarantineVersion;
        }
        await handle.truncate(keepBytes);
        await handle.sync();
        await this.#removeConflictVersionsAfter(root, manifestId, priorVersion);
        await this.#syncRoot(root);
        return true;
      } finally {
        await handle.close();
      }
    });
  }

  async discardManifest(manifestId: string, expectedManifestVersion: number): Promise<boolean> {
    this.#validateId(manifestId);
    return this.#withLock(manifestId, async (root) => {
      const summary = await this.loadSummary(manifestId);
      if (summary === null) {
        return false;
      }
      if (summary.manifestVersion !== expectedManifestVersion) {
        throw new PubkyShopError("manifest_conflict", { manifestId });
      }
      const manifestName = `${manifestId}.manifest.jsonl`;
      const quarantineName = `${manifestId}.replay-quarantine.jsonl`;
      const conflictPrefix = `${manifestId}.replay-conflicts.`;
      const relevant = (name: string): boolean =>
        name === manifestName ||
        name === quarantineName ||
        (name.startsWith(conflictPrefix) && name.endsWith(".jsonl"));

      let scan = await opendir(root.path);
      for await (const entry of scan) {
        if (entry.name.startsWith("._") || !relevant(entry.name)) {
          continue;
        }
        const facts = await lstat(join(root.path, entry.name));
        if (!facts.isFile() || facts.isSymbolicLink() || (facts.mode & 0o077) !== 0) {
          throw new PubkyShopError("manifest_store_error", { manifestId });
        }
      }

      const discarding = join(
        root.path,
        `.${manifestId}.${process.pid}.${randomUUID()}.discarding`,
      );
      await mkdir(discarding, { mode: 0o700 });
      await rename(this.#path(root, manifestId), join(discarding, manifestName));
      await this.#syncRoot(root);
      scan = await opendir(root.path);
      for await (const entry of scan) {
        if (entry.name.startsWith("._") || entry.name === manifestName || !relevant(entry.name)) {
          continue;
        }
        await rename(join(root.path, entry.name), join(discarding, entry.name));
      }
      await this.#syncRoot(root);
      await rm(discarding, { recursive: true });
      await this.#syncRoot(root);
      return true;
    });
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
    return this.#withLock(manifestId, async (root) => {
      const current = await this.load(manifestId);
      if (current === null || current.manifestVersion !== expectedVersion) {
        throw new PubkyShopError("manifest_conflict", { manifestId });
      }
      let next: ImportManifest;
      try {
        next = update(cloneManifest(current));
      } catch (error) {
        throw this.#storeError(error, manifestId);
      }
      if (
        next.manifestVersion !== current.manifestVersion + 1 ||
        !sameImmutableManifest(current, next)
      ) {
        throw new PubkyShopError("manifest_conflict", { manifestId });
      }
      parseManifestValue(manifestJson(next));
      const currentFacts = await lstat(this.#path(root, manifestId));
      await this.#atomicWrite(root, this.#path(root, manifestId), next, currentFacts);
      return cloneManifest(next);
    });
  }

  #validateId(manifestId: string): void {
    if (!validManifestId(manifestId)) {
      throw new PubkyShopError("manifest_store_error");
    }
  }

  #path(root: PinnedRoot, manifestId: string): string {
    return join(root.path, `${manifestId}.manifest.jsonl`);
  }

  #quarantinePath(root: PinnedRoot, manifestId: string): string {
    return join(root.path, `${manifestId}.replay-quarantine.jsonl`);
  }

  #conflictPath(
    root: PinnedRoot,
    manifestId: string,
    quarantineVersion: number,
    identityHash: string,
  ): string {
    return join(
      root.path,
      `${manifestId}.replay-conflicts.${quarantineVersion}.${identityHash}.jsonl`,
    );
  }

  async #root(manifestId: string): Promise<PinnedRoot> {
    this.#rootPromise ??= this.#initializeRoot(manifestId);
    return this.#rootPromise;
  }

  async #initializeRoot(manifestId: string): Promise<PinnedRoot> {
    try {
      await mkdir(this.#configuredDirectory, { recursive: true, mode: 0o700 });
      const configuredFacts = await lstat(this.#configuredDirectory);
      if (
        !configuredFacts.isDirectory() ||
        configuredFacts.isSymbolicLink() ||
        (configuredFacts.mode & 0o077) !== 0
      ) {
        throw new PubkyShopError("manifest_store_error", { manifestId });
      }
      const canonicalPath = await realpath(this.#configuredDirectory);
      const facts = await lstat(canonicalPath);
      if (!facts.isDirectory() || facts.isSymbolicLink() || (facts.mode & 0o077) !== 0) {
        throw new PubkyShopError("manifest_store_error", { manifestId });
      }
      const root = { path: canonicalPath, dev: facts.dev, ino: facts.ino, mode: facts.mode };
      await this.#reapAbandoned(root, manifestId);
      return root;
    } catch (error) {
      throw this.#storeError(error, manifestId);
    }
  }

  async #verifyRoot(root: PinnedRoot, manifestId: string): Promise<void> {
    try {
      const facts = await lstat(root.path);
      if (
        !facts.isDirectory() ||
        facts.isSymbolicLink() ||
        facts.dev !== root.dev ||
        facts.ino !== root.ino ||
        facts.mode !== root.mode ||
        (facts.mode & 0o077) !== 0
      ) {
        throw new PubkyShopError("manifest_store_error", { manifestId });
      }
    } catch (error) {
      throw this.#storeError(error, manifestId);
    }
  }

  async #rootOperation<T>(
    root: PinnedRoot,
    manifestId: string,
    operation: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    await this.#verifyRoot(root, manifestId);
    await this.#filesystemCheckpoint?.(operation);
    await this.#verifyRoot(root, manifestId);
    try {
      const result = await callback();
      await this.#verifyRoot(root, manifestId);
      return result;
    } catch (error) {
      await this.#verifyRoot(root, manifestId);
      throw error;
    }
  }

  async #reapAbandoned(root: PinnedRoot, manifestId: string): Promise<void> {
    const directory = await opendir(root.path);
    for await (const entry of directory) {
      if (entry.name.startsWith("._")) {
        continue;
      }
      const match =
        /^\.[A-Za-z0-9_.-]{1,128}\.(\d+)\.[0-9a-f-]{36}\.(?:planning|discarding)$/.exec(
          entry.name,
        ) ??
        /^[A-Za-z0-9_.-]{1,128}\.(?:manifest|replay-quarantine|replay-conflicts\.\d+\.[0-9a-f]{64})\.jsonl\.(\d+)\.[0-9a-f-]{36}\.tmp(?:\.deletions)?$/.exec(
          entry.name,
        );
      if (match === null) {
        continue;
      }
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid < 1 || processExists(pid)) {
        continue;
      }
      const path = join(root.path, entry.name);
      const observed = await lstat(path);
      if (Date.now() - observed.mtimeMs < this.#recoveryAgeMs) {
        continue;
      }
      await this.#verifyRoot(root, manifestId);
      const current = await lstat(path);
      if (!sameFile(observed, current)) {
        continue;
      }
      if (current.isDirectory() && !current.isSymbolicLink()) {
        await rm(path, { recursive: true });
      } else if (current.isFile() && !current.isSymbolicLink()) {
        await unlink(path);
      }
      await this.#verifyRoot(root, manifestId);
    }
  }

  async #openValidatedRead(path: string): Promise<FileHandle> {
    const handle = await open(path, READ_NOFOLLOW);
    try {
      const facts = await handle.stat();
      if (!secureFile(facts)) {
        throw new PubkyShopError("manifest_store_error");
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async #lstatFinal(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
    try {
      const facts = await lstat(path);
      if (facts.isSymbolicLink() || !facts.isFile() || (facts.mode & 0o077) !== 0) {
        throw new PubkyShopError("manifest_store_error");
      }
      return facts;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async #validateRootOwnedSpool(root: PinnedRoot, path: string, manifestId: string): Promise<void> {
    await this.#verifyRoot(root, manifestId);
    const canonical = await realpath(path);
    if (!canonical.startsWith(`${root.path}/`)) {
      throw new PubkyShopError("manifest_store_error", { manifestId });
    }
    const facts = await lstat(canonical);
    if (!facts.isFile() || facts.isSymbolicLink() || (facts.mode & 0o077) !== 0) {
      throw new PubkyShopError("manifest_store_error", { manifestId });
    }
    await this.#verifyRoot(root, manifestId);
  }

  async #withLock<T>(manifestId: string, operation: (root: PinnedRoot) => Promise<T>): Promise<T> {
    const root = await this.#root(manifestId);
    const lockPath = join(root.path, `${manifestId}.lock`);
    const started = Date.now();
    let handle: FileHandle | undefined;
    while (handle === undefined) {
      await this.#verifyRoot(root, manifestId);
      await this.#filesystemCheckpoint?.("lock-open");
      await this.#verifyRoot(root, manifestId);
      try {
        handle = await open(lockPath, CREATE_EXCLUSIVE_NOFOLLOW, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new PubkyShopError("manifest_store_error", { manifestId });
        }
        if (await this.#removeStaleLock(root, lockPath, manifestId)) {
          continue;
        }
        if (Date.now() - started >= this.#lockTimeoutMs) {
          throw new PubkyShopError("manifest_store_error", { manifestId });
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    let observed: FileFacts | undefined;
    try {
      await handle.writeFile(`${process.pid}\n`);
      await handle.sync();
      observed = await handle.stat();
      const result = await operation(root);
      await this.#verifyRoot(root, manifestId);
      return result;
    } finally {
      await handle.close().catch(() => undefined);
      if (observed !== undefined) {
        await this.#unlinkObserved(lockPath, observed).catch(() => undefined);
      }
      await this.#verifyRoot(root, manifestId);
    }
  }

  async #removeStaleLock(root: PinnedRoot, lockPath: string, manifestId: string): Promise<boolean> {
    let handle: FileHandle | undefined;
    try {
      handle = await this.#openValidatedRead(lockPath);
      const before = await handle.stat();
      const contents = await handle.readFile("utf8");
      const after = await handle.stat();
      if (!sameFile(before, after)) {
        return false;
      }
      const pid = Number(contents.trim());
      if (Number.isSafeInteger(pid) && pid > 0 && processExists(pid)) {
        return false;
      }
      if (
        (!Number.isSafeInteger(pid) || pid < 1) &&
        Date.now() - before.mtimeMs < this.#lockTimeoutMs
      ) {
        return false;
      }
      await this.#verifyRoot(root, manifestId);
      return this.#unlinkObserved(lockPath, before);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #unlinkObserved(path: string, observed: Pick<FileFacts, "dev" | "ino">): Promise<boolean> {
    try {
      const current = await lstat(path);
      if (!sameFile(current, observed) || current.isSymbolicLink()) {
        return false;
      }
      await unlink(path);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  async #atomicWrite(
    root: PinnedRoot,
    path: string,
    manifest: ImportManifest,
    expectedFinal?: Pick<FileFacts, "dev" | "ino">,
  ): Promise<void> {
    async function* rows(): AsyncGenerator<string> {
      for (const row of manifest.rows) {
        yield canonicalJson(row as unknown as JsonObject);
      }
    }
    await this.#atomicWriteFromLines(root, path, summaryOf(manifest), rows(), expectedFinal);
  }

  async #atomicWriteFromLines(
    root: PinnedRoot,
    path: string,
    summary: ImportManifestSummary,
    rowLines: AsyncIterable<string>,
    expectedFinal?: Pick<FileFacts, "dev" | "ino">,
  ): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: FileHandle | undefined;
    try {
      await this.#verifyRoot(root, summary.manifestId);
      handle = await open(temporary, CREATE_EXCLUSIVE_NOFOLLOW, 0o600);
      await handle.writeFile(encodeCanonicalJson(summary as unknown as JsonObject));
      let count = 0;
      for await (const line of rowLines) {
        const row = parsePlannedRowLine(line);
        await handle.writeFile(encodeCanonicalJson(row as unknown as JsonObject));
        count += 1;
      }
      if (count !== summary.rowCount) {
        throw new PubkyShopError("manifest_store_error", { manifestId: summary.manifestId });
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#installFinal(root, path, temporary, summary.manifestId, expectedFinal);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw this.#storeError(error, summary.manifestId);
    }
  }

  async #installFinal(
    root: PinnedRoot,
    path: string,
    temporary: string,
    manifestId: string,
    expectedFinal?: Pick<FileFacts, "dev" | "ino">,
  ): Promise<void> {
    await this.#verifyRoot(root, manifestId);
    const final = await this.#lstatFinal(path);
    if (
      (expectedFinal === undefined && final !== null) ||
      (expectedFinal !== undefined && (final === null || !sameFile(final, expectedFinal)))
    ) {
      throw new PubkyShopError("manifest_conflict", { manifestId });
    }
    await rename(temporary, path);
    await this.#verifyRoot(root, manifestId);
    await this.#syncRoot(root);
  }

  async #replaceFinal(root: PinnedRoot, path: string, temporary: string): Promise<void> {
    const current = await this.#lstatFinal(path);
    if (current === null) {
      throw new PubkyShopError("manifest_store_error");
    }
    await this.#installFinal(root, path, temporary, "quarantine-compaction", current);
  }

  async #syncRoot(root: PinnedRoot): Promise<void> {
    const directory = await open(root.path, READ_NOFOLLOW);
    try {
      const facts = await directory.stat();
      if (!facts.isDirectory() || !sameFile(facts, root)) {
        throw new PubkyShopError("manifest_store_error");
      }
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async #persistConflictSpool(
    root: PinnedRoot,
    record: ReplayQuarantineRecord,
    conflictsPath: string,
  ): Promise<void> {
    const finalPath = this.#conflictPath(
      root,
      record.manifestId,
      record.quarantineVersion,
      record.identityHash,
    );
    const existing = await this.#lstatFinal(finalPath);
    if (existing !== null) {
      await this.#validateConflictFile(finalPath, record);
      return;
    }
    const temporary = `${finalPath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, CREATE_EXCLUSIVE_NOFOLLOW, 0o600);
      const hash = createHash("sha256");
      let count = 0;
      for await (const line of readBoundedLines(conflictsPath, CONFLICT_LINE_BYTES)) {
        const conflict = parseConflictLine(line);
        const encoded = encodeCanonicalJson(conflict as unknown as JsonObject);
        hash.update(encoded);
        await handle.writeFile(encoded);
        count += 1;
      }
      if (count !== record.conflictCount || hash.digest("hex") !== record.conflictHash) {
        throw new PubkyShopError("manifest_store_error", { manifestId: record.manifestId });
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#installFinal(root, finalPath, temporary, record.manifestId);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async #removeConflictVersionsAfter(
    root: PinnedRoot,
    manifestId: string,
    maximumVersion: number,
  ): Promise<void> {
    const conflictPrefix = `${manifestId}.replay-conflicts.`;
    const directory = await opendir(root.path);
    for await (const entry of directory) {
      if (entry.name.startsWith("._") || !entry.name.startsWith(conflictPrefix)) {
        continue;
      }
      const match = /^[A-Za-z0-9_.-]{1,128}\.replay-conflicts\.(\d+)\.[0-9a-f]{64}\.jsonl$/.exec(
        entry.name,
      );
      if (match === null || Number(match[1]) <= maximumVersion) {
        continue;
      }
      const orphan = join(root.path, entry.name);
      const observed = await lstat(orphan);
      if (!observed.isFile() || observed.isSymbolicLink() || (observed.mode & 0o077) !== 0) {
        throw new PubkyShopError("manifest_store_error", { manifestId });
      }
      await this.#verifyRoot(root, manifestId);
      await this.#unlinkObserved(orphan, observed);
      await this.#verifyRoot(root, manifestId);
    }
  }

  async #validateConflictFile(path: string, record: ReplayQuarantineRecord): Promise<void> {
    const handle = await this.#openValidatedRead(path);
    try {
      const hash = createHash("sha256");
      let count = 0;
      for await (const line of readHandleLines(handle, CONFLICT_LINE_BYTES)) {
        const conflict = parseConflictLine(line);
        hash.update(encodeCanonicalJson(conflict as unknown as JsonObject));
        count += 1;
      }
      if (count !== record.conflictCount || hash.digest("hex") !== record.conflictHash) {
        throw new PubkyShopError("manifest_store_error", { manifestId: record.manifestId });
      }
    } finally {
      await handle.close();
    }
  }

  async #appendQuarantine(root: PinnedRoot, record: ReplayQuarantineRecord): Promise<void> {
    const path = this.#quarantinePath(root, record.manifestId);
    await this.#verifyRoot(root, record.manifestId);
    let handle: FileHandle;
    try {
      handle = await open(path, APPEND_CREATE_EXCLUSIVE_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      handle = await open(path, APPEND_NOFOLLOW);
    }
    try {
      const facts = await handle.stat();
      if (!secureFile(facts)) {
        throw new PubkyShopError("manifest_store_error", { manifestId: record.manifestId });
      }
      const encoded = encodeCanonicalJson(record as unknown as JsonObject);
      if (encoded.byteLength > QUARANTINE_LINE_BYTES + 1) {
        throw new PubkyShopError("manifest_store_error", { manifestId: record.manifestId });
      }
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.#verifyRoot(root, record.manifestId);
    await this.#syncRoot(root);
  }

  #storeError(error: unknown, manifestId: string): PubkyShopError {
    return error instanceof PubkyShopError
      ? error
      : new PubkyShopError("manifest_store_error", { manifestId });
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

function replayQuarantineIdentity(
  manifestVersion: number,
  replaySourceSha256: string,
  conflictHash: string,
): string {
  return createHash("sha256")
    .update(IMPORT_SCHEMA_VERSION)
    .update("\0")
    .update(String(manifestVersion))
    .update("\0")
    .update(replaySourceSha256)
    .update("\0")
    .update(conflictHash)
    .digest("hex");
}

function uuidFromHash(hash: string): string {
  const bytes = Buffer.from(hash, "hex").subarray(0, 16);
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

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function unbase64(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function indexLine(kind: "H" | "L" | "S" | "V", key: string, value: string, row: number): string {
  return `${kind}\t${base64(key)}\t${base64(value)}\t${String(row).padStart(16, "0")}`;
}

function splitSpoolLine(line: string, fields: number): readonly string[] {
  const parts = line.split("\t");
  if (parts.length !== fields) {
    throw new PubkyShopError("manifest_store_error");
  }
  return parts;
}

async function validateIdentityIndex(path: string, maxLineBytes: number): Promise<void> {
  let priorKind = "";
  let priorKey = "";
  let priorValue = "";
  for await (const line of readBoundedLines(path, maxLineBytes)) {
    const [kind, encodedKey, encodedValue, rowText] = splitSpoolLine(line, 4);
    if (
      kind === undefined ||
      encodedKey === undefined ||
      encodedValue === undefined ||
      rowText === undefined
    ) {
      throw new PubkyShopError("manifest_store_error");
    }
    const key = unbase64(encodedKey);
    const value = unbase64(encodedValue);
    const sourceRow = Number(rowText);
    if (!Number.isSafeInteger(sourceRow) || sourceRow < 2) {
      throw new PubkyShopError("manifest_store_error");
    }
    if (kind === priorKind && key === priorKey) {
      if (kind === "H") {
        throw new PubkyShopError("duplicate_row", { sourceRow });
      }
      if (kind === "V") {
        throw new PubkyShopError("duplicate_variant_id", { sourceRow });
      }
      if (kind === "S" && value !== priorValue) {
        throw new PubkyShopError("ambiguous_sku", { sourceRow });
      }
      if (kind === "L" && value !== priorValue) {
        throw new PubkyShopError("conflicting_listing_fields", { sourceRow });
      }
    }
    priorKind = kind;
    priorKey = key;
    priorValue = value;
  }
}

function decodeCanonicalRow(line: string, maxCanonicalJsonBytes: number): CanonicalCsvRow {
  const [, , , , encoded] = splitSpoolLine(line, 5);
  if (encoded === undefined) {
    throw new PubkyShopError("manifest_store_error");
  }
  const value = parseBoundedJson(unbase64(encoded), {
    maxBytes: maxCanonicalJsonBytes,
    maxDepth: 64,
    maxNodes: 250_000,
    maxStringBytes: maxCanonicalJsonBytes,
  });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PubkyShopError("manifest_store_error");
  }
  return value as unknown as CanonicalCsvRow;
}

interface InternalPlanCaps {
  readonly maxRows?: number;
}

async function planImportStreamInternal(
  source: CsvByteSource,
  options: PlanImportOptions,
  caps: InternalPlanCaps = {},
): Promise<SdkResult<PlannedImportStream>> {
  const manifestId = options.manifestId ?? randomUUID();
  if (!validManifestId(manifestId)) {
    return err(new PubkyShopError("invalid_identity", { field: "manifestId" }));
  }
  let workspace: PlanningWorkspace | undefined;
  try {
    workspace = await options.store.createPlanningWorkspace(manifestId);
    await workspace.verify();
    const rawRowsPath = join(workspace.directory, "canonical-rows.spool");
    const identityIndexPath = join(workspace.directory, "identity-index.spool");
    const streamLimits = {
      maxRowBytes: options.limits?.maxRowBytes ?? 8 * 1024 * 1024,
      maxWorkingSetBytes: options.limits?.maxWorkingSetBytes ?? 64 * 1024 * 1024,
    };
    const sortStems = ["identity-index", "canonical-rows", "generated-index"] as const;
    let maxSpoolLineBytes = Number.POSITIVE_INFINITY;
    for (const stem of sortStems) {
      maxSpoolLineBytes = Math.min(
        maxSpoolLineBytes,
        maximumExternalSortLineBytes(streamLimits.maxWorkingSetBytes, workspace.directory, stem),
      );
    }
    if (maxSpoolLineBytes < 1024) {
      throw new PubkyShopError("invalid_configuration", {
        field: "maxWorkingSetBytes",
      });
    }
    const maxCanonicalJsonBytes = Math.max(1, Math.floor((maxSpoolLineBytes - 16 * 1024) * 0.72));
    const maxGeneratedLineBytes = Math.min(16 * 1024, maxSpoolLineBytes);
    const rawRows = await open(rawRowsPath, "wx", 0o600);
    const identityIndex = await open(identityIndexPath, "wx", 0o600);
    let peakPlannerBufferedBytes = 0;
    let peakPlannerMetadataBytes = 0;
    let peakPlannerOpenFiles = 2;
    let boundedRowCount = 0;
    let parsed: Awaited<ReturnType<typeof parseCanonicalCsvStream>> | undefined;
    try {
      parsed = await parseCanonicalCsvStream(
        source,
        async (row) => {
          boundedRowCount += 1;
          const normalizedHash = normalizedCsvRowHash(row);
          const identity = listingIdentity(row);
          const variantIdentity = `${identity}#${row.variantId}`;
          const rowJson = canonicalJson(row as unknown as JsonObject);
          if (Buffer.byteLength(rowJson) > maxCanonicalJsonBytes) {
            throw new PubkyShopError("limit_exceeded", {
              field: "planner_canonical_row_bytes",
              limit: maxCanonicalJsonBytes,
              observed: maxCanonicalJsonBytes + 1,
              ...(row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow }),
            });
          }
          const rawLine = `${base64(identity)}\t${base64(row.variantId)}\t${base64(
            row.sku,
          )}\t${base64(normalizedHash)}\t${base64(rowJson)}`;
          const sourceRow = row.sourceRow ?? 0;
          const lines = [
            indexLine("H", normalizedHash, variantIdentity, sourceRow),
            indexLine("V", variantIdentity, normalizedHash, sourceRow),
            indexLine("L", identity, normalizedListingFactsHash(row), sourceRow),
            ...(row.sku === "" ? [] : [indexLine("S", row.sku, variantIdentity, sourceRow)]),
          ];
          if (
            Buffer.byteLength(rawLine) > maxSpoolLineBytes ||
            lines.some((line) => Buffer.byteLength(line) > maxSpoolLineBytes)
          ) {
            throw new PubkyShopError("limit_exceeded", {
              field: "planner_external_line_bytes",
              limit: maxSpoolLineBytes,
              observed: maxSpoolLineBytes + 1,
              sourceRow,
            });
          }
          const charged =
            Buffer.byteLength(rawLine) * 2 +
            lines.reduce((sum, item) => sum + Buffer.byteLength(item) * 2, 0);
          peakPlannerBufferedBytes = Math.max(peakPlannerBufferedBytes, charged);
          const maximum = options.limits?.maxWorkingSetBytes ?? 64 * 1024 * 1024;
          if (charged > maximum) {
            throw new PubkyShopError("limit_exceeded", {
              field: "planner_working_set_bytes",
              limit: maximum,
              observed: Math.min(charged, maximum + 1),
              sourceRow,
            });
          }
          await rawRows.writeFile(`${rawLine}\n`);
          for (const item of lines) {
            await identityIndex.writeFile(`${item}\n`);
          }
          if (caps.maxRows !== undefined && boundedRowCount > caps.maxRows) {
            throw new PubkyShopError("limit_exceeded", {
              field: "csv_rows",
              limit: caps.maxRows,
              observed: caps.maxRows + 1,
              sourceRow,
            });
          }
        },
        options.limits,
      );
      await rawRows.sync();
      await identityIndex.sync();
    } finally {
      await rawRows.close();
      await identityIndex.close();
    }
    await workspace.verify();
    if (parsed === undefined) {
      throw new PubkyShopError("malformed_csv");
    }

    const identitySorted = await externalSortLines(
      identityIndexPath,
      workspace.directory,
      "identity-index",
      {
        maxLineBytes: maxSpoolLineBytes,
        maxWorkingSetBytes: streamLimits.maxWorkingSetBytes,
        ...(options.maxSortOpenFiles === undefined
          ? {}
          : { maxOpenFiles: options.maxSortOpenFiles }),
      },
    );
    await workspace.verify();
    peakPlannerBufferedBytes = Math.max(peakPlannerBufferedBytes, identitySorted.peakBufferedBytes);
    peakPlannerMetadataBytes = Math.max(peakPlannerMetadataBytes, identitySorted.peakMetadataBytes);
    peakPlannerOpenFiles = Math.max(peakPlannerOpenFiles, identitySorted.peakOpenFiles);
    await validateIdentityIndex(identitySorted.path, maxSpoolLineBytes);
    await workspace.verify();

    const canonicalSorted = await externalSortLines(
      rawRowsPath,
      workspace.directory,
      "canonical-rows",
      {
        maxLineBytes: maxSpoolLineBytes,
        maxWorkingSetBytes: streamLimits.maxWorkingSetBytes,
        ...(options.maxSortOpenFiles === undefined
          ? {}
          : { maxOpenFiles: options.maxSortOpenFiles }),
      },
    );
    await workspace.verify();
    peakPlannerBufferedBytes = Math.max(
      peakPlannerBufferedBytes,
      canonicalSorted.peakBufferedBytes,
    );
    peakPlannerMetadataBytes = Math.max(
      peakPlannerMetadataBytes,
      canonicalSorted.peakMetadataBytes,
    );
    peakPlannerOpenFiles = Math.max(peakPlannerOpenFiles, canonicalSorted.peakOpenFiles);

    const plannedPath = join(workspace.directory, "planned-rows.spool");
    const generatedIndexPath = join(workspace.directory, "generated-index.spool");
    const planned = await open(plannedPath, "wx", 0o600);
    const generatedIndex = await open(generatedIndexPath, "wx", 0o600);
    let priorListingIdentity = "";
    let generatedForListing: string | null = null;
    let rowCount = 0;
    try {
      for await (const line of readBoundedLines(canonicalSorted.path, maxSpoolLineBytes)) {
        const row = decodeCanonicalRow(line, maxCanonicalJsonBytes);
        const identity = listingIdentity(row);
        if (identity !== priorListingIdentity) {
          priorListingIdentity = identity;
          generatedForListing =
            row.recordUri === "" && row.listingId === ""
              ? (options.generateListingId ?? randomUUID)()
              : null;
          if (generatedForListing !== null) {
            if (!listingIdPattern.test(generatedForListing)) {
              throw new PubkyShopError("invalid_identity", {
                ...(row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow }),
              });
            }
            const generatedLine = `${base64(generatedForListing)}\t${base64(
              identity,
            )}\t${String(row.sourceRow ?? 0).padStart(16, "0")}`;
            if (Buffer.byteLength(generatedLine) > maxGeneratedLineBytes) {
              throw new PubkyShopError("limit_exceeded", {
                field: "planner_external_line_bytes",
                limit: maxGeneratedLineBytes,
                observed: maxGeneratedLineBytes + 1,
                ...(row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow }),
              });
            }
            await generatedIndex.writeFile(`${generatedLine}\n`);
          }
        }
        const normalizedHash = normalizedCsvRowHash(row);
        const rowIdentity = canonicalCsvRowIdentity(row);
        const intendedAction = actionFor(row, normalizedHash, options.currentItems ?? {});
        const plannedRow: PlannedImportRow = {
          sourceRow: row.sourceRow ?? 0,
          sourceIdentity: sourceIdentity(row),
          rowIdentity,
          normalizedHash,
          listingIdentity: identity,
          listingId: generatedForListing ?? row.listingId,
          generatedListingId: generatedForListing,
          variantId: row.variantId,
          sku: row.sku,
          intendedAction,
          idempotencyKey: deterministicIdempotencyKey(manifestId, rowIdentity, normalizedHash),
          checkpoint: intendedAction === "conflict" ? "conflict" : "planned",
        };
        const rendered = canonicalJson(plannedRow as unknown as JsonObject);
        peakPlannerBufferedBytes = Math.max(
          peakPlannerBufferedBytes,
          Buffer.byteLength(line) * 2 + Buffer.byteLength(rendered) * 2,
        );
        if (peakPlannerBufferedBytes > streamLimits.maxWorkingSetBytes) {
          throw new PubkyShopError("limit_exceeded", {
            field: "planner_working_set_bytes",
            limit: streamLimits.maxWorkingSetBytes,
            observed: streamLimits.maxWorkingSetBytes + 1,
            ...(row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow }),
          });
        }
        await planned.writeFile(`${rendered}\n`);
        rowCount += 1;
      }
      await planned.sync();
      await generatedIndex.sync();
    } finally {
      await planned.close();
      await generatedIndex.close();
    }
    await workspace.verify();

    const generatedSorted = await externalSortLines(
      generatedIndexPath,
      workspace.directory,
      "generated-index",
      {
        maxLineBytes: maxGeneratedLineBytes,
        maxWorkingSetBytes: streamLimits.maxWorkingSetBytes,
        ...(options.maxSortOpenFiles === undefined
          ? {}
          : { maxOpenFiles: options.maxSortOpenFiles }),
      },
    );
    await workspace.verify();
    peakPlannerBufferedBytes = Math.max(
      peakPlannerBufferedBytes,
      generatedSorted.peakBufferedBytes,
    );
    peakPlannerMetadataBytes = Math.max(
      peakPlannerMetadataBytes,
      generatedSorted.peakMetadataBytes,
    );
    peakPlannerOpenFiles = Math.max(peakPlannerOpenFiles, generatedSorted.peakOpenFiles);
    let priorGenerated = "";
    let priorGeneratedListing = "";
    for await (const line of readBoundedLines(generatedSorted.path, maxGeneratedLineBytes)) {
      const [encodedId, encodedListing, sourceRowText] = splitSpoolLine(line, 3);
      if (encodedId === undefined || encodedListing === undefined || sourceRowText === undefined) {
        throw new PubkyShopError("manifest_store_error");
      }
      const generated = unbase64(encodedId);
      const listing = unbase64(encodedListing);
      if (
        generated === priorGenerated &&
        priorGeneratedListing !== "" &&
        listing !== priorGeneratedListing
      ) {
        throw new PubkyShopError("invalid_identity", {
          sourceRow: Number(sourceRowText),
        });
      }
      priorGenerated = generated;
      priorGeneratedListing = listing;
    }
    await workspace.verify();

    const summary: ImportManifestSummary = {
      schemaVersion: 2,
      kind: "pubky-shop-import-manifest",
      manifestId,
      manifestVersion: 1,
      sourceSha256: parsed.sourceSha256,
      sourceByteLength: parsed.resourceUsage.sourceBytes.toString(10),
      rowCount,
      parserVersion: IMPORT_PARSER_VERSION,
      mappingVersion: IMPORT_MAPPING_VERSION,
      recordSchemaVersion: IMPORT_SCHEMA_VERSION,
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
    };
    await options.store.createFromRowSpool(summary, plannedPath);
    return ok({
      manifest: summary,
      resourceUsage: {
        sourceBytes: parsed.resourceUsage.sourceBytes,
        rowCount,
        peakParserBufferedBytes: parsed.resourceUsage.peakParserBufferedBytes,
        peakPlannerBufferedBytes,
        peakPlannerMetadataBytes,
        peakPlannerOpenFiles,
        maxPlannerOpenFiles: options.maxSortOpenFiles ?? DEFAULT_EXTERNAL_SORT_MAX_OPEN_FILES,
        maxWorkingSetBytes: streamLimits.maxWorkingSetBytes,
      },
    });
  } catch (error) {
    return err(
      error instanceof PubkyShopError
        ? error
        : new PubkyShopError("manifest_store_error", { manifestId }),
    );
  } finally {
    await workspace?.cleanup().catch(() => undefined);
  }
}

/**
 * Compliant import path: source bytes and rows are streamed into a durable
 * store-local spool, externally grouped/validated, and only then atomically
 * committed as a manifest. Total source bytes and row count have no fixed cap.
 */
export async function planImportStream(
  source: CsvByteSource,
  options: PlanImportOptions,
): Promise<SdkResult<PlannedImportStream>> {
  return planImportStreamInternal(source, options);
}

/**
 * Bounded byte-array convenience API. It delegates to the streaming planner,
 * then materializes the bounded committed manifest for legacy callers.
 */
export async function planImport(
  csvBytes: Uint8Array,
  options: PlanImportOptions,
): Promise<SdkResult<ImportManifest>> {
  if (csvBytes.byteLength > 64 * 1024 * 1024) {
    return err(
      new PubkyShopError("limit_exceeded", {
        field: "csv_bytes",
        limit: 64 * 1024 * 1024,
        observed: 64 * 1024 * 1024 + 1,
      }),
    );
  }
  const planned = await planImportStreamInternal([csvBytes], options, { maxRows: 100_000 });
  if (!planned.ok) {
    return planned;
  }
  try {
    const manifest = await options.store.load(planned.value.manifest.manifestId);
    return manifest === null ? err(new PubkyShopError("manifest_store_error")) : ok(manifest);
  } catch (error) {
    return err(
      error instanceof PubkyShopError
        ? error
        : new PubkyShopError("manifest_store_error", {
            manifestId: planned.value.manifest.manifestId,
          }),
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
  store: StreamingManifestStore,
  manifestId: string,
  expectedManifestVersion: number,
  rowIdentity: string,
  checkpoint: ImportCheckpoint,
  failureCode?: ErrorCode,
): Promise<SdkResult<CheckpointImportResult>> {
  try {
    return ok(
      await store.checkpointRow(
        manifestId,
        expectedManifestVersion,
        rowIdentity,
        checkpoint,
        failureCode,
      ),
    );
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

export async function* streamResumeTasks(
  store: StreamingManifestStore,
  manifestId: string,
): AsyncGenerator<ResumeTask> {
  for await (const row of store.streamRows(manifestId)) {
    yield {
      rowIdentity: row.rowIdentity,
      next:
        row.checkpoint === "planned"
          ? "publish"
          : row.checkpoint === "publishing"
            ? "reconcile_publish"
            : row.checkpoint === "published_unsynced"
              ? "sync_service"
              : "none",
    };
  }
}

export interface ReplayImportOptions {
  readonly limits?: Partial<CsvStreamLimits>;
  readonly now?: () => Date;
  readonly maxSortOpenFiles?: number;
}

export interface ReplayResourceUsage {
  readonly rowCount: number;
  readonly conflictCount: number;
  readonly peakParserBufferedBytes: number;
  readonly peakPlannerBufferedBytes: number;
  readonly peakPlannerMetadataBytes: number;
  readonly peakPlannerOpenFiles: number;
  readonly maxPlannerOpenFiles: number;
  readonly maxWorkingSetBytes: number;
}

export type ImportReplayResult =
  | {
      readonly kind: "same";
      readonly manifest: ImportManifestSummary;
      readonly resourceUsage: ReplayResourceUsage;
    }
  | {
      readonly kind: "quarantined";
      readonly manifest: ImportManifestSummary;
      readonly conflictCount: number;
      readonly quarantine: ReplayQuarantineRecord;
      readonly resourceUsage: ReplayResourceUsage;
    };

function replayIndexLine(rowIdentity: string, hash: string, sourceRow: number): string {
  return `${base64(rowIdentity)}\t${hash}\t${String(sourceRow).padStart(16, "0")}`;
}

function parseReplayIndexLine(line: string): {
  readonly rowIdentity: string;
  readonly hash: string;
  readonly sourceRow: number;
} {
  const [encodedIdentity, hash, sourceRowText] = splitSpoolLine(line, 3);
  if (
    encodedIdentity === undefined ||
    hash === undefined ||
    sourceRowText === undefined ||
    !hashPattern.test(hash)
  ) {
    throw new PubkyShopError("manifest_store_error");
  }
  const rowIdentity = unbase64(encodedIdentity);
  const sourceRow = Number(sourceRowText);
  if (
    rowIdentity.length < 1 ||
    rowIdentity.length > 2048 ||
    !Number.isSafeInteger(sourceRow) ||
    sourceRow < 2
  ) {
    throw new PubkyShopError("manifest_store_error");
  }
  return { rowIdentity, hash, sourceRow };
}

export async function replayImport(
  store: StreamingManifestStore,
  manifestId: string,
  source: CsvByteSource | Uint8Array,
  options: ReplayImportOptions = {},
): Promise<SdkResult<ImportReplayResult>> {
  let summary: ImportManifestSummary | null;
  try {
    summary = await store.loadSummary(manifestId);
  } catch (error) {
    return err(
      error instanceof PubkyShopError
        ? error
        : new PubkyShopError("manifest_store_error", { manifestId }),
    );
  }
  if (summary === null) {
    return err(new PubkyShopError("manifest_conflict", { manifestId }));
  }

  let workspace: PlanningWorkspace | undefined;
  try {
    workspace = await store.createPlanningWorkspace(manifestId);
    await workspace.verify();
    const replayRowsPath = join(workspace.directory, "replay-rows.spool");
    const replayIdentityPath = join(workspace.directory, "replay-identity.spool");
    const manifestRowsPath = join(workspace.directory, "manifest-rows.spool");
    const conflictsPath = join(workspace.directory, "replay-conflicts.spool");
    const limits = {
      maxWorkingSetBytes: options.limits?.maxWorkingSetBytes ?? 64 * 1024 * 1024,
    };
    const maxLineBytes = Math.min(
      maximumExternalSortLineBytes(limits.maxWorkingSetBytes, workspace.directory, "replay-rows"),
      maximumExternalSortLineBytes(
        limits.maxWorkingSetBytes,
        workspace.directory,
        "replay-identity",
      ),
      maximumExternalSortLineBytes(limits.maxWorkingSetBytes, workspace.directory, "manifest-rows"),
    );
    if (maxLineBytes < 4096) {
      throw new PubkyShopError("invalid_configuration", {
        field: "maxWorkingSetBytes",
      });
    }

    const replayRows = await open(replayRowsPath, "wx", 0o600);
    const replayIdentity = await open(replayIdentityPath, "wx", 0o600);
    let parsed: Awaited<ReturnType<typeof parseCanonicalCsvStream>>;
    try {
      parsed = await parseCanonicalCsvStream(
        source instanceof Uint8Array ? [source] : source,
        async (row) => {
          const identity = listingIdentity(row);
          const rowIdentity = canonicalCsvRowIdentity(row);
          const variantIdentity = `${identity}#${row.variantId}`;
          const sourceRow = row.sourceRow ?? 0;
          const index = replayIndexLine(rowIdentity, normalizedCsvRowHash(row), sourceRow);
          const identityLines = [
            indexLine("H", normalizedCsvRowHash(row), variantIdentity, sourceRow),
            indexLine("V", variantIdentity, normalizedCsvRowHash(row), sourceRow),
            indexLine("L", identity, normalizedListingFactsHash(row), sourceRow),
            ...(row.sku === "" ? [] : [indexLine("S", row.sku, variantIdentity, sourceRow)]),
          ];
          if (
            Buffer.byteLength(index) > maxLineBytes ||
            identityLines.some((line) => Buffer.byteLength(line) > maxLineBytes)
          ) {
            throw new PubkyShopError("limit_exceeded", {
              field: "planner_external_line_bytes",
              limit: maxLineBytes,
              observed: maxLineBytes + 1,
              sourceRow,
            });
          }
          await replayRows.writeFile(`${index}\n`);
          for (const line of identityLines) {
            await replayIdentity.writeFile(`${line}\n`);
          }
        },
        options.limits,
      );
      await replayRows.sync();
      await replayIdentity.sync();
    } finally {
      await replayRows.close();
      await replayIdentity.close();
    }
    await workspace.verify();

    const replayIdentitySorted = await externalSortLines(
      replayIdentityPath,
      workspace.directory,
      "replay-identity",
      {
        maxLineBytes,
        maxWorkingSetBytes: limits.maxWorkingSetBytes,
        ...(options.maxSortOpenFiles === undefined
          ? {}
          : { maxOpenFiles: options.maxSortOpenFiles }),
      },
    );
    await workspace.verify();
    await validateIdentityIndex(replayIdentitySorted.path, maxLineBytes);
    await workspace.verify();
    const replaySorted = await externalSortLines(
      replayRowsPath,
      workspace.directory,
      "replay-rows",
      {
        maxLineBytes,
        maxWorkingSetBytes: limits.maxWorkingSetBytes,
        ...(options.maxSortOpenFiles === undefined
          ? {}
          : { maxOpenFiles: options.maxSortOpenFiles }),
      },
    );
    await workspace.verify();

    const manifestRows = await open(manifestRowsPath, "wx", 0o600);
    try {
      for await (const row of store.streamRows(manifestId)) {
        await manifestRows.writeFile(
          `${replayIndexLine(row.rowIdentity, row.normalizedHash, row.sourceRow)}\n`,
        );
      }
      await manifestRows.sync();
    } finally {
      await manifestRows.close();
    }
    await workspace.verify();
    const manifestSorted = await externalSortLines(
      manifestRowsPath,
      workspace.directory,
      "manifest-rows",
      {
        maxLineBytes,
        maxWorkingSetBytes: limits.maxWorkingSetBytes,
        ...(options.maxSortOpenFiles === undefined
          ? {}
          : { maxOpenFiles: options.maxSortOpenFiles }),
      },
    );
    await workspace.verify();

    const replayIterator = readBoundedLines(replaySorted.path, maxLineBytes)[
      Symbol.asyncIterator
    ]();
    const manifestIterator = readBoundedLines(manifestSorted.path, maxLineBytes)[
      Symbol.asyncIterator
    ]();
    let replayItem = await replayIterator.next();
    let manifestItem = await manifestIterator.next();
    const conflictOutput = await open(conflictsPath, "wx", 0o600);
    const conflictHash = createHash("sha256");
    let conflictCount = 0;
    try {
      while (!replayItem.done || !manifestItem.done) {
        const replay =
          replayItem.done === false ? parseReplayIndexLine(replayItem.value) : undefined;
        const existing =
          manifestItem.done === false ? parseReplayIndexLine(manifestItem.value) : undefined;
        let conflict: ReplayConflictRow;
        if (
          existing === undefined ||
          (replay !== undefined && replay.rowIdentity < existing.rowIdentity)
        ) {
          conflict = {
            rowIdentity: replay?.rowIdentity ?? "",
            sourceRow: replay?.sourceRow ?? 2,
            reason: "not_in_manifest",
          };
          replayItem = await replayIterator.next();
        } else if (replay === undefined || existing.rowIdentity < replay.rowIdentity) {
          conflict = {
            rowIdentity: existing.rowIdentity,
            sourceRow: existing.sourceRow,
            reason: "missing_from_replay",
          };
          manifestItem = await manifestIterator.next();
        } else {
          if (replay.hash === existing.hash) {
            replayItem = await replayIterator.next();
            manifestItem = await manifestIterator.next();
            continue;
          }
          conflict = {
            rowIdentity: replay.rowIdentity,
            sourceRow: replay.sourceRow,
            reason: "changed_hash",
          };
          replayItem = await replayIterator.next();
          manifestItem = await manifestIterator.next();
        }
        const encoded = encodeCanonicalJson(conflict as unknown as JsonObject);
        if (encoded.byteLength > CONFLICT_LINE_BYTES + 1) {
          throw new PubkyShopError("manifest_store_error", { manifestId });
        }
        conflictHash.update(encoded);
        await conflictOutput.writeFile(encoded);
        conflictCount += 1;
      }
      await conflictOutput.sync();
    } finally {
      await conflictOutput.close();
      await replayIterator.return?.(undefined);
      await manifestIterator.return?.(undefined);
    }
    await workspace.verify();

    const peakPlannerBufferedBytes = Math.max(
      replayIdentitySorted.peakBufferedBytes,
      replaySorted.peakBufferedBytes,
      manifestSorted.peakBufferedBytes,
    );
    const peakPlannerMetadataBytes = Math.max(
      replayIdentitySorted.peakMetadataBytes,
      replaySorted.peakMetadataBytes,
      manifestSorted.peakMetadataBytes,
    );
    const peakPlannerOpenFiles = Math.max(
      replayIdentitySorted.peakOpenFiles,
      replaySorted.peakOpenFiles,
      manifestSorted.peakOpenFiles,
      2,
    );
    const resourceUsage: ReplayResourceUsage = {
      rowCount: parsed.resourceUsage.rowCount,
      conflictCount,
      peakParserBufferedBytes: parsed.resourceUsage.peakParserBufferedBytes,
      peakPlannerBufferedBytes,
      peakPlannerMetadataBytes,
      peakPlannerOpenFiles,
      maxPlannerOpenFiles: options.maxSortOpenFiles ?? DEFAULT_EXTERNAL_SORT_MAX_OPEN_FILES,
      maxWorkingSetBytes: limits.maxWorkingSetBytes,
    };

    if (conflictCount === 0) {
      return ok({ kind: "same", manifest: summary, resourceUsage });
    }
    const renderedConflictHash = conflictHash.digest("hex");
    const identityHash = replayQuarantineIdentity(
      summary.manifestVersion,
      parsed.sourceSha256,
      renderedConflictHash,
    );
    const quarantine = await store.compareAndAppendReplayQuarantine(
      manifestId,
      summary.manifestVersion,
      {
        schemaVersion: 2,
        kind: "pubky-shop-replay-quarantine",
        quarantineId: uuidFromHash(identityHash),
        manifestId,
        manifestVersion: summary.manifestVersion,
        replaySourceSha256: parsed.sourceSha256,
        conflictHash: renderedConflictHash,
        identityHash,
        conflictCount,
        recordedAt: (options.now ?? (() => new Date()))().toISOString(),
      },
      conflictsPath,
    );
    return ok({
      kind: "quarantined",
      manifest: summary,
      conflictCount,
      quarantine,
      resourceUsage,
    });
  } catch (error) {
    return err(
      error instanceof PubkyShopError
        ? error
        : new PubkyShopError("manifest_store_error", { manifestId }),
    );
  } finally {
    await workspace?.cleanup().catch(() => undefined);
  }
}
