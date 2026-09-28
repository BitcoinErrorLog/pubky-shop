import type { CanonicalCsvRow } from "../../csv.js";
import { canonicalJson, type JsonObject, type JsonValue } from "../../json.js";
import { ShopifyBridgeError } from "./errors.js";
import { payloadHash } from "./ids.js";

/** Same listing document the CLI import writes from canonical rows. */
export function catalogRecord(rows: readonly CanonicalCsvRow[]): JsonObject {
  const first = rows[0];
  if (first === undefined) {
    throw new ShopifyBridgeError("empty_listing");
  }
  const sale = first.sale;
  const format =
    sale !== null &&
    typeof sale === "object" &&
    !Array.isArray(sale) &&
    typeof sale.format === "string"
      ? sale.format
      : "fixed_price";
  return {
    recordType: "listing",
    schemaVersion: 1,
    title: first.title,
    revision: first.recordRevision,
    location: {},
    media: first.media as JsonValue,
    variants: rows.map((row) => ({
      id: row.variantId,
      enabled: row.variantEnabled,
      quantity: row.variantQuantity,
      sku: row.sku,
    })),
    shippingOptions: first.shippingOptions as JsonValue,
    sale: {
      acceptsOffers: false,
      format,
      unitPrice: {
        amountMinor: first.amountMinor,
        currency: first.currency,
        exponent: first.exponent,
      },
    },
  };
}

export function catalogRecordText(rows: readonly CanonicalCsvRow[]): string {
  return canonicalJson(catalogRecord(rows));
}

/** Product identity for revision-1 comparisons. Location stock is not part of it. */
export function stockNeutralCatalogFingerprint(
  recordText: string,
  mediaBase64: readonly string[],
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(recordText);
  } catch {
    throw new ShopifyBridgeError("empty_listing");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ShopifyBridgeError("empty_listing");
  }
  const record = parsed as JsonObject & { variants?: JsonValue };
  if (Array.isArray(record.variants)) {
    record.variants = record.variants.map((variant) => {
      if (variant === null || typeof variant !== "object" || Array.isArray(variant)) {
        return variant;
      }
      return { ...variant, quantity: 0 };
    });
  }
  return payloadHash(
    new TextEncoder().encode(`${canonicalJson(record)}\n${mediaBase64.join("\n")}`),
  );
}

export function listingRecordPath(listingId: string): string {
  return `/pub/pubky.app/marketplace/v1/listings/${listingId}`;
}

export function mediaRecordPath(listingId: string, mediaId: string): string {
  return `/pub/pubky.app/marketplace/v1/listings/${listingId}/media/${mediaId}`;
}
