import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function verifyShopifyHmac(raw: Uint8Array, header: string, secret: string): boolean {
  if (header.length < 1 || header.length > 512 || secret.length < 1) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(raw).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(header, "base64");
  } catch {
    return false;
  }
  if (supplied.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(expected, supplied);
}

export function shopifyTriggeredAtFresh(
  triggeredAt: string,
  nowMs: number,
  maxSkewMs: number,
): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxSkewMs) || maxSkewMs < 0) {
    return false;
  }
  const parsed = Date.parse(triggeredAt);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  return Math.abs(nowMs - parsed) <= maxSkewMs;
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (value.length < 1 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return undefined;
  }
}

export type PubkyWebhookVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "malformed" | "stale" | "wrong_key" | "bad_signature" };

/**
 * Matches the marketplace service verifier: HMAC-SHA256 over
 * `v1.{timestamp}.{eventId}.{raw}` keyed by SHA-256(secret bytes).
 * The secret string is the unpadded base64url value returned by webhook add.
 */
export function verifyPubkyWebhook(input: {
  readonly raw: Uint8Array;
  readonly secretBase64Url: string;
  readonly expectedKeyId: string;
  readonly eventId: string;
  readonly timestamp: string;
  readonly keyId: string;
  readonly signature: string;
  readonly nowSeconds: number;
  readonly maxSkewSeconds: number;
}): PubkyWebhookVerdict {
  if (!UUID.test(input.eventId) || !UUID.test(input.keyId) || !UUID.test(input.expectedKeyId)) {
    return { ok: false, reason: "malformed" };
  }
  if (input.keyId.toLowerCase() !== input.expectedKeyId.toLowerCase()) {
    return { ok: false, reason: "wrong_key" };
  }
  if (!/^[0-9]{1,20}$/.test(input.timestamp)) {
    return { ok: false, reason: "malformed" };
  }
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || !Number.isSafeInteger(input.nowSeconds)) {
    return { ok: false, reason: "malformed" };
  }
  if (Math.abs(timestampSeconds - input.nowSeconds) > input.maxSkewSeconds) {
    return { ok: false, reason: "stale" };
  }
  const suppliedHex = input.signature.startsWith("v1=") ? input.signature.slice(3) : "";
  if (!/^[0-9a-f]{64}$/i.test(suppliedHex)) {
    return { ok: false, reason: "malformed" };
  }
  const secret = decodeBase64Url(input.secretBase64Url);
  if (secret === undefined || secret.length < 16) {
    return { ok: false, reason: "malformed" };
  }
  const key = createHash("sha256").update(secret).digest();
  const signingInput = Buffer.concat([
    Buffer.from("v1."),
    Buffer.from(input.timestamp),
    Buffer.from("."),
    Buffer.from(input.eventId),
    Buffer.from("."),
    Buffer.from(input.raw),
  ]);
  const expected = createHmac("sha256", key).update(signingInput).digest();
  const supplied = Buffer.from(suppliedHex, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}
