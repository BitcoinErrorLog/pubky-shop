import { createHash } from "node:crypto";

export function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function decodeBase64Url(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) {
    throw new TypeError("non-canonical base64url");
  }
  return Uint8Array.from(bytes);
}

export function decodeBase64Url32(value: string): Uint8Array {
  const bytes = decodeBase64Url(value);
  if (bytes.length !== 32) {
    throw new TypeError("expected 32 bytes");
  }
  return bytes;
}

export function sha256Bytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(value).digest());
}
