import { PubkyShopError } from "./errors.js";
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
  readonly maxBytes: number;
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly maxCellBytes: number;
  readonly maxNestingDepth: number;
  readonly maxWorkingSetBytes: number;
}

export const DEFAULT_CSV_LIMITS: CsvLimits = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxRows: 100_000,
  maxColumns: 128,
  maxCellBytes: 1024 * 1024,
  maxNestingDepth: 32,
  maxWorkingSetBytes: 96 * 1024 * 1024,
});

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
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
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

function parseRawCsv(input: Uint8Array, limits: CsvLimits): { rows: RawRow[]; hadBom: boolean } {
  if (input.byteLength > limits.maxBytes) {
    limit("csv_bytes", limits.maxBytes, input.byteLength);
  }
  if (input.byteLength > limits.maxWorkingSetBytes) {
    limit("csv_working_set_bytes", limits.maxWorkingSetBytes, input.byteLength);
  }
  let text: string;
  try {
    text = decoder.decode(input);
  } catch {
    throw new PubkyShopError("malformed_csv");
  }
  const estimatedWorkingSet = input.byteLength + text.length * 6;
  if (estimatedWorkingSet > limits.maxWorkingSetBytes) {
    limit("csv_working_set_bytes", limits.maxWorkingSetBytes, estimatedWorkingSet);
  }
  const hadBom = text.charCodeAt(0) === 0xfeff;
  if (hadBom) {
    text = text.slice(1);
  }
  if (text.length === 0) {
    throw new PubkyShopError("invalid_csv_header");
  }

  const rows: RawRow[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;
  let line = 1;
  let rowStart = 1;

  const pushCell = (): void => {
    const size = encoder.encode(cell).byteLength;
    if (size > limits.maxCellBytes) {
      limit("csv_cell_bytes", limits.maxCellBytes, size, rowStart);
    }
    cells.push(cell);
    if (cells.length > limits.maxColumns) {
      limit("csv_columns", limits.maxColumns, cells.length, rowStart);
    }
    cell = "";
    afterQuote = false;
  };

  const pushRow = (): void => {
    pushCell();
    rows.push({ cells, sourceRow: rowStart });
    if (rows.length - 1 > limits.maxRows) {
      limit("csv_rows", limits.maxRows, rows.length - 1, rowStart);
    }
    cells = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else if (character === "\r") {
        if (text[index + 1] !== "\n") {
          throw new PubkyShopError("malformed_csv", { sourceRow: rowStart });
        }
        cell += "\r\n";
        index += 1;
        line += 1;
      } else if (character === "\n") {
        throw new PubkyShopError("malformed_csv", { sourceRow: rowStart });
      } else {
        cell += character;
      }
      continue;
    }
    if (afterQuote && character !== "," && character !== "\r") {
      throw new PubkyShopError("malformed_csv", { sourceRow: rowStart });
    }
    if (character === '"' && cell.length === 0 && !afterQuote) {
      quoted = true;
    } else if (character === '"') {
      throw new PubkyShopError("malformed_csv", { sourceRow: rowStart });
    } else if (character === ",") {
      pushCell();
    } else if (character === "\r") {
      if (text[index + 1] !== "\n") {
        throw new PubkyShopError("malformed_csv", { sourceRow: rowStart });
      }
      pushRow();
      index += 1;
      line += 1;
      rowStart = line;
    } else if (character === "\n" || afterQuote) {
      throw new PubkyShopError("malformed_csv", { sourceRow: rowStart });
    } else {
      cell += character;
    }
  }
  if (quoted) {
    throw new PubkyShopError("malformed_csv", { sourceRow: rowStart });
  }
  if (cell.length > 0 || cells.length > 0 || afterQuote) {
    pushRow();
  }
  if (rows.length === 0) {
    throw new PubkyShopError("invalid_csv_header");
  }
  return { rows, hadBom };
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

function nested(value: string, field: string, sourceRow: number, limits: CsvLimits): JsonValue {
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
  limits: CsvLimits,
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

export function normalizedCsvRowHash(row: CanonicalCsvRow): string {
  const extra = Object.fromEntries(
    Object.entries(row.extraFields).sort(([left], [right]) => compareText(left, right)),
  );
  return sha256Hex(
    encoder.encode(
      canonicalJson({
        ...canonicalCells(row),
        extra,
      }),
    ),
  );
}

function validateRows(rows: readonly CanonicalCsvRow[]): void {
  const rowHashes = new Set<string>();
  const variants = new Set<string>();
  const skus = new Map<string, string>();
  const listingFacts = new Map<string, string>();
  for (const row of rows) {
    validateIdentity(row);
    const hash = normalizedCsvRowHash(row);
    if (rowHashes.has(hash)) {
      throw new PubkyShopError("duplicate_row", {
        ...(row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow }),
      });
    }
    rowHashes.add(hash);
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
    const cells = canonicalCells(row);
    const facts = canonicalJson(
      Object.fromEntries(LISTING_COLUMNS.map((column) => [column, cells[column]])),
    );
    const priorFacts = listingFacts.get(identity);
    if (priorFacts !== undefined && priorFacts !== facts) {
      throw new PubkyShopError("conflicting_listing_fields", {
        ...(row.sourceRow === undefined ? {} : { sourceRow: row.sourceRow }),
      });
    }
    listingFacts.set(identity, facts);
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
