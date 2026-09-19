import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  type CanonicalCsvRow,
  type CsvByteSource,
  type CsvStreamLimits,
  type ParsedCanonicalCsv,
  canonicalCsvRowIdentity,
  listingIdentity,
  normalizedListingFactsHash,
  normalizedCsvRowHash,
  parseCanonicalCsv,
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
import { externalSortLines, readBoundedLines } from "./external-sort.js";

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
}

export interface StreamingPlanResourceUsage {
  readonly sourceBytes: bigint;
  readonly rowCount: number;
  readonly peakParserBufferedBytes: number;
  readonly peakPlannerBufferedBytes: number;
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
  readonly schemaVersion: 1;
  readonly kind: "pubky-shop-replay-quarantine";
  readonly quarantineId: string;
  readonly quarantineVersion: number;
  readonly manifestId: string;
  readonly manifestVersion: number;
  readonly replaySourceSha256: string;
  readonly recordedAt: string;
  readonly conflicts: readonly ReplayConflictRow[];
}

export type ImportReplayResult =
  | { readonly kind: "same"; readonly manifest: ImportManifest }
  | {
      readonly kind: "quarantined";
      readonly manifest: ImportManifest;
      readonly conflicts: readonly ReplayConflictRow[];
      readonly quarantine: ReplayQuarantineRecord;
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

export interface PlanningWorkspace {
  readonly directory: string;
  cleanup(): Promise<void>;
}

export interface StreamingManifestStore extends ManifestStore {
  createPlanningWorkspace(manifestId: string): Promise<PlanningWorkspace>;
  createFromRowSpool(summary: ImportManifestSummary, rowsPath: string): Promise<void>;
  loadSummary(manifestId: string): Promise<ImportManifestSummary | null>;
  streamRows(manifestId: string): AsyncIterable<PlannedImportRow>;
  loadReplayQuarantines(manifestId: string): Promise<readonly ReplayQuarantineRecord[]>;
  compareAndAppendReplayQuarantine(
    manifestId: string,
    expectedManifestVersion: number,
    expectedQuarantineVersion: number,
    record: Omit<ReplayQuarantineRecord, "quarantineVersion">,
  ): Promise<ReplayQuarantineRecord>;
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
      "recordedAt",
      "conflicts",
    ]) ||
    value.schemaVersion !== 1 ||
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
    typeof value.recordedAt !== "string" ||
    Number.isNaN(Date.parse(value.recordedAt)) ||
    !Array.isArray(value.conflicts) ||
    value.conflicts.length < 1
  ) {
    throw new PubkyShopError("manifest_store_error");
  }
  const conflicts: ReplayConflictRow[] = value.conflicts.map((conflict) => {
    if (
      typeof conflict !== "object" ||
      conflict === null ||
      Array.isArray(conflict) ||
      !hasOnlyKeys(conflict, ["rowIdentity", "sourceRow", "reason"]) ||
      typeof conflict.rowIdentity !== "string" ||
      conflict.rowIdentity.length < 1 ||
      conflict.rowIdentity.length > 2048 ||
      typeof conflict.sourceRow !== "number" ||
      !Number.isSafeInteger(conflict.sourceRow) ||
      conflict.sourceRow < 2 ||
      !(
        conflict.reason === "changed_hash" ||
        conflict.reason === "missing_from_replay" ||
        conflict.reason === "not_in_manifest"
      )
    ) {
      throw new PubkyShopError("manifest_store_error");
    }
    return { ...conflict } as unknown as ReplayConflictRow;
  });
  return { ...(value as unknown as ReplayQuarantineRecord), conflicts };
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
export class FileManifestStore implements StreamingManifestStore {
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
      const summary = await this.loadSummary(manifestId);
      if (summary === null) {
        return null;
      }
      if (summary.rowCount > 100_000) {
        throw new PubkyShopError("limit_exceeded", {
          field: "manifest_materialized_rows",
          limit: 100_000,
          observed: 100_001,
          manifestId,
        });
      }
      const rows: PlannedImportRow[] = [];
      let charged = 0;
      for await (const row of this.streamRows(manifestId)) {
        charged += Buffer.byteLength(JSON.stringify(row));
        if (charged > 64 * 1024 * 1024) {
          throw new PubkyShopError("limit_exceeded", {
            field: "manifest_materialized_bytes",
            limit: 64 * 1024 * 1024,
            observed: 64 * 1024 * 1024 + 1,
            manifestId,
          });
        }
        rows.push(row);
      }
      return parseManifestValue({
        ...summary,
        rows: rows as unknown as JsonValue[],
      } as unknown as JsonValue);
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

  async loadSummary(manifestId: string): Promise<ImportManifestSummary | null> {
    this.#validateId(manifestId);
    await this.#ensureSecureDirectory(manifestId);
    try {
      for await (const line of readBoundedLines(this.#path(manifestId), 64 * 1024)) {
        return parseSummaryLine(line);
      }
      throw new PubkyShopError("manifest_store_error", { manifestId });
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

  async *streamRows(manifestId: string): AsyncGenerator<PlannedImportRow> {
    this.#validateId(manifestId);
    await this.#ensureSecureDirectory(manifestId);
    let first = true;
    let expected = -1;
    let observed = 0;
    try {
      for await (const line of readBoundedLines(this.#path(manifestId), 64 * 1024)) {
        if (first) {
          expected = parseSummaryLine(line).rowCount;
          first = false;
          continue;
        }
        observed += 1;
        yield parsePlannedRowLine(line);
      }
      if (first || observed !== expected) {
        throw new PubkyShopError("manifest_store_error", { manifestId });
      }
    } catch (error) {
      if (error instanceof PubkyShopError) {
        throw error;
      }
      throw new PubkyShopError("manifest_store_error", { manifestId });
    }
  }

  async createPlanningWorkspace(manifestId: string): Promise<PlanningWorkspace> {
    this.#validateId(manifestId);
    await this.#ensureSecureDirectory(manifestId);
    const directory = join(
      this.#directory,
      `.${manifestId}.${process.pid}.${randomUUID()}.planning`,
    );
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch {
      throw new PubkyShopError("manifest_store_error", { manifestId });
    }
    return {
      directory,
      async cleanup() {
        await rm(directory, { recursive: true, force: true });
      },
    };
  }

  async createFromRowSpool(summary: ImportManifestSummary, rowsPath: string): Promise<void> {
    this.#validateId(summary.manifestId);
    parseManifestSummaryValue(summary as unknown as JsonValue);
    await this.#withLock(summary.manifestId, async () => {
      const path = this.#path(summary.manifestId);
      if (await fileExists(path)) {
        throw new PubkyShopError("manifest_conflict", {
          manifestId: summary.manifestId,
        });
      }
      await this.#atomicWriteFromLines(path, summary, readBoundedLines(rowsPath, 64 * 1024));
    });
  }

  async loadReplayQuarantines(manifestId: string): Promise<readonly ReplayQuarantineRecord[]> {
    this.#validateId(manifestId);
    await this.#ensureSecureDirectory(manifestId);
    const records: ReplayQuarantineRecord[] = [];
    try {
      for await (const line of readBoundedLines(
        this.#quarantinePath(manifestId),
        64 * 1024 * 1024,
      )) {
        const record = parseReplayQuarantineValue(
          parseBoundedJson(line, {
            maxBytes: 64 * 1024 * 1024,
            maxDepth: 8,
            maxNodes: 500_000,
            maxStringBytes: 4096,
          }),
        );
        if (record.manifestId !== manifestId || record.quarantineVersion !== records.length + 1) {
          throw new PubkyShopError("manifest_store_error", { manifestId });
        }
        records.push(record);
      }
      return Object.freeze(records);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return Object.freeze([]);
      }
      if (error instanceof PubkyShopError) {
        throw error;
      }
      throw new PubkyShopError("manifest_store_error", { manifestId });
    }
  }

  async compareAndAppendReplayQuarantine(
    manifestId: string,
    expectedManifestVersion: number,
    expectedQuarantineVersion: number,
    record: Omit<ReplayQuarantineRecord, "quarantineVersion">,
  ): Promise<ReplayQuarantineRecord> {
    this.#validateId(manifestId);
    if (
      !Number.isSafeInteger(expectedManifestVersion) ||
      expectedManifestVersion < 1 ||
      !Number.isSafeInteger(expectedQuarantineVersion) ||
      expectedQuarantineVersion < 0
    ) {
      throw new PubkyShopError("manifest_conflict", { manifestId });
    }
    return this.#withLock(manifestId, async () => {
      const summary = await this.loadSummary(manifestId);
      if (summary === null || summary.manifestVersion !== expectedManifestVersion) {
        throw new PubkyShopError("manifest_conflict", { manifestId });
      }
      const records = await this.loadReplayQuarantines(manifestId);
      if (records.length !== expectedQuarantineVersion) {
        throw new PubkyShopError("manifest_conflict", { manifestId });
      }
      const appended = parseReplayQuarantineValue({
        ...record,
        quarantineVersion: records.length + 1,
      } as unknown as JsonValue);
      if (
        appended.manifestId !== manifestId ||
        appended.manifestVersion !== expectedManifestVersion
      ) {
        throw new PubkyShopError("manifest_conflict", { manifestId });
      }
      await this.#atomicWriteQuarantines(this.#quarantinePath(manifestId), [...records, appended]);
      return appended;
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
    return join(this.#directory, `${manifestId}.manifest.jsonl`);
  }

  #quarantinePath(manifestId: string): string {
    return join(this.#directory, `${manifestId}.replay-quarantine.jsonl`);
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
    async function* rows(): AsyncGenerator<string> {
      for (const row of manifest.rows) {
        yield JSON.stringify(row);
      }
    }
    await this.#atomicWriteFromLines(path, summaryOf(manifest), rows());
  }

  async #atomicWriteFromLines(
    path: string,
    summary: ImportManifestSummary,
    rowLines: AsyncIterable<string>,
  ): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(encodeCanonicalJson(summary as unknown as JsonObject));
      let count = 0;
      for await (const line of rowLines) {
        const row = parsePlannedRowLine(line);
        await handle.writeFile(encodeCanonicalJson(row as unknown as JsonObject));
        count += 1;
      }
      if (count !== summary.rowCount) {
        throw new PubkyShopError("manifest_store_error", {
          manifestId: summary.manifestId,
        });
      }
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
        manifestId: summary.manifestId,
      });
    }
  }

  async #atomicWriteQuarantines(
    path: string,
    records: readonly ReplayQuarantineRecord[],
  ): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      for (const record of records) {
        parseReplayQuarantineValue(record as unknown as JsonValue);
        await handle.writeFile(encodeCanonicalJson(record as unknown as JsonObject));
      }
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
      throw new PubkyShopError("manifest_store_error");
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

function decodeCanonicalRow(line: string, maxRowBytes: number): CanonicalCsvRow {
  const [, , , , encoded] = splitSpoolLine(line, 5);
  if (encoded === undefined) {
    throw new PubkyShopError("manifest_store_error");
  }
  const value = parseBoundedJson(unbase64(encoded), {
    maxBytes: maxRowBytes * 2,
    maxDepth: 64,
    maxNodes: 250_000,
    maxStringBytes: maxRowBytes,
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
    const rawRowsPath = join(workspace.directory, "canonical-rows.spool");
    const identityIndexPath = join(workspace.directory, "identity-index.spool");
    const rawRows = await open(rawRowsPath, "wx", 0o600);
    const identityIndex = await open(identityIndexPath, "wx", 0o600);
    let peakPlannerBufferedBytes = 0;
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
    if (parsed === undefined) {
      throw new PubkyShopError("malformed_csv");
    }

    const streamLimits = {
      maxRowBytes: options.limits?.maxRowBytes ?? 8 * 1024 * 1024,
      maxWorkingSetBytes: options.limits?.maxWorkingSetBytes ?? 64 * 1024 * 1024,
    };
    const maxRawLineBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      streamLimits.maxRowBytes * 3 + 16 * 1024,
    );
    const identitySorted = await externalSortLines(
      identityIndexPath,
      workspace.directory,
      "identity-index",
      {
        maxLineBytes: maxRawLineBytes,
        maxWorkingSetBytes: streamLimits.maxWorkingSetBytes,
      },
    );
    peakPlannerBufferedBytes = Math.max(peakPlannerBufferedBytes, identitySorted.peakBufferedBytes);
    await validateIdentityIndex(identitySorted.path, maxRawLineBytes);

    const canonicalSorted = await externalSortLines(
      rawRowsPath,
      workspace.directory,
      "canonical-rows",
      {
        maxLineBytes: maxRawLineBytes,
        maxWorkingSetBytes: streamLimits.maxWorkingSetBytes,
      },
    );
    peakPlannerBufferedBytes = Math.max(
      peakPlannerBufferedBytes,
      canonicalSorted.peakBufferedBytes,
    );

    const plannedPath = join(workspace.directory, "planned-rows.spool");
    const generatedIndexPath = join(workspace.directory, "generated-index.spool");
    const planned = await open(plannedPath, "wx", 0o600);
    const generatedIndex = await open(generatedIndexPath, "wx", 0o600);
    let priorListingIdentity = "";
    let generatedForListing: string | null = null;
    let rowCount = 0;
    try {
      for await (const line of readBoundedLines(canonicalSorted.path, maxRawLineBytes)) {
        const row = decodeCanonicalRow(line, streamLimits.maxRowBytes);
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
            await generatedIndex.writeFile(
              `${base64(generatedForListing)}\t${base64(identity)}\t${String(
                row.sourceRow ?? 0,
              ).padStart(16, "0")}\n`,
            );
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

    const generatedSorted = await externalSortLines(
      generatedIndexPath,
      workspace.directory,
      "generated-index",
      {
        maxLineBytes: 16 * 1024,
        maxWorkingSetBytes: streamLimits.maxWorkingSetBytes,
      },
    );
    peakPlannerBufferedBytes = Math.max(
      peakPlannerBufferedBytes,
      generatedSorted.peakBufferedBytes,
    );
    let priorGenerated = "";
    let priorGeneratedListing = "";
    for await (const line of readBoundedLines(generatedSorted.path, 16 * 1024)) {
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
  store: StreamingManifestStore,
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
    const priorQuarantines = await store.loadReplayQuarantines(manifestId);
    const quarantine = await store.compareAndAppendReplayQuarantine(
      manifestId,
      existing.manifestVersion,
      priorQuarantines.length,
      {
        schemaVersion: 1,
        kind: "pubky-shop-replay-quarantine",
        quarantineId: randomUUID(),
        manifestId,
        manifestVersion: existing.manifestVersion,
        replaySourceSha256: parsed.sourceSha256,
        recordedAt: new Date().toISOString(),
        conflicts: Object.freeze(conflicts),
      },
    );
    return ok({
      kind: "quarantined",
      manifest: existing,
      conflicts: Object.freeze(conflicts),
      quarantine,
    });
  } catch (error) {
    return err(
      error instanceof PubkyShopError
        ? error
        : new PubkyShopError("manifest_store_error", { manifestId }),
    );
  }
}
