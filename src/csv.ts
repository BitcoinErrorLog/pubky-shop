import { PubkyShopError } from "./errors.js";
import { createSha256 } from "./hash.js";
import {
  type JsonLimits,
  type JsonValue,
  canonicalJson,
  parseBoundedJson,
  sha256Hex,
} from "./json.js";

export const CANONICAL_CSV_COLUMNS = [
  "record_uri",
  "seller_pubky",
  "listing_id",
  "source_listing_key",
  "record_revision",
  "variant_id",
  "sku",
  "state",
  "title",
  "description",
  "taxonomy_json",
  "category",
  "condition",
  "tags_json",
  "amount_minor",
  "currency",
  "exponent",
  "variant_quantity",
  "variant_enabled",
  "options_json",
  "media_json",
  "shipping_options_json",
  "return_policy_json",
  "sale_json",
  "external_refs_json",
] as const;

export type CanonicalCsvColumn = (typeof CANONICAL_CSV_COLUMNS)[number];

const NESTED_COLUMNS = [
  "taxonomy_json",
  "tags_json",
  "options_json",
  "media_json",
  "shipping_options_json",
  "return_policy_json",
  "sale_json",
  "external_refs_json",
] as const satisfies readonly CanonicalCsvColumn[];

const LISTING_COLUMNS = [
  "record_uri",
  "seller_pubky",
  "listing_id",
  "source_listing_key",
  "record_revision",
  "state",
  "title",
  "description",
  "taxonomy_json",
  "category",
  "condition",
  "tags_json",
  "amount_minor",
  "currency",
  "exponent",
  "media_json",
  "shipping_options_json",
  "return_policy_json",
  "sale_json",
  "external_refs_json",
] as const satisfies readonly CanonicalCsvColumn[];

export interface CsvLimits {
  /** Complete-source cap used only by bounded byte-array convenience APIs and export. */
  readonly maxBytes: number;
  /** Complete-row-count cap used only by bounded materializing convenience APIs and export. */
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly maxCellBytes: number;
  readonly maxRowBytes: number;
  readonly maxNestingDepth: number;
  readonly maxWorkingSetBytes: number;
}

export const DEFAULT_CSV_LIMITS: CsvLimits = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxRows: 100_000,
  maxColumns: 128,
  maxCellBytes: 1024 * 1024,
  maxRowBytes: 8 * 1024 * 1024,
  maxNestingDepth: 32,
  maxWorkingSetBytes: 64 * 1024 * 1024,
});

/**
 * Streaming input limits never cap total source bytes or total row count.
 * `maxWorkingSetBytes` covers parser-owned decoded cells and one emitted row;
 * upstream stream queues remain the host's responsibility.
 */
export type CsvStreamLimits = Omit<CsvLimits, "maxBytes" | "maxRows">;

export const DEFAULT_CSV_STREAM_LIMITS: CsvStreamLimits = Object.freeze({
  maxColumns: DEFAULT_CSV_LIMITS.maxColumns,
  maxCellBytes: DEFAULT_CSV_LIMITS.maxCellBytes,
  maxRowBytes: DEFAULT_CSV_LIMITS.maxRowBytes,
  maxNestingDepth: DEFAULT_CSV_LIMITS.maxNestingDepth,
  maxWorkingSetBytes: DEFAULT_CSV_LIMITS.maxWorkingSetBytes,
});

export type CsvByteSource =
  | AsyncIterable<Uint8Array>
  | ReadableStream<Uint8Array>
  | Iterable<Uint8Array>;

export interface CsvStreamResourceUsage {
  readonly sourceBytes: bigint;
  readonly rowCount: number;
  readonly peakParserBufferedBytes: number;
  readonly maxParserBufferedBytes: number;
}

export interface ParsedCanonicalCsvStream {
  readonly headers: readonly string[];
  readonly sourceSha256: string;
  readonly hadBom: boolean;
  readonly resourceUsage: CsvStreamResourceUsage;
}

export type CanonicalCsvRowSink = (row: CanonicalCsvRow) => void | Promise<void>;

export interface CanonicalCsvRow {
  readonly recordUri: string;
  readonly sellerPubky: string;
  readonly listingId: string;
  readonly sourceListingKey: string;
  readonly recordRevision: number | null;
  readonly variantId: string;
  readonly sku: string;
  readonly state: string;
  readonly title: string;
  readonly description: string;
  readonly taxonomy: JsonValue;
  readonly category: string;
  readonly condition: string;
  readonly tags: JsonValue;
  readonly amountMinor: number;
  readonly currency: string;
  readonly exponent: number;
  readonly variantQuantity: number;
  readonly variantEnabled: boolean;
  readonly options: JsonValue;
  readonly media: JsonValue;
  readonly shippingOptions: JsonValue;
  readonly returnPolicy: JsonValue;
  readonly sale: JsonValue;
  readonly externalRefs: JsonValue;
  readonly extraFields: Readonly<Record<string, string>>;
  readonly sourceRow?: number;
}

export interface ParsedCanonicalCsv {
  readonly rows: readonly CanonicalCsvRow[];
  readonly headers: readonly string[];
  readonly sourceSha256: string;
  readonly hadBom: boolean;
}

export interface CsvExportOptions {
  readonly excelBom?: boolean;
  readonly limits?: Partial<CsvLimits>;
}

interface RawRow {
  readonly cells: readonly string[];
  readonly sourceRow: number;
  readonly byteLength: number;
}

const encoder = new TextEncoder();
const dangerousFormulaPrefix = /^[=+\-@]/;
const pubkyId = /^[A-Za-z0-9_.-]{1,128}$/;
const currencyCode = /^[A-Z]{3}$/;

function limitsFrom(overrides: Partial<CsvLimits> | undefined): CsvLimits {
  const limits = { ...DEFAULT_CSV_LIMITS, ...overrides };
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new PubkyShopError("invalid_configuration", { field });
    }
  }
  return limits;
}

function streamLimitsFrom(overrides: Partial<CsvStreamLimits> | undefined): CsvStreamLimits {
  const limits = { ...DEFAULT_CSV_STREAM_LIMITS, ...overrides };
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new PubkyShopError("invalid_configuration", { field });
    }
  }
  return limits;
}

function limit(field: string, maximum: number, observed: number, sourceRow?: number): never {
  throw new PubkyShopError("limit_exceeded", {
    field,
    limit: maximum,
    observed: Math.min(observed, maximum + 1),
    ...(sourceRow === undefined ? {} : { sourceRow }),
  });
}

function formulaProtected(value: string): string {
  if (value.startsWith("'") || dangerousFormulaPrefix.test(value)) {
    return `'${value}`;
  }
  return value;
}

function formulaDecoded(value: string, sourceRow: number): string {
  if (dangerousFormulaPrefix.test(value)) {
    throw new PubkyShopError("formula_payload", { sourceRow });
  }
  if (value.startsWith("''") || /^'[=+\-@]/.test(value)) {
    return value.slice(1);
  }
  return value;
}

function quoteCell(value: string): string {
  return `"${formulaProtected(value).replaceAll('"', '""')}"`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const PARSER_QUANTUM_BYTES = 64 * 1024;

class IncrementalRawCsvParser {
  readonly #limits: CsvStreamLimits;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  #preamble: number[] = [];
  #preambleResolved = false;
  #hadBom = false;
  #cells: string[] = [];
  #cellParts: string[] = [];
  #cellSegment = "";
  #cellBytes = 0;
  #cellUnits = 0;
  #completedCellUnits = 0;
  #rowBytes = 0;
  #line = 1;
  #rowStart = 1;
  #quoted = false;
  #quotePending = false;
  #afterQuote = false;
  #pendingCr = false;
  #rowActive = false;
  #sawText = false;
  #peakBufferedBytes = 0;

  constructor(limits: CsvStreamLimits) {
    this.#limits = limits;
  }

  get hadBom(): boolean {
    return this.#hadBom;
  }

  get peakBufferedBytes(): number {
    return this.#peakBufferedBytes;
  }

  write(bytes: Uint8Array): RawRow[] {
    const rows: RawRow[] = [];
    let offset = 0;
    if (!this.#preambleResolved) {
      while (offset < bytes.byteLength && this.#preamble.length < UTF8_BOM.byteLength) {
        this.#preamble.push(bytes[offset] ?? 0);
        offset += 1;
        const index = this.#preamble.length - 1;
        if (this.#preamble[index] !== UTF8_BOM[index]) {
          this.#preambleResolved = true;
          this.#decode(new Uint8Array(this.#preamble), rows, true);
          this.#preamble = [];
          break;
        }
      }
      if (!this.#preambleResolved && this.#preamble.length === UTF8_BOM.byteLength) {
        this.#preambleResolved = true;
        this.#hadBom = true;
        this.#preamble = [];
      }
    }
    if (offset < bytes.byteLength) {
      this.#decode(bytes.subarray(offset), rows, true);
    }
    return rows;
  }

  finish(): RawRow[] {
    const rows: RawRow[] = [];
    if (!this.#preambleResolved) {
      this.#preambleResolved = true;
      if (this.#preamble.length > 0) {
        this.#decode(new Uint8Array(this.#preamble), rows, true);
      }
      this.#preamble = [];
    }
    this.#decode(new Uint8Array(), rows, false);
    if (this.#quotePending) {
      this.#quotePending = false;
      this.#quoted = false;
      this.#afterQuote = true;
    }
    if (this.#pendingCr || this.#quoted) {
      throw new PubkyShopError("malformed_csv", { sourceRow: this.#rowStart });
    }
    if (this.#cellBytes > 0 || this.#cells.length > 0 || this.#afterQuote || this.#rowActive) {
      rows.push(this.#finishRow());
    }
    if (!this.#sawText && rows.length === 0) {
      throw new PubkyShopError("invalid_csv_header");
    }
    return rows;
  }

  #decode(bytes: Uint8Array, rows: RawRow[], stream: boolean): void {
    let text: string;
    try {
      text = this.#decoder.decode(bytes, { stream });
    } catch {
      throw new PubkyShopError("malformed_csv", { sourceRow: this.#rowStart });
    }
    if (text.length > 0) {
      this.#sawText = true;
    }
    for (const character of text) {
      this.#character(character, rows);
    }
  }

  #character(character: string, rows: RawRow[]): void {
    if (this.#pendingCr) {
      if (character !== "\n") {
        throw new PubkyShopError("malformed_csv", { sourceRow: this.#rowStart });
      }
      this.#pendingCr = false;
      this.#line += 1;
      if (this.#quoted) {
        this.#append("\r\n");
      } else {
        rows.push(this.#finishRow());
        this.#rowStart = this.#line;
      }
      return;
    }
    if (this.#quoted) {
      if (this.#quotePending) {
        if (character === '"') {
          this.#quotePending = false;
          this.#append('"');
          return;
        }
        this.#quotePending = false;
        this.#quoted = false;
        this.#afterQuote = true;
        this.#character(character, rows);
        return;
      }
      if (character === '"') {
        this.#quotePending = true;
      } else if (character === "\r") {
        this.#pendingCr = true;
      } else if (character === "\n") {
        throw new PubkyShopError("malformed_csv", { sourceRow: this.#rowStart });
      } else {
        this.#append(character);
      }
      return;
    }
    if (this.#afterQuote && character !== "," && character !== "\r") {
      throw new PubkyShopError("malformed_csv", { sourceRow: this.#rowStart });
    }
    if (
      character === '"' &&
      this.#cellBytes === 0 &&
      this.#cellParts.length === 0 &&
      this.#cellSegment.length === 0
    ) {
      this.#quoted = true;
      this.#rowActive = true;
    } else if (character === '"') {
      throw new PubkyShopError("malformed_csv", { sourceRow: this.#rowStart });
    } else if (character === ",") {
      this.#finishCell();
      this.#rowActive = true;
    } else if (character === "\r") {
      this.#pendingCr = true;
    } else if (character === "\n" || this.#afterQuote) {
      throw new PubkyShopError("malformed_csv", { sourceRow: this.#rowStart });
    } else {
      this.#append(character);
      this.#rowActive = true;
    }
  }

  #append(value: string): void {
    const bytes = encoder.encode(value).byteLength;
    this.#cellBytes += bytes;
    this.#rowBytes += bytes;
    if (this.#cellBytes > this.#limits.maxCellBytes) {
      limit("csv_cell_bytes", this.#limits.maxCellBytes, this.#cellBytes, this.#rowStart);
    }
    if (this.#rowBytes > this.#limits.maxRowBytes) {
      limit("csv_row_bytes", this.#limits.maxRowBytes, this.#rowBytes, this.#rowStart);
    }
    this.#cellSegment += value;
    this.#cellUnits += value.length;
    if (this.#cellSegment.length >= 4096) {
      this.#cellParts.push(this.#cellSegment);
      this.#cellSegment = "";
    }
    this.#charge();
  }

  #finishCell(): void {
    this.#cells.push(`${this.#cellParts.join("")}${this.#cellSegment}`);
    this.#completedCellUnits += this.#cellUnits;
    if (this.#cells.length > this.#limits.maxColumns) {
      limit("csv_columns", this.#limits.maxColumns, this.#cells.length, this.#rowStart);
    }
    this.#cellParts = [];
    this.#cellSegment = "";
    this.#cellBytes = 0;
    this.#cellUnits = 0;
    this.#afterQuote = false;
    this.#charge();
  }

  #finishRow(): RawRow {
    this.#finishCell();
    const row = {
      cells: this.#cells,
      sourceRow: this.#rowStart,
      byteLength: this.#rowBytes,
    };
    this.#cells = [];
    this.#rowBytes = 0;
    this.#completedCellUnits = 0;
    this.#rowActive = false;
    this.#afterQuote = false;
    this.#charge();
    return row;
  }

  #charge(): void {
    const observed =
      this.#rowBytes +
      (this.#cellUnits + this.#completedCellUnits) * 2 +
      this.#cellParts.length * 16 +
      this.#cells.length * 16;
    this.#peakBufferedBytes = Math.max(this.#peakBufferedBytes, observed);
    if (observed > this.#limits.maxWorkingSetBytes) {
      limit("csv_working_set_bytes", this.#limits.maxWorkingSetBytes, observed, this.#rowStart);
    }
  }
}

function parseRawCsv(input: Uint8Array, limits: CsvLimits): { rows: RawRow[]; hadBom: boolean } {
  if (input.byteLength > limits.maxBytes) {
    limit("csv_bytes", limits.maxBytes, input.byteLength);
  }
  const parser = new IncrementalRawCsvParser(limits);
  const rows: RawRow[] = [];
  for (let offset = 0; offset < input.byteLength; offset += PARSER_QUANTUM_BYTES) {
    rows.push(...parser.write(input.subarray(offset, offset + PARSER_QUANTUM_BYTES)));
    if (rows.length - 1 > limits.maxRows) {
      limit("csv_rows", limits.maxRows, rows.length - 1);
    }
  }
  rows.push(...parser.finish());
  if (rows.length - 1 > limits.maxRows) {
    limit("csv_rows", limits.maxRows, rows.length - 1);
  }
  if (rows.length === 0) {
    throw new PubkyShopError("invalid_csv_header");
  }
  return { rows, hadBom: parser.hadBom };
}

function exactInteger(
  value: string,
  field: string,
  sourceRow: number,
  minimum: number,
  maximum: number,
): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new PubkyShopError("invalid_mapping", { field, sourceRow });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new PubkyShopError("invalid_mapping", { field, sourceRow });
  }
  return parsed;
}

function optionalRevision(value: string, sourceRow: number): number | null {
  return value === ""
    ? null
    : exactInteger(value, "record_revision", sourceRow, 1, Number.MAX_SAFE_INTEGER);
}

function boolean(value: string, sourceRow: number): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new PubkyShopError("invalid_mapping", {
    field: "variant_enabled",
    sourceRow,
  });
}

function nested(
  value: string,
  field: string,
  sourceRow: number,
  limits: CsvStreamLimits,
): JsonValue {
  if (value === "") {
    throw new PubkyShopError("invalid_mapping", { field, sourceRow });
  }
  const jsonLimits: Partial<JsonLimits> = {
    maxBytes: limits.maxCellBytes,
    maxDepth: limits.maxNestingDepth,
    maxNodes: Math.max(1, Math.min(100_000, limits.maxCellBytes)),
    maxStringBytes: limits.maxCellBytes,
  };
  try {
    return parseBoundedJson(value, jsonLimits);
  } catch (error) {
    if (error instanceof PubkyShopError && error.code === "limit_exceeded") {
      throw new PubkyShopError("limit_exceeded", {
        ...error.details,
        sourceRow,
      });
    }
    throw new PubkyShopError("invalid_mapping", { field, sourceRow });
  }
}

export function listingIdentity(row: CanonicalCsvRow): string {
  if (row.recordUri !== "") {
    return `uri:${row.recordUri}`;
  }
  if (row.sellerPubky !== "" && row.listingId !== "") {
    return `listing:${row.sellerPubky}:${row.listingId}`;
  }
  if (row.sourceListingKey !== "") {
    return `source:${row.sourceListingKey}`;
  }
  throw new PubkyShopError("invalid_identity", {
    ...(row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow }),
  });
}

function validateIdentity(row: CanonicalCsvRow): void {
  const details = row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow };
  const hasRecordUri = row.recordUri !== "";
  const hasSeller = row.sellerPubky !== "";
  const hasListing = row.listingId !== "";
  if (
    row.variantId === "" ||
    !pubkyId.test(row.variantId) ||
    (row.listingId !== "" && !pubkyId.test(row.listingId)) ||
    (row.sellerPubky !== "" && row.sellerPubky.length !== 52) ||
    (row.sourceListingKey !== "" &&
      (!pubkyId.test(row.sourceListingKey) || row.sourceListingKey.length > 128))
  ) {
    throw new PubkyShopError("invalid_identity", details);
  }
  if (!hasRecordUri && hasSeller !== hasListing) {
    throw new PubkyShopError("invalid_identity", details);
  }
  if (hasRecordUri) {
    let uri: URL;
    try {
      uri = new URL(row.recordUri);
    } catch {
      throw new PubkyShopError("invalid_identity", details);
    }
    const pathPrefix = "/pub/pubky.app/marketplace/v1/listings/";
    let uriListingId = "";
    try {
      uriListingId = decodeURIComponent(uri.pathname.slice(pathPrefix.length));
    } catch {
      throw new PubkyShopError("invalid_identity", details);
    }
    if (
      uri.protocol !== "pubky:" ||
      uri.username !== "" ||
      uri.password !== "" ||
      uri.port !== "" ||
      uri.search !== "" ||
      uri.hash !== "" ||
      !uri.pathname.startsWith(pathPrefix) ||
      !pubkyId.test(uriListingId) ||
      uri.hostname.length !== 52 ||
      (hasSeller && uri.hostname !== row.sellerPubky) ||
      (hasListing && uriListingId !== row.listingId) ||
      row.recordRevision === null
    ) {
      throw new PubkyShopError("invalid_identity", details);
    }
  } else if (hasSeller && hasListing && row.recordRevision === null) {
    throw new PubkyShopError("invalid_identity", details);
  } else if (!hasSeller && !hasListing && row.recordRevision !== null) {
    throw new PubkyShopError("invalid_identity", details);
  }
  listingIdentity(row);
}

function rawToCanonical(
  raw: RawRow,
  headers: readonly string[],
  limits: CsvStreamLimits,
): CanonicalCsvRow {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const cell = raw.cells[index];
    if (header === undefined || cell === undefined) {
      throw new PubkyShopError("malformed_csv", { sourceRow: raw.sourceRow });
    }
    values[header] = formulaDecoded(cell, raw.sourceRow);
  }
  const required = (column: CanonicalCsvColumn): string => {
    const value = values[column];
    if (value === undefined) {
      throw new PubkyShopError("invalid_csv_header", { field: column });
    }
    return value;
  };
  const extraFields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const header of headers) {
    if (!(CANONICAL_CSV_COLUMNS as readonly string[]).includes(header)) {
      const value = values[header];
      if (value === undefined) {
        throw new PubkyShopError("malformed_csv", { sourceRow: raw.sourceRow });
      }
      extraFields[header] = value;
    }
  }
  const row: CanonicalCsvRow = {
    recordUri: required("record_uri"),
    sellerPubky: required("seller_pubky"),
    listingId: required("listing_id"),
    sourceListingKey: required("source_listing_key"),
    recordRevision: optionalRevision(required("record_revision"), raw.sourceRow),
    variantId: required("variant_id"),
    sku: required("sku"),
    state: required("state"),
    title: required("title"),
    description: required("description"),
    taxonomy: nested(required("taxonomy_json"), "taxonomy_json", raw.sourceRow, limits),
    category: required("category"),
    condition: required("condition"),
    tags: nested(required("tags_json"), "tags_json", raw.sourceRow, limits),
    amountMinor: exactInteger(
      required("amount_minor"),
      "amount_minor",
      raw.sourceRow,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    currency: required("currency"),
    exponent: exactInteger(required("exponent"), "exponent", raw.sourceRow, 0, 18),
    variantQuantity: exactInteger(
      required("variant_quantity"),
      "variant_quantity",
      raw.sourceRow,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    variantEnabled: boolean(required("variant_enabled"), raw.sourceRow),
    options: nested(required("options_json"), "options_json", raw.sourceRow, limits),
    media: nested(required("media_json"), "media_json", raw.sourceRow, limits),
    shippingOptions: nested(
      required("shipping_options_json"),
      "shipping_options_json",
      raw.sourceRow,
      limits,
    ),
    returnPolicy: nested(
      required("return_policy_json"),
      "return_policy_json",
      raw.sourceRow,
      limits,
    ),
    sale: nested(required("sale_json"), "sale_json", raw.sourceRow, limits),
    externalRefs: nested(
      required("external_refs_json"),
      "external_refs_json",
      raw.sourceRow,
      limits,
    ),
    extraFields,
    sourceRow: raw.sourceRow,
  };
  if (!currencyCode.test(row.currency)) {
    throw new PubkyShopError("invalid_mapping", {
      field: "currency",
      sourceRow: raw.sourceRow,
    });
  }
  validateIdentity(row);
  return row;
}

function validatedHeaders(header: RawRow): readonly string[] {
  const headers = header.cells.map((cell) => formulaDecoded(cell, header.sourceRow));
  if (
    headers.length === 0 ||
    headers.some((value) => value === "") ||
    new Set(headers).size !== headers.length
  ) {
    throw new PubkyShopError("invalid_csv_header");
  }
  for (const column of CANONICAL_CSV_COLUMNS) {
    if (!headers.includes(column)) {
      throw new PubkyShopError("invalid_csv_header", { field: column });
    }
  }
  return Object.freeze(headers);
}

async function* sourceChunks(source: CsvByteSource): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in source) {
    for await (const chunk of source as AsyncIterable<Uint8Array>) {
      yield chunk;
    }
    return;
  }
  if (Symbol.iterator in source) {
    for (const chunk of source as Iterable<Uint8Array>) {
      yield chunk;
    }
    return;
  }
  const reader = (source as ReadableStream<Uint8Array>).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Incrementally decodes and maps an RFC 4180 byte source without retaining
 * source bytes or prior rows. Cross-row/group validation belongs to
 * `planImportStream`, which uses a durable external index before committing a
 * manifest.
 */
export async function parseCanonicalCsvStream(
  source: CsvByteSource,
  onRow: CanonicalCsvRowSink,
  overrides?: Partial<CsvStreamLimits>,
): Promise<ParsedCanonicalCsvStream> {
  const limits = streamLimitsFrom(overrides);
  const parser = new IncrementalRawCsvParser(limits);
  const hash = createSha256();
  let headers: readonly string[] | undefined;
  let sourceBytes = 0n;
  let rowCount = 0;
  let peakParserBufferedBytes = 0;
  let retainedHeaderBytes = 0;

  const consume = async (rawRows: readonly RawRow[]): Promise<void> => {
    for (const raw of rawRows) {
      if (headers === undefined) {
        headers = validatedHeaders(raw);
        retainedHeaderBytes =
          raw.byteLength * 3 + headers.reduce((sum, header) => sum + header.length * 2 + 16, 0);
        continue;
      }
      if (raw.cells.length !== headers.length) {
        throw new PubkyShopError("malformed_csv", { sourceRow: raw.sourceRow });
      }
      const row = rawToCanonical(raw, headers, limits);
      const canonicalBytes = encoder.encode(canonicalJson(row as unknown as JsonValue)).byteLength;
      const charged =
        retainedHeaderBytes + raw.byteLength * 3 + canonicalBytes * 3 + PARSER_QUANTUM_BYTES * 2;
      peakParserBufferedBytes = Math.max(
        peakParserBufferedBytes,
        parser.peakBufferedBytes,
        charged,
      );
      if (peakParserBufferedBytes > limits.maxWorkingSetBytes) {
        limit(
          "csv_working_set_bytes",
          limits.maxWorkingSetBytes,
          peakParserBufferedBytes,
          raw.sourceRow,
        );
      }
      await onRow(row);
      rowCount += 1;
    }
  };

  for await (const sourceChunk of sourceChunks(source)) {
    if (!(sourceChunk instanceof Uint8Array)) {
      throw new PubkyShopError("malformed_csv");
    }
    sourceBytes += BigInt(sourceChunk.byteLength);
    hash.update(sourceChunk);
    for (let offset = 0; offset < sourceChunk.byteLength; offset += PARSER_QUANTUM_BYTES) {
      await consume(parser.write(sourceChunk.subarray(offset, offset + PARSER_QUANTUM_BYTES)));
    }
  }
  await consume(parser.finish());
  if (headers === undefined) {
    throw new PubkyShopError("invalid_csv_header");
  }
  return Object.freeze({
    headers,
    sourceSha256: hash.digestHex(),
    hadBom: parser.hadBom,
    resourceUsage: Object.freeze({
      sourceBytes,
      rowCount,
      peakParserBufferedBytes: Math.max(peakParserBufferedBytes, parser.peakBufferedBytes),
      maxParserBufferedBytes: limits.maxWorkingSetBytes,
    }),
  });
}

function canonicalCells(row: CanonicalCsvRow): Readonly<Record<CanonicalCsvColumn, string>> {
  return {
    record_uri: row.recordUri,
    seller_pubky: row.sellerPubky,
    listing_id: row.listingId,
    source_listing_key: row.sourceListingKey,
    record_revision: row.recordRevision === null ? "" : String(row.recordRevision),
    variant_id: row.variantId,
    sku: row.sku,
    state: row.state,
    title: row.title,
    description: row.description,
    taxonomy_json: canonicalJson(row.taxonomy),
    category: row.category,
    condition: row.condition,
    tags_json: canonicalJson(row.tags),
    amount_minor: String(row.amountMinor),
    currency: row.currency,
    exponent: String(row.exponent),
    variant_quantity: String(row.variantQuantity),
    variant_enabled: String(row.variantEnabled),
    options_json: canonicalJson(row.options),
    media_json: canonicalJson(row.media),
    shipping_options_json: canonicalJson(row.shippingOptions),
    return_policy_json: canonicalJson(row.returnPolicy),
    sale_json: canonicalJson(row.sale),
    external_refs_json: canonicalJson(row.externalRefs),
  };
}

export function canonicalRowHashes(row: CanonicalCsvRow): {
  readonly normalizedHash: string;
  readonly listingFactsHash: string;
} {
  const cells = canonicalCells(row);
  const extra = Object.fromEntries(
    Object.entries(row.extraFields).sort(([left], [right]) => compareText(left, right)),
  );
  return {
    listingFactsHash: sha256Hex(
      encoder.encode(
        canonicalJson(Object.fromEntries(LISTING_COLUMNS.map((column) => [column, cells[column]]))),
      ),
    ),
    normalizedHash: sha256Hex(
      encoder.encode(
        canonicalJson({
          ...cells,
          extra,
        }),
      ),
    ),
  };
}

export function normalizedListingFactsHash(row: CanonicalCsvRow): string {
  return canonicalRowHashes(row).listingFactsHash;
}

export function normalizedCsvRowHash(row: CanonicalCsvRow): string {
  return canonicalRowHashes(row).normalizedHash;
}

function validateRows(rows: readonly CanonicalCsvRow[]): void {
  const rowHashes = new Set<string>();
  const variants = new Set<string>();
  const skus = new Map<string, string>();
  const listingFacts = new Map<string, string>();
  for (const row of rows) {
    validateIdentity(row);
    const hash = canonicalRowHashes(row);
    if (rowHashes.has(hash.normalizedHash)) {
      throw new PubkyShopError("duplicate_row", {
        ...(row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow }),
      });
    }
    rowHashes.add(hash.normalizedHash);
    const identity = listingIdentity(row);
    const variantIdentity = `${identity}#${row.variantId}`;
    if (variants.has(variantIdentity)) {
      throw new PubkyShopError("duplicate_variant_id", {
        ...(row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow }),
      });
    }
    variants.add(variantIdentity);
    if (row.sku !== "") {
      const prior = skus.get(row.sku);
      if (prior !== undefined && prior !== variantIdentity) {
        throw new PubkyShopError("ambiguous_sku", {
          ...(row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow }),
        });
      }
      skus.set(row.sku, variantIdentity);
    }
    const facts = listingFacts.get(identity);
    if (facts !== undefined && facts !== hash.listingFactsHash) {
      throw new PubkyShopError("conflicting_listing_fields", {
        ...(row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow }),
      });
    }
    listingFacts.set(identity, hash.listingFactsHash);
  }
}

export function parseCanonicalCsv(
  input: Uint8Array,
  overrides?: Partial<CsvLimits>,
): ParsedCanonicalCsv {
  const limits = limitsFrom(overrides);
  const { rows: rawRows, hadBom } = parseRawCsv(input, limits);
  const header = rawRows[0];
  if (header === undefined) {
    throw new PubkyShopError("invalid_csv_header");
  }
  const headers = validatedHeaders(header);
  const rows = rawRows.slice(1).map((raw) => {
    if (raw.cells.length !== headers.length) {
      throw new PubkyShopError("malformed_csv", { sourceRow: raw.sourceRow });
    }
    return rawToCanonical(raw, headers, limits);
  });
  validateRows(rows);
  return Object.freeze({
    rows: Object.freeze(rows),
    headers: Object.freeze(headers),
    sourceSha256: sha256Hex(input),
    hadBom,
  });
}

function stableRowSort(left: CanonicalCsvRow, right: CanonicalCsvRow): number {
  return (
    compareText(listingIdentity(left), listingIdentity(right)) ||
    compareText(left.variantId, right.variantId) ||
    compareText(left.sku, right.sku) ||
    compareText(normalizedCsvRowHash(left), normalizedCsvRowHash(right))
  );
}

export function exportCanonicalCsv(
  rows: readonly CanonicalCsvRow[],
  options: CsvExportOptions = {},
): Uint8Array {
  const limits = limitsFrom(options.limits);
  if (rows.length > limits.maxRows) {
    limit("csv_rows", limits.maxRows, rows.length);
  }
  validateRows(rows);
  const extraHeaders = [...new Set(rows.flatMap((row) => Object.keys(row.extraFields)))].sort(
    compareText,
  );
  const headers = [...CANONICAL_CSV_COLUMNS, ...extraHeaders];
  if (headers.length > limits.maxColumns) {
    limit("csv_columns", limits.maxColumns, headers.length);
  }
  const lines = [headers.map(quoteCell).join(",")];
  for (const row of [...rows].sort(stableRowSort)) {
    const canonical = canonicalCells(row);
    const values = headers.map((header) => {
      const value =
        header in canonical
          ? canonical[header as CanonicalCsvColumn]
          : (row.extraFields[header] ?? "");
      const size = encoder.encode(value).byteLength;
      if (size > limits.maxCellBytes) {
        limit("csv_cell_bytes", limits.maxCellBytes, size, row.sourceRow);
      }
      return quoteCell(value);
    });
    lines.push(values.join(","));
  }
  const prefix = options.excelBom === true ? "\uFEFF" : "";
  const rendered = `${prefix}${lines.join("\r\n")}\r\n`;
  const output = encoder.encode(rendered);
  if (output.byteLength > limits.maxBytes) {
    limit("csv_bytes", limits.maxBytes, output.byteLength);
  }
  const estimatedWorkingSet = output.byteLength + rendered.length * 2;
  if (estimatedWorkingSet > limits.maxWorkingSetBytes) {
    limit("csv_working_set_bytes", limits.maxWorkingSetBytes, estimatedWorkingSet);
  }
  return output;
}

export function canonicalCsvRowIdentity(row: CanonicalCsvRow): string {
  return `${listingIdentity(row)}#variant:${row.variantId}`;
}

export function canonicalNestedColumns(): readonly CanonicalCsvColumn[] {
  return NESTED_COLUMNS;
}
