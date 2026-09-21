import { PubkyShopError, type SdkResult, err, ok } from "./errors.js";
import { sha256Hex } from "./hash.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type LosslessJsonPrimitive = JsonPrimitive | bigint;
export type LosslessJsonValue = LosslessJsonPrimitive | LosslessJsonValue[] | LosslessJsonObject;
export interface LosslessJsonObject {
  [key: string]: LosslessJsonValue;
}

export interface JsonLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxStringBytes: number;
}

export const DEFAULT_JSON_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 32,
  maxNodes: 250_000,
  maxStringBytes: 1024 * 1024,
});

const encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const jsonNumberToken = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

function mergeLimits(overrides: Partial<JsonLimits> | undefined): JsonLimits {
  const limits = { ...DEFAULT_JSON_LIMITS, ...overrides };
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new PubkyShopError("invalid_configuration", { field });
    }
  }
  return limits;
}

function limit(field: string, maximum: number, observed: number): never {
  throw new PubkyShopError("limit_exceeded", {
    field,
    limit: maximum,
    observed: Math.min(observed, maximum + 1),
  });
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new PubkyShopError("unsupported_json_value");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new PubkyShopError("unsupported_json_value");
    }
  }
}

function canonicalize(value: unknown, stack: Set<object>): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new PubkyShopError("unsupported_json_value");
      }
      return JSON.stringify(value);
    }
    case "bigint":
      return value.toString(10);
    case "string":
      assertUnicodeScalarString(value);
      return JSON.stringify(value);
    case "object": {
      if (stack.has(value)) {
        throw new PubkyShopError("unsupported_json_value");
      }
      stack.add(value);
      try {
        if (Array.isArray(value)) {
          const items: string[] = [];
          for (let index = 0; index < value.length; index += 1) {
            if (!(index in value)) {
              throw new PubkyShopError("unsupported_json_value");
            }
            items.push(canonicalize(value[index], stack));
          }
          return `[${items.join(",")}]`;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new PubkyShopError("unsupported_json_value");
        }
        const entries = Object.keys(value)
          .sort()
          .map((key) => {
            assertUnicodeScalarString(key);
            return `${JSON.stringify(key)}:${canonicalize(Reflect.get(value, key), stack)}`;
          });
        return `{${entries.join(",")}}`;
      } finally {
        stack.delete(value);
      }
    }
    default:
      throw new PubkyShopError("unsupported_json_value");
  }
}

/** RFC 8785 JSON Canonicalization Scheme text, without a record delimiter. */
export function canonicalJson(value: JsonValue): string {
  return canonicalize(value, new Set());
}

/** Deterministic JSON text that emits bigint values as exact integer tokens. */
export function canonicalJsonLossless(value: LosslessJsonValue): string {
  return canonicalize(value, new Set());
}

/** RFC 8785 UTF-8 bytes with exactly one trailing LF. */
export function encodeCanonicalJson(value: JsonValue): Uint8Array {
  return encoder.encode(`${canonicalJson(value)}\n`);
}

class BoundedJsonParser {
  readonly #text: string;
  readonly #limits: JsonLimits;
  #index = 0;
  #nodes = 0;
  readonly #losslessIntegers: boolean;

  constructor(text: string, limits: JsonLimits, losslessIntegers = false) {
    this.#text = text;
    this.#limits = limits;
    this.#losslessIntegers = losslessIntegers;
  }

  parse(): LosslessJsonValue {
    this.#space();
    const value = this.#value(0);
    this.#space();
    if (this.#index !== this.#text.length) {
      throw new PubkyShopError("invalid_json");
    }
    return value;
  }

  #node(): void {
    this.#nodes += 1;
    if (this.#nodes > this.#limits.maxNodes) {
      limit("json_nodes", this.#limits.maxNodes, this.#nodes);
    }
  }

  #value(depth: number): LosslessJsonValue {
    if (depth > this.#limits.maxDepth) {
      limit("json_nesting_depth", this.#limits.maxDepth, depth);
    }
    this.#node();
    const current = this.#text[this.#index];
    if (current === '"') {
      return this.#string();
    }
    if (current === "{") {
      return this.#object(depth + 1);
    }
    if (current === "[") {
      return this.#array(depth + 1);
    }
    if (this.#text.startsWith("true", this.#index)) {
      this.#index += 4;
      return true;
    }
    if (this.#text.startsWith("false", this.#index)) {
      this.#index += 5;
      return false;
    }
    if (this.#text.startsWith("null", this.#index)) {
      this.#index += 4;
      return null;
    }
    return this.#number();
  }

  #string(): string {
    const start = this.#index;
    this.#index += 1;
    let escaped = false;
    while (this.#index < this.#text.length) {
      const character = this.#text[this.#index];
      this.#index += 1;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        const token = this.#text.slice(start, this.#index);
        let parsed: unknown;
        try {
          parsed = JSON.parse(token);
        } catch {
          throw new PubkyShopError("invalid_json");
        }
        if (typeof parsed !== "string") {
          throw new PubkyShopError("invalid_json");
        }
        assertUnicodeScalarString(parsed);
        const bytes = encoder.encode(parsed).byteLength;
        if (bytes > this.#limits.maxStringBytes) {
          limit("json_string_bytes", this.#limits.maxStringBytes, bytes);
        }
        return parsed;
      } else if (character !== undefined && character.charCodeAt(0) < 0x20) {
        throw new PubkyShopError("invalid_json");
      }
    }
    throw new PubkyShopError("invalid_json");
  }

  #number(): number | bigint {
    jsonNumberToken.lastIndex = this.#index;
    const match = jsonNumberToken.exec(this.#text);
    if (!match) {
      throw new PubkyShopError("invalid_json");
    }
    this.#index = jsonNumberToken.lastIndex;
    const token = match[0];
    if (this.#losslessIntegers && !token.includes(".") && !/[eE]/.test(token)) {
      try {
        return BigInt(token);
      } catch {
        throw new PubkyShopError("invalid_json");
      }
    }
    const parsed = Number(token);
    if (!Number.isFinite(parsed)) {
      throw new PubkyShopError("invalid_json");
    }
    return parsed;
  }

  #object(depth: number): LosslessJsonObject {
    this.#index += 1;
    this.#space();
    const value: LosslessJsonObject = Object.create(null) as LosslessJsonObject;
    const keys = new Set<string>();
    if (this.#text[this.#index] === "}") {
      this.#index += 1;
      return value;
    }
    while (this.#index < this.#text.length) {
      if (this.#text[this.#index] !== '"') {
        throw new PubkyShopError("invalid_json");
      }
      const key = this.#string();
      if (keys.has(key)) {
        throw new PubkyShopError("invalid_json");
      }
      keys.add(key);
      this.#space();
      if (this.#text[this.#index] !== ":") {
        throw new PubkyShopError("invalid_json");
      }
      this.#index += 1;
      this.#space();
      value[key] = this.#value(depth);
      this.#space();
      const delimiter = this.#text[this.#index];
      this.#index += 1;
      if (delimiter === "}") {
        return value;
      }
      if (delimiter !== ",") {
        throw new PubkyShopError("invalid_json");
      }
      this.#space();
    }
    throw new PubkyShopError("invalid_json");
  }

  #array(depth: number): LosslessJsonValue[] {
    this.#index += 1;
    this.#space();
    const value: LosslessJsonValue[] = [];
    if (this.#text[this.#index] === "]") {
      this.#index += 1;
      return value;
    }
    while (this.#index < this.#text.length) {
      value.push(this.#value(depth));
      this.#space();
      const delimiter = this.#text[this.#index];
      this.#index += 1;
      if (delimiter === "]") {
        return value;
      }
      if (delimiter !== ",") {
        throw new PubkyShopError("invalid_json");
      }
      this.#space();
    }
    throw new PubkyShopError("invalid_json");
  }

  #space(): void {
    while (this.#index < this.#text.length) {
      const code = this.#text.charCodeAt(this.#index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
        return;
      }
      this.#index += 1;
    }
  }
}

export function parseBoundedJson(
  input: Uint8Array | string,
  overrides?: Partial<JsonLimits>,
): JsonValue {
  const limits = mergeLimits(overrides);
  let text: string;
  if (typeof input === "string") {
    const bytes = encoder.encode(input);
    if (bytes.byteLength > limits.maxBytes) {
      limit("json_bytes", limits.maxBytes, bytes.byteLength);
    }
    text = input;
  } else {
    if (input.byteLength > limits.maxBytes) {
      limit("json_bytes", limits.maxBytes, input.byteLength);
    }
    try {
      text = utf8Decoder.decode(input);
    } catch {
      throw new PubkyShopError("invalid_json");
    }
  }
  return new BoundedJsonParser(text, limits).parse() as JsonValue;
}

export function parseBoundedJsonLossless(
  input: Uint8Array | string,
  overrides?: Partial<JsonLimits>,
): LosslessJsonValue {
  const limits = mergeLimits(overrides);
  let text: string;
  if (typeof input === "string") {
    const bytes = encoder.encode(input);
    if (bytes.byteLength > limits.maxBytes) {
      limit("json_bytes", limits.maxBytes, bytes.byteLength);
    }
    text = input;
  } else {
    if (input.byteLength > limits.maxBytes) {
      limit("json_bytes", limits.maxBytes, input.byteLength);
    }
    try {
      text = utf8Decoder.decode(input);
    } catch {
      throw new PubkyShopError("invalid_json");
    }
  }
  return new BoundedJsonParser(text, limits, true).parse();
}

export interface PubkyShopExportEnvelope extends JsonObject {
  schemaVersion: 1;
  kind: "pubky-shop-export";
  sellerPubky: string;
  cursor: string | null;
  listings: JsonObject[];
  drops: JsonValue[];
  orders: JsonValue[];
}

const PROJECTION_FIELDS = new Set([
  "aggregate_id",
  "server_revision",
  "stock",
  "authority",
  "available",
  "reserved",
  "sold",
  "total",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateExportEnvelope(value: JsonValue): asserts value is PubkyShopExportEnvelope {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "pubky-shop-export" ||
    typeof value.sellerPubky !== "string" ||
    !(typeof value.cursor === "string" || value.cursor === null) ||
    !Array.isArray(value.listings) ||
    !Array.isArray(value.drops) ||
    !Array.isArray(value.orders)
  ) {
    throw new PubkyShopError("validation_failed");
  }
  for (const listing of value.listings) {
    if (
      !isObject(listing) ||
      typeof listing.recordUri !== "string" ||
      !isObject(listing.record) ||
      !isObject(listing.projection)
    ) {
      throw new PubkyShopError("validation_failed");
    }
    for (const field of PROJECTION_FIELDS) {
      if (Object.hasOwn(listing.record, field)) {
        throw new PubkyShopError("validation_failed", { field });
      }
    }
  }
}

export function decodeExportEnvelope(
  input: Uint8Array,
  limits?: Partial<JsonLimits>,
): PubkyShopExportEnvelope {
  const value = parseBoundedJson(input, limits);
  validateExportEnvelope(value);
  return value;
}

export function encodeExportEnvelope(envelope: PubkyShopExportEnvelope): Uint8Array {
  validateExportEnvelope(envelope);
  return encodeCanonicalJson(envelope);
}

export interface SignedRecordCapture {
  readonly rawBytes: Uint8Array;
  readonly sha256: string;
  readonly parsed: JsonObject;
}

export type SignedRecordValidator = (record: JsonObject) => boolean;

export function captureSignedRecord(
  rawBytes: Uint8Array,
  limits?: Partial<JsonLimits>,
): SignedRecordCapture {
  const parsed = parseBoundedJson(rawBytes, limits);
  if (!isObject(parsed)) {
    throw new PubkyShopError("validation_failed");
  }
  return Object.freeze({
    rawBytes: rawBytes.slice(),
    sha256: sha256Hex(rawBytes),
    parsed,
  });
}

export function emitSignedRecord(
  capture: SignedRecordCapture,
  changedRecord?: JsonObject,
  validator?: SignedRecordValidator,
): SdkResult<Uint8Array> {
  if (changedRecord === undefined) {
    const digest = sha256Hex(capture.rawBytes);
    if (digest !== capture.sha256) {
      return err(new PubkyShopError("validation_failed"));
    }
    return ok(capture.rawBytes.slice());
  }
  if (validator === undefined) {
    return err(new PubkyShopError("unsupported_record_version_or_field"));
  }
  let valid = false;
  try {
    valid = validator(changedRecord);
  } catch {
    return err(new PubkyShopError("unsupported_record_version_or_field"));
  }
  if (!valid) {
    return err(new PubkyShopError("unsupported_record_version_or_field"));
  }
  for (const field of PROJECTION_FIELDS) {
    if (Object.hasOwn(changedRecord, field)) {
      return err(new PubkyShopError("validation_failed", { field }));
    }
  }
  try {
    return ok(encodeCanonicalJson(changedRecord));
  } catch {
    return err(new PubkyShopError("unsupported_record_version_or_field"));
  }
}

export { sha256Hex, sha256HexSubtle } from "./hash.js";
