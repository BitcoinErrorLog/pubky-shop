import {
  KNOWN_SERVICE_ERROR_CODES,
  PubkyShopError,
  type KnownServiceErrorCode,
  type SdkResult,
  err,
  ok,
} from "./errors.js";
import { type JsonObject, type JsonValue, canonicalJson, parseBoundedJson } from "./json.js";

export interface PubkyShopClientConfig {
  readonly session: string;
  readonly serviceUrl: string | URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxResponseBytes?: number;
}

export interface StockView extends JsonObject {
  authority: "listing_total";
  total: number;
  available: number;
  reserved: number;
  sold: number;
}

export interface InventoryProjection extends JsonObject {
  schema_version: 1;
  kind: "inventory_projection";
  aggregate_id: string;
  seller_pubky: string;
  listing_id: string;
  server_revision: number;
  stock: StockView;
}

export interface VariantAssertion {
  readonly id?: string;
  readonly sku?: string;
}

export interface ExternalReference {
  readonly channel: string;
  readonly external_id: string;
}

export interface InventoryAdjustRequest {
  readonly schema_version: 1;
  readonly kind: "inventory.adjust";
  readonly aggregate_id: string;
  readonly listing_id: string;
  readonly expected_revision: number;
  readonly delta: number;
  readonly idempotency_key: string;
  readonly variant?: VariantAssertion;
  readonly external_ref?: ExternalReference;
}

export interface InventoryAdjustmentResult extends JsonObject {
  aggregate_id: string;
  listing_id: string;
  server_revision: number;
  event_id: string;
  stock: StockView;
}

export interface InventoryAdjustmentEnvelope extends JsonObject {
  schema_version: 1;
  ok: true;
  result: InventoryAdjustmentResult;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9_.-]+$/;
const CHANNEL = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const knownServiceCodes = new Set<string>(KNOWN_SERVICE_ERROR_CODES);

function validateServiceUrl(input: string | URL): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new PubkyShopError("invalid_service_url");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    parsed.search !== "" ||
    parsed.pathname !== "/"
  ) {
    throw new PubkyShopError("invalid_service_url");
  }
  return new URL(parsed.origin);
}

function validateSession(session: string): void {
  if (
    session.length < 1 ||
    session.length > 4096 ||
    [...session].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    })
  ) {
    throw new PubkyShopError("invalid_session");
  }
}

function safeInteger(value: JsonValue | undefined, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function object(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeStock(value: JsonValue | undefined): StockView {
  const combined =
    object(value) &&
    typeof value.available === "number" &&
    typeof value.reserved === "number" &&
    typeof value.sold === "number"
      ? value.available + value.reserved + value.sold
      : Number.NaN;
  if (
    !object(value) ||
    value.authority !== "listing_total" ||
    !safeInteger(value.total) ||
    !safeInteger(value.available) ||
    !safeInteger(value.reserved) ||
    !safeInteger(value.sold) ||
    !Number.isSafeInteger(combined) ||
    combined !== value.total
  ) {
    throw new PubkyShopError("invalid_response");
  }
  return value as StockView;
}

export function decodeInventoryProjection(value: JsonValue): InventoryProjection {
  if (
    !object(value) ||
    value.schema_version !== 1 ||
    value.kind !== "inventory_projection" ||
    typeof value.aggregate_id !== "string" ||
    value.aggregate_id.length < 1 ||
    value.aggregate_id.length > 256 ||
    typeof value.seller_pubky !== "string" ||
    value.seller_pubky.length !== 52 ||
    typeof value.listing_id !== "string" ||
    !ID.test(value.listing_id) ||
    value.listing_id.length > 128 ||
    !safeInteger(value.server_revision, 1)
  ) {
    throw new PubkyShopError("invalid_response");
  }
  decodeStock(value.stock);
  return value as InventoryProjection;
}

export function decodeInventoryAdjustment(value: JsonValue): InventoryAdjustmentEnvelope {
  if (
    !object(value) ||
    value.schema_version !== 1 ||
    value.ok !== true ||
    !object(value.result) ||
    typeof value.result.aggregate_id !== "string" ||
    typeof value.result.listing_id !== "string" ||
    !ID.test(value.result.listing_id) ||
    !safeInteger(value.result.server_revision, 1) ||
    typeof value.result.event_id !== "string" ||
    !UUID.test(value.result.event_id)
  ) {
    throw new PubkyShopError("invalid_response");
  }
  decodeStock(value.result.stock);
  return value as InventoryAdjustmentEnvelope;
}

function validatePrintable(value: string, maximum: number): boolean {
  return (
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= maximum &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  );
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

function validateAdjustRequest(request: InventoryAdjustRequest): JsonObject {
  if (
    !hasOnlyKeys(request, [
      "schema_version",
      "kind",
      "aggregate_id",
      "listing_id",
      "expected_revision",
      "delta",
      "idempotency_key",
      "variant",
      "external_ref",
    ]) ||
    request.schema_version !== 1 ||
    request.kind !== "inventory.adjust" ||
    !validatePrintable(request.aggregate_id, 256) ||
    !ID.test(request.listing_id) ||
    request.listing_id.length > 128 ||
    !Number.isSafeInteger(request.expected_revision) ||
    request.expected_revision < 1 ||
    !Number.isSafeInteger(request.delta) ||
    request.delta === 0 ||
    Math.abs(request.delta) > 1_000_000 ||
    !UUID.test(request.idempotency_key)
  ) {
    throw new PubkyShopError("validation_failed");
  }
  if (
    request.variant !== undefined &&
    (!hasOnlyKeys(request.variant, ["id", "sku"]) ||
      (request.variant.id === undefined && request.variant.sku === undefined))
  ) {
    throw new PubkyShopError("validation_failed");
  }
  if (
    request.variant?.id !== undefined &&
    (!ID.test(request.variant.id) || request.variant.id.length > 128)
  ) {
    throw new PubkyShopError("validation_failed");
  }
  if (request.variant?.sku !== undefined && !validatePrintable(request.variant.sku, 128)) {
    throw new PubkyShopError("validation_failed");
  }
  if (
    request.external_ref !== undefined &&
    (!hasOnlyKeys(request.external_ref, ["channel", "external_id"]) ||
      !CHANNEL.test(request.external_ref.channel) ||
      !validatePrintable(request.external_ref.external_id, 128))
  ) {
    throw new PubkyShopError("validation_failed");
  }
  return request as unknown as JsonObject;
}

async function readBoundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maximum) {
      throw new PubkyShopError("response_limit_exceeded", {
        limit: maximum,
        observed: maximum + 1,
      });
    }
  }
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new PubkyShopError("response_limit_exceeded", {
          limit: maximum,
          observed: maximum + 1,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function decodeKnownServiceCode(value: JsonValue): KnownServiceErrorCode | undefined {
  if (!object(value) || !object(value.error) || typeof value.error.code !== "string") {
    return undefined;
  }
  return knownServiceCodes.has(value.error.code)
    ? (value.error.code as KnownServiceErrorCode)
    : undefined;
}

/**
 * Wave 1 inventory client. The bearer is host-owned and is only ever attached
 * to requests whose computed origin equals the constructor-validated origin.
 * Redirects are not followed, so the header cannot cross an authority change.
 */
export class PubkyShopClient {
  readonly #origin: string;
  readonly #session: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #maxResponseBytes: number;

  constructor(config: PubkyShopClientConfig) {
    const serviceUrl = validateServiceUrl(config.serviceUrl);
    validateSession(config.session);
    const maximum = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(maximum) || maximum < 1024 || maximum > 64 * 1024 * 1024) {
      throw new PubkyShopError("invalid_configuration", { field: "maxResponseBytes" });
    }
    this.#origin = serviceUrl.origin;
    this.#session = config.session;
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#maxResponseBytes = maximum;
  }

  async getInventoryProjection(aggregateId: string): Promise<SdkResult<InventoryProjection>> {
    if (aggregateId.length < 1 || aggregateId.length > 256) {
      return err(new PubkyShopError("validation_failed", { field: "aggregateId" }));
    }
    return this.#request(
      `/v1/inventory/listings/${encodeURIComponent(aggregateId)}`,
      "GET",
      undefined,
      decodeInventoryProjection,
    );
  }

  async adjustInventory(
    request: InventoryAdjustRequest,
  ): Promise<SdkResult<InventoryAdjustmentEnvelope>> {
    let body: string;
    try {
      body = canonicalJson(validateAdjustRequest(request));
    } catch {
      return err(new PubkyShopError("validation_failed"));
    }
    return this.#request("/v1/inventory/adjust", "POST", body, decodeInventoryAdjustment);
  }

  async #request<T>(
    path: string,
    method: "GET" | "POST",
    body: string | undefined,
    decode: (value: JsonValue) => T,
  ): Promise<SdkResult<T>> {
    const target = new URL(path, this.#origin);
    if (target.origin !== this.#origin) {
      return err(new PubkyShopError("origin_violation"));
    }
    let response: Response;
    try {
      response = await this.#fetch(target, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#session}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
      });
    } catch {
      return err(new PubkyShopError("transport_error"));
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      return err(new PubkyShopError("session_rejected", { status: 401 }));
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(response, this.#maxResponseBytes);
    } catch (error) {
      return err(
        error instanceof PubkyShopError ? error : new PubkyShopError("response_limit_exceeded"),
      );
    }
    let value: JsonValue;
    try {
      value = parseBoundedJson(bytes, {
        maxBytes: this.#maxResponseBytes,
        maxDepth: 32,
        maxNodes: 100_000,
        maxStringBytes: 256 * 1024,
      });
    } catch {
      return err(new PubkyShopError("invalid_response", { status: response.status }));
    }
    if (!response.ok) {
      const serviceCode = decodeKnownServiceCode(value);
      return err(
        new PubkyShopError(
          "service_error",
          serviceCode === undefined
            ? { status: response.status }
            : { status: response.status, serviceCode },
        ),
      );
    }
    try {
      return ok(decode(value));
    } catch {
      return err(new PubkyShopError("invalid_response", { status: response.status }));
    }
  }
}
