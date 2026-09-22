import { SYNC_MANY_LIMIT } from "./client.js";
import {
  type CanonicalCsvRow,
  type CsvByteSource,
  type CsvStreamLimits,
  DEFAULT_CSV_LIMITS,
  DEFAULT_CSV_STREAM_LIMITS,
  canonicalCsvRowIdentity,
  canonicalRowHashes,
  listingIdentity,
  parseCanonicalCsvStream,
} from "./csv.js";
import { ERROR_CODES, type ErrorCode, PubkyShopError, type SdkResult, err, ok } from "./errors.js";
import { createSha256 } from "./hash.js";
import {
  type JsonLimits,
  type JsonObject,
  type JsonValue,
  DEFAULT_JSON_LIMITS,
  canonicalJson,
  parseBoundedJson,
} from "./json.js";

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

export interface BrowserPlanImportOptions {
  readonly store: ManifestStore;
  readonly manifestId?: string;
  readonly now?: () => Date;
  readonly generateListingId?: () => string;
  readonly currentItems?: Readonly<Record<string, CurrentImportItem>>;
  readonly limits?: Partial<CsvStreamLimits> & {
    readonly maxBytes?: number;
    readonly maxRows?: number;
  };
}

export interface BrowserPlanResourceUsage {
  readonly sourceBytes: bigint;
  readonly rowCount: number;
  readonly peakParserBufferedBytes: number;
  readonly peakPlannerBufferedBytes: number;
  readonly maxWorkingSetBytes: number;
}

export interface PlannedBrowserImport {
  readonly manifest: ImportManifestSummary;
  readonly resourceUsage: BrowserPlanResourceUsage;
}

export interface CheckpointImportResult {
  readonly manifest: ImportManifestSummary;
  readonly row: PlannedImportRow;
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

export interface BrowserFileLike {
  readonly size: number;
  stream(): ReadableStream<Uint8Array>;
}

export interface SyncManyClassification {
  readonly listingId: string | null;
  readonly ok: boolean;
  readonly status: unknown;
  readonly message: string;
}

export type DryRunCounts = Readonly<Record<ImportAction, number>>;

const encoder = new TextEncoder();
const HEX = "0123456789abcdef";
const manifestIdPattern = /^[A-Za-z0-9_.-]{1,128}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const listingIdPattern = /^[A-Za-z0-9_.-]{1,128}$/;
const errorCodes = new Set<string>(ERROR_CODES);
const actions = new Set<string>(IMPORT_ACTIONS);

export const ALLOWED_CHECKPOINT_TRANSITIONS: Readonly<
  Record<ImportCheckpoint, readonly ImportCheckpoint[]>
> = {
  planned: ["publishing", "conflict", "failed"],
  publishing: ["published_unsynced", "conflict", "failed"],
  published_unsynced: ["complete", "conflict", "failed"],
  complete: [],
  conflict: [],
  failed: ["publishing", "conflict"],
};

function utf8Size(value: string): number {
  return encoder.encode(value).byteLength;
}

function validManifestId(value: string): boolean {
  return manifestIdPattern.test(value);
}

function randomId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj === undefined || typeof cryptoObj.randomUUID !== "function") {
    throw new PubkyShopError("invalid_configuration", { field: "crypto.randomUUID" });
  }
  return cryptoObj.randomUUID();
}

function hexFromBytes(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += HEX[(byte >> 4) & 0xf];
    text += HEX[byte & 0xf];
  }
  return text;
}

export function deterministicIdempotencyKey(
  manifestId: string,
  rowIdentity: string,
  normalizedHash: string,
): string {
  const hash = createSha256();
  hash.update(encoder.encode(IMPORT_SCHEMA_VERSION));
  hash.update(encoder.encode("\0"));
  hash.update(encoder.encode(manifestId));
  hash.update(encoder.encode("\0"));
  hash.update(encoder.encode(rowIdentity));
  hash.update(encoder.encode("\0"));
  hash.update(encoder.encode(normalizedHash));
  const digest = hash.digest();
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = hexFromBytes(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sourceIdentity(row: CanonicalCsvRow): string {
  return `${listingIdentity(row)}#variant:${row.variantId}`;
}

export function actionFor(
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

function resumeNext(checkpoint: ImportCheckpoint): ResumeTask["next"] {
  return checkpoint === "planned"
    ? "publish"
    : checkpoint === "publishing"
      ? "reconcile_publish"
      : checkpoint === "published_unsynced"
        ? "sync_service"
        : "none";
}

export function resumeTasks(manifest: ImportManifest): readonly ResumeTask[] {
  return manifest.rows.map((row) => ({
    rowIdentity: row.rowIdentity,
    next: resumeNext(row.checkpoint),
  }));
}

export async function* streamResumeTasks(
  store: ManifestStore,
  manifestId: string,
): AsyncGenerator<ResumeTask> {
  const manifest = await store.load(manifestId);
  if (manifest === null) {
    throw new PubkyShopError("manifest_store_error", { manifestId });
  }
  for (const task of resumeTasks(manifest)) {
    yield task;
  }
}

export function dryRunCounts(manifest: ImportManifest): DryRunCounts {
  const counts: Record<ImportAction, number> = {
    create: 0,
    update: 0,
    end: 0,
    unchanged: 0,
    conflict: 0,
  };
  for (const row of manifest.rows) {
    if (actions.has(row.intendedAction)) {
      counts[row.intendedAction] += 1;
    }
  }
  return counts;
}

export function chunkSyncManyListings<T>(items: readonly T[], limit = SYNC_MANY_LIMIT): T[][] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SYNC_MANY_LIMIT) {
    throw new PubkyShopError("invalid_configuration", { field: "sync_many_limit" });
  }
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += limit) {
    chunks.push(items.slice(offset, offset + limit));
  }
  return chunks;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function syncManyHttpOk(status: unknown): boolean {
  if (typeof status === "number") {
    return status >= 200 && status < 300;
  }
  if (typeof status === "bigint") {
    return status >= 200n && status < 300n;
  }
  if (typeof status === "string") {
    if (status === "success" || status === "ok") {
      return true;
    }
    const parsed = Number(status);
    return Number.isInteger(parsed) && parsed >= 200 && parsed < 300;
  }
  return false;
}

export function classifySyncManyItem(item: unknown): SyncManyClassification {
  const object = asObject(item);
  if (object === null) {
    return {
      listingId: null,
      ok: false,
      status: null,
      message: "The service returned an invalid sync result.",
    };
  }
  const listingId = asString(object.listing_id);
  const result = asObject(object.result);
  const error = asObject(result?.error) ?? asObject(object.error);
  const message =
    asString(error?.message) ??
    asString(object.message) ??
    "Published, not yet registered for checkout";
  if (syncManyHttpOk(object.status)) {
    return { listingId, ok: true, status: object.status, message: "Synced" };
  }
  return { listingId, ok: false, status: object.status, message };
}

export function browserFileSource(
  file: BrowserFileLike,
  maxBytes = DEFAULT_CSV_LIMITS.maxBytes,
): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    throw new PubkyShopError("invalid_configuration", { field: "file.size" });
  }
  if (file.size > maxBytes) {
    throw new PubkyShopError("limit_exceeded", {
      field: "csv_bytes",
      limit: maxBytes,
      observed: Math.min(file.size, maxBytes + 1),
    });
  }
  return file.stream();
}

class IdentityIndex {
  readonly #hashes = new Map<string, number>();
  readonly #variants = new Map<string, string>();
  readonly #listings = new Map<string, string>();
  readonly #skus = new Map<string, string>();
  #bytes = 0;

  get byteLength(): number {
    return this.#bytes;
  }

  add(
    row: CanonicalCsvRow,
    hashes: { readonly normalizedHash: string; readonly listingFactsHash: string },
  ): void {
    const sourceRow = row.sourceRow ?? 0;
    const identity = listingIdentity(row);
    const variantIdentity = `${identity}#${row.variantId}`;
    const { normalizedHash, listingFactsHash: facts } = hashes;
    const priorHash = this.#hashes.get(normalizedHash);
    if (priorHash !== undefined) {
      throw new PubkyShopError("duplicate_row", { sourceRow });
    }
    const priorVariant = this.#variants.get(variantIdentity);
    if (priorVariant !== undefined) {
      throw new PubkyShopError("duplicate_variant_id", { sourceRow });
    }
    const priorFacts = this.#listings.get(identity);
    if (priorFacts !== undefined && priorFacts !== facts) {
      throw new PubkyShopError("conflicting_listing_fields", { sourceRow });
    }
    if (row.sku !== "") {
      const priorSku = this.#skus.get(row.sku);
      if (priorSku !== undefined && priorSku !== variantIdentity) {
        throw new PubkyShopError("ambiguous_sku", { sourceRow });
      }
      this.#skus.set(row.sku, variantIdentity);
      this.#bytes += utf8Size(row.sku) + utf8Size(variantIdentity);
    }
    this.#hashes.set(normalizedHash, sourceRow);
    this.#variants.set(variantIdentity, normalizedHash);
    this.#listings.set(identity, facts);
    this.#bytes +=
      utf8Size(normalizedHash) +
      utf8Size(variantIdentity) +
      utf8Size(identity) +
      utf8Size(facts) +
      32;
  }
}

export class MemoryManifestStore implements ManifestStore {
  readonly #manifests = new Map<string, ImportManifest>();

  async create(manifest: ImportManifest): Promise<void> {
    if (this.#manifests.has(manifest.manifestId)) {
      throw new PubkyShopError("manifest_conflict", { manifestId: manifest.manifestId });
    }
    this.#manifests.set(manifest.manifestId, structuredClone(manifest));
  }

  async load(manifestId: string): Promise<ImportManifest | null> {
    const manifest = this.#manifests.get(manifestId);
    return manifest === undefined ? null : structuredClone(manifest);
  }

  async compareAndSwap(
    manifestId: string,
    expectedVersion: number,
    update: (manifest: ImportManifest) => ImportManifest,
  ): Promise<ImportManifest> {
    const current = this.#manifests.get(manifestId);
    if (current === undefined || current.manifestVersion !== expectedVersion) {
      throw new PubkyShopError("manifest_conflict", { manifestId });
    }
    const next = update(structuredClone(current));
    if (next.manifestId !== manifestId) {
      throw new PubkyShopError("manifest_store_error", { manifestId });
    }
    this.#manifests.set(manifestId, next);
    return structuredClone(next);
  }

  async checkpointRow(
    manifestId: string,
    expectedVersion: number,
    rowIdentity: string,
    checkpoint: ImportCheckpoint,
    failureCode?: ErrorCode,
  ): Promise<CheckpointImportResult> {
    const updated = await this.compareAndSwap(manifestId, expectedVersion, (manifest) => {
      const rows = manifest.rows.map((row) => {
        if (row.rowIdentity !== rowIdentity) {
          return row;
        }
        const allowed = ALLOWED_CHECKPOINT_TRANSITIONS[row.checkpoint];
        if (!allowed.includes(checkpoint)) {
          throw new PubkyShopError("manifest_store_error", { manifestId, rowIdentity });
        }
        if (failureCode !== undefined && !errorCodes.has(failureCode)) {
          throw new PubkyShopError("manifest_store_error", { manifestId, rowIdentity });
        }
        return failureCode === undefined
          ? { ...row, checkpoint }
          : { ...row, checkpoint, failureCode };
      });
      if (rows.every((row, index) => row === manifest.rows[index])) {
        throw new PubkyShopError("manifest_store_error", { manifestId, rowIdentity });
      }
      return {
        ...manifest,
        manifestVersion: manifest.manifestVersion + 1,
        rows,
      };
    });
    const row = updated.rows.find((item) => item.rowIdentity === rowIdentity);
    if (row === undefined) {
      throw new PubkyShopError("manifest_store_error", { manifestId, rowIdentity });
    }
    return { manifest: summaryOf(updated), row };
  }

  async *streamRows(manifestId: string): AsyncGenerator<PlannedImportRow> {
    const manifest = await this.load(manifestId);
    if (manifest === null) {
      throw new PubkyShopError("manifest_store_error", { manifestId });
    }
    for (const row of manifest.rows) {
      yield row;
    }
  }
}

export async function checkpointImportRow(
  store: MemoryManifestStore | ManifestStore,
  manifestId: string,
  expectedManifestVersion: number,
  rowIdentity: string,
  checkpoint: ImportCheckpoint,
  failureCode?: ErrorCode,
): Promise<SdkResult<CheckpointImportResult>> {
  try {
    if ("checkpointRow" in store && typeof store.checkpointRow === "function") {
      return ok(
        await store.checkpointRow(
          manifestId,
          expectedManifestVersion,
          rowIdentity,
          checkpoint,
          failureCode,
        ),
      );
    }
    const updated = await store.compareAndSwap(manifestId, expectedManifestVersion, (manifest) => {
      let found = false;
      const rows = manifest.rows.map((row) => {
        if (row.rowIdentity !== rowIdentity) {
          return row;
        }
        found = true;
        const allowed = ALLOWED_CHECKPOINT_TRANSITIONS[row.checkpoint];
        if (!allowed.includes(checkpoint)) {
          throw new PubkyShopError("manifest_store_error", { manifestId, rowIdentity });
        }
        return failureCode === undefined
          ? { ...row, checkpoint }
          : { ...row, checkpoint, failureCode };
      });
      if (!found) {
        throw new PubkyShopError("manifest_store_error", { manifestId, rowIdentity });
      }
      return { ...manifest, manifestVersion: manifest.manifestVersion + 1, rows };
    });
    const row = updated.rows.find((item) => item.rowIdentity === rowIdentity);
    if (row === undefined) {
      throw new PubkyShopError("manifest_store_error", { manifestId, rowIdentity });
    }
    return ok({ manifest: summaryOf(updated), row });
  } catch (error) {
    return err(
      error instanceof PubkyShopError
        ? error
        : new PubkyShopError("manifest_store_error", { manifestId }),
    );
  }
}

function streamLimitsFrom(
  overrides: BrowserPlanImportOptions["limits"],
): CsvStreamLimits & { maxBytes: number; maxRows: number } {
  const limits = {
    ...DEFAULT_CSV_STREAM_LIMITS,
    ...overrides,
    maxBytes: overrides?.maxBytes ?? DEFAULT_CSV_LIMITS.maxBytes,
    maxRows: overrides?.maxRows ?? DEFAULT_CSV_LIMITS.maxRows,
  };
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new PubkyShopError("invalid_configuration", { field });
    }
  }
  return limits;
}

function firstNonWs(bytes: Uint8Array): number | undefined {
  let offset = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    offset = 3;
  }
  while (offset < bytes.length) {
    const byte = bytes[offset];
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      return byte;
    }
    offset += 1;
  }
  return undefined;
}

function looksLikeJson(bytes: Uint8Array): boolean {
  const lead = firstNonWs(bytes);
  return lead === 0x7b || lead === 0x5b;
}

function asCanonicalRow(value: JsonValue, sourceRow: number): CanonicalCsvRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PubkyShopError("invalid_mapping", { sourceRow });
  }
  const recordUri = typeof value.recordUri === "string" ? value.recordUri : "";
  const sellerPubky = typeof value.sellerPubky === "string" ? value.sellerPubky : "";
  const listingId = typeof value.listingId === "string" ? value.listingId : "";
  const sourceListingKey = typeof value.sourceListingKey === "string" ? value.sourceListingKey : "";
  const variantId = typeof value.variantId === "string" ? value.variantId : "";
  const sku = typeof value.sku === "string" ? value.sku : "";
  const state = typeof value.state === "string" ? value.state : "";
  const title = typeof value.title === "string" ? value.title : "";
  const description = typeof value.description === "string" ? value.description : "";
  const category = typeof value.category === "string" ? value.category : "";
  const condition = typeof value.condition === "string" ? value.condition : "";
  const currency = typeof value.currency === "string" ? value.currency : "";
  if (
    typeof value.amountMinor !== "number" ||
    typeof value.exponent !== "number" ||
    typeof value.variantQuantity !== "number" ||
    typeof value.variantEnabled !== "boolean"
  ) {
    throw new PubkyShopError("invalid_mapping", { sourceRow });
  }
  return {
    recordUri,
    sellerPubky,
    listingId,
    sourceListingKey,
    recordRevision: typeof value.recordRevision === "number" ? value.recordRevision : null,
    variantId,
    sku,
    state,
    title,
    description,
    taxonomy: (value.taxonomy ?? {}) as JsonValue,
    category,
    condition,
    tags: (value.tags ?? []) as JsonValue,
    amountMinor: value.amountMinor,
    currency,
    exponent: value.exponent,
    variantQuantity: value.variantQuantity,
    variantEnabled: value.variantEnabled,
    options: (value.options ?? {}) as JsonValue,
    media: (value.media ?? []) as JsonValue,
    shippingOptions: (value.shippingOptions ?? []) as JsonValue,
    returnPolicy: (value.returnPolicy ?? {}) as JsonValue,
    sale: (value.sale ?? {}) as JsonValue,
    externalRefs: (value.externalRefs ?? {}) as JsonValue,
    extraFields:
      typeof value.extraFields === "object" &&
      value.extraFields !== null &&
      !Array.isArray(value.extraFields)
        ? (value.extraFields as Record<string, string>)
        : {},
    sourceRow,
  };
}

function jsonRows(value: JsonValue): CanonicalCsvRow[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => asCanonicalRow(item, index + 2));
  }
  if (typeof value === "object" && value !== null && Array.isArray(value.rows)) {
    return value.rows.map((item, index) => asCanonicalRow(item, index + 2));
  }
  throw new PubkyShopError("invalid_json");
}

async function planCanonicalRows(
  rows: readonly CanonicalCsvRow[],
  sourceSha256: string,
  sourceByteLength: bigint,
  peakParserBufferedBytes: number,
  options: BrowserPlanImportOptions,
  limits: ReturnType<typeof streamLimitsFrom>,
): Promise<SdkResult<PlannedBrowserImport>> {
  const manifestId = options.manifestId ?? randomId();
  if (!validManifestId(manifestId)) {
    return err(new PubkyShopError("invalid_identity", { field: "manifestId" }));
  }
  if (rows.length > limits.maxRows) {
    return err(
      new PubkyShopError("limit_exceeded", {
        field: "csv_rows",
        limit: limits.maxRows,
        observed: limits.maxRows + 1,
      }),
    );
  }
  const index = new IdentityIndex();
  const planned: PlannedImportRow[] = [];
  let peakPlannerBufferedBytes = index.byteLength;
  let priorListingIdentity = "";
  let generatedForListing: string | null = null;
  try {
    for (const row of rows) {
      const hashes = canonicalRowHashes(row);
      const { normalizedHash } = hashes;
      index.add(row, hashes);
      const identity = listingIdentity(row);
      if (identity !== priorListingIdentity) {
        priorListingIdentity = identity;
        generatedForListing =
          row.recordUri === "" && row.listingId === ""
            ? (options.generateListingId ?? randomId)()
            : null;
        if (generatedForListing !== null && !listingIdPattern.test(generatedForListing)) {
          throw new PubkyShopError("invalid_identity", {
            ...(row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow }),
          });
        }
      }
      const intendedAction = actionFor(row, normalizedHash, options.currentItems ?? {});
      const plannedRow: PlannedImportRow = {
        sourceRow: row.sourceRow ?? 0,
        sourceIdentity: sourceIdentity(row),
        rowIdentity: canonicalCsvRowIdentity(row),
        normalizedHash,
        listingIdentity: identity,
        listingId: generatedForListing ?? row.listingId,
        generatedListingId: generatedForListing,
        variantId: row.variantId,
        sku: row.sku,
        intendedAction,
        idempotencyKey: deterministicIdempotencyKey(
          manifestId,
          canonicalCsvRowIdentity(row),
          normalizedHash,
        ),
        checkpoint: intendedAction === "conflict" ? "conflict" : "planned",
      };
      peakPlannerBufferedBytes = Math.max(
        peakPlannerBufferedBytes,
        index.byteLength + utf8Size(canonicalJson(plannedRow as unknown as JsonObject)) * 2,
      );
      if (peakPlannerBufferedBytes > limits.maxWorkingSetBytes) {
        throw new PubkyShopError("limit_exceeded", {
          field: "planner_working_set_bytes",
          limit: limits.maxWorkingSetBytes,
          observed: Math.min(peakPlannerBufferedBytes, limits.maxWorkingSetBytes + 1),
          ...(row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow }),
        });
      }
      planned.push(plannedRow);
    }
    const createdAt = (options.now ?? (() => new Date()))().toISOString();
    const manifest: ImportManifest = {
      schemaVersion: 2,
      kind: "pubky-shop-import-manifest",
      manifestId,
      manifestVersion: 1,
      sourceSha256,
      sourceByteLength: sourceByteLength.toString(10),
      rowCount: planned.length,
      parserVersion: IMPORT_PARSER_VERSION,
      mappingVersion: IMPORT_MAPPING_VERSION,
      recordSchemaVersion: IMPORT_SCHEMA_VERSION,
      createdAt,
      rows: planned,
    };
    await options.store.create(manifest);
    return ok({
      manifest: summaryOf(manifest),
      resourceUsage: {
        sourceBytes: sourceByteLength,
        rowCount: planned.length,
        peakParserBufferedBytes,
        peakPlannerBufferedBytes,
        maxWorkingSetBytes: limits.maxWorkingSetBytes,
      },
    });
  } catch (error) {
    return err(
      error instanceof PubkyShopError
        ? error
        : new PubkyShopError("manifest_store_error", { manifestId }),
    );
  }
}

export async function planImportStream(
  source: CsvByteSource,
  options: BrowserPlanImportOptions,
): Promise<SdkResult<PlannedBrowserImport>> {
  try {
    const limits = streamLimitsFrom(options.limits);
    const rows: CanonicalCsvRow[] = [];
    const parsed = await parseCanonicalCsvStream(
      source,
      (row) => {
        rows.push(row);
        if (rows.length > limits.maxRows) {
          throw new PubkyShopError("limit_exceeded", {
            field: "csv_rows",
            limit: limits.maxRows,
            observed: limits.maxRows + 1,
            ...(row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow }),
          });
        }
      },
      limits,
    );
    return planCanonicalRows(
      rows,
      parsed.sourceSha256,
      parsed.resourceUsage.sourceBytes,
      parsed.resourceUsage.peakParserBufferedBytes,
      options,
      limits,
    );
  } catch (error) {
    return err(error instanceof PubkyShopError ? error : new PubkyShopError("malformed_csv"));
  }
}

function jsonLimitsFrom(maxBytes: number): JsonLimits {
  return {
    ...DEFAULT_JSON_LIMITS,
    maxBytes: Math.min(DEFAULT_JSON_LIMITS.maxBytes, maxBytes),
  };
}

export async function planImport(
  bytes: Uint8Array,
  options: BrowserPlanImportOptions,
): Promise<SdkResult<ImportManifest>> {
  const maxBytes = options.limits?.maxBytes ?? DEFAULT_CSV_LIMITS.maxBytes;
  if (bytes.byteLength > maxBytes) {
    return err(
      new PubkyShopError("limit_exceeded", {
        field: looksLikeJson(bytes) ? "json_bytes" : "csv_bytes",
        limit: maxBytes,
        observed: Math.min(bytes.byteLength, maxBytes + 1),
      }),
    );
  }
  let planned: SdkResult<PlannedBrowserImport>;
  if (looksLikeJson(bytes)) {
    try {
      const parsed = parseBoundedJson(bytes, jsonLimitsFrom(maxBytes));
      const rows = jsonRows(parsed);
      const hash = createSha256().update(bytes).digestHex();
      planned = await planCanonicalRows(
        rows,
        hash,
        BigInt(bytes.byteLength),
        bytes.byteLength,
        options,
        streamLimitsFrom(options.limits),
      );
    } catch (error) {
      return err(error instanceof PubkyShopError ? error : new PubkyShopError("invalid_json"));
    }
  } else {
    planned = await planImportStream([bytes], {
      ...options,
      limits: { ...options.limits, maxRows: options.limits?.maxRows ?? DEFAULT_CSV_LIMITS.maxRows },
    });
  }
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
