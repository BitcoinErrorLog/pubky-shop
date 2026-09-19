export const ERROR_CODES = [
  "invalid_configuration",
  "invalid_service_url",
  "invalid_session",
  "origin_violation",
  "session_rejected",
  "transport_error",
  "response_limit_exceeded",
  "invalid_response",
  "service_error",
  "invalid_json",
  "unsupported_json_value",
  "limit_exceeded",
  "malformed_csv",
  "invalid_csv_header",
  "duplicate_row",
  "duplicate_variant_id",
  "ambiguous_sku",
  "conflicting_listing_fields",
  "formula_payload",
  "invalid_identity",
  "invalid_mapping",
  "validation_failed",
  "unsupported_record_version_or_field",
  "manifest_conflict",
  "manifest_store_error",
  "changed_replay_quarantined",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface SafeErrorDetails {
  readonly field?: string;
  readonly limit?: number;
  readonly observed?: number;
  readonly status?: number;
  readonly serviceCode?: KnownServiceErrorCode;
  readonly manifestId?: string;
  readonly rowIdentity?: string;
  readonly sourceRow?: number;
}

export const KNOWN_SERVICE_ERROR_CODES = [
  "capability_required",
  "external_reference_conflict",
  "idempotency_conflict",
  "internal",
  "invalid_request",
  "inventory_invariant_violation",
  "listing_not_found",
  "negative_stock",
  "rate_limited",
  "revision_conflict",
  "seller_ownership_required",
  "stock_overflow",
  "variant_assertion_mismatch",
  "variant_authority_unsupported",
  "variant_lookup_unavailable",
  "variant_record_conflict",
] as const;

export type KnownServiceErrorCode = (typeof KNOWN_SERVICE_ERROR_CODES)[number];

const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  invalid_configuration: "The SDK configuration is invalid.",
  invalid_service_url: "The service URL is invalid.",
  invalid_session: "The service session is invalid.",
  origin_violation: "The request target is outside the configured service origin.",
  session_rejected: "The service session was rejected.",
  transport_error: "The service request failed.",
  response_limit_exceeded: "The service response exceeded its configured limit.",
  invalid_response: "The service returned an invalid response.",
  service_error: "The service rejected the request.",
  invalid_json: "The JSON input is invalid.",
  unsupported_json_value: "The JSON value cannot be serialized canonically.",
  limit_exceeded: "An input limit was exceeded.",
  malformed_csv: "The CSV input is malformed.",
  invalid_csv_header: "The CSV header is invalid.",
  duplicate_row: "The CSV contains a duplicate row.",
  duplicate_variant_id: "The CSV contains a duplicate variant identity.",
  ambiguous_sku: "The CSV contains an ambiguous SKU.",
  conflicting_listing_fields: "Variant rows contain conflicting listing fields.",
  formula_payload: "A CSV cell contains a spreadsheet formula payload.",
  invalid_identity: "A required item identity is invalid.",
  invalid_mapping: "A required import mapping is invalid.",
  validation_failed: "The value failed validation.",
  unsupported_record_version_or_field: "The changed signed record is not supported.",
  manifest_conflict: "The durable manifest changed concurrently.",
  manifest_store_error: "The durable manifest store operation failed.",
  changed_replay_quarantined: "A replayed row changed and was quarantined.",
};

/**
 * SDK errors deliberately expose only static messages and bounded numeric or
 * allowlisted details. Bearers, response bodies, server messages, URLs, CSV
 * cells, and thrown transport text never enter this object.
 */
export class PubkyShopError extends Error {
  readonly code: ErrorCode;
  readonly details: SafeErrorDetails;

  constructor(code: ErrorCode, details: SafeErrorDetails = {}) {
    super(ERROR_MESSAGES[code]);
    this.name = "PubkyShopError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): {
    readonly name: "PubkyShopError";
    readonly code: ErrorCode;
    readonly message: string;
    readonly details: SafeErrorDetails;
  } {
    return {
      name: "PubkyShopError",
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export type SdkResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PubkyShopError };

export function ok<T>(value: T): SdkResult<T> {
  return { ok: true, value };
}

export function err<T = never>(error: PubkyShopError): SdkResult<T> {
  return { ok: false, error };
}

export function asPubkyShopError(error: unknown): PubkyShopError {
  return error instanceof PubkyShopError ? error : new PubkyShopError("invalid_configuration");
}
