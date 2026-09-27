import { sha256Hex } from "../../hash.js";
import { ShopifyBridgeError } from "./errors.js";

const PUBKY_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export function payloadHash(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

/** RFC 4122 UUID derived from SHA-256 so a replay sends the same idempotency key. */
export function idempotencyKeyFor(name: string): string {
  const hex = sha256Hex(new TextEncoder().encode(name)).slice(0, 32).split("");
  hex[12] = "4";
  const variant = Number.parseInt(hex[16] ?? "0", 16);
  hex[16] = (8 | (variant & 0x3)).toString(16);
  const text = hex.join("");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

export function listingAggregateId(sellerPubky: string, listingId: string): string {
  return `listing:${sellerPubky}_${listingId}`;
}

export function isPubkyId(value: string): boolean {
  return PUBKY_ID.test(value);
}

export function shopifyGid(
  type: "InventoryItem" | "Location" | "Product" | "ProductVariant",
  id: string,
): string {
  if (id.startsWith("gid://shopify/")) {
    return id;
  }
  if (!/^[0-9]+$/.test(id)) {
    throw new ShopifyBridgeError("shopify_id");
  }
  return `gid://shopify/${type}/${id}`;
}

export function sameShopifyId(
  left: string,
  right: string,
  type: "Location" | "InventoryItem",
): boolean {
  return shopifyGid(type, left) === shopifyGid(type, right);
}
