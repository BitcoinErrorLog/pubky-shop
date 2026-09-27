import { chmod, readFile, stat, writeFile } from "node:fs/promises";

import { ShopifyBridgeError } from "./errors.js";

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const CURRENCY = /^[A-Z]{3}$/;
const SECRET_TEXT = /^[\x21-\x7e]+$/;

export interface BridgeSecrets {
  readonly shopDomain: string;
  readonly shopId: string;
  readonly adminAccessToken: string;
  readonly webhookSecret: string;
  readonly locationId: string;
  readonly currency: string;
  readonly exponent: number;
  readonly sellerPubky: string;
  readonly serviceUrl: string;
  readonly pubkySession: string;
  readonly pubkyWebhookSecret: string;
  readonly pubkyWebhookKeyId: string;
}

const SECRET_KEYS = [
  "shopDomain",
  "shopId",
  "adminAccessToken",
  "webhookSecret",
  "locationId",
  "currency",
  "exponent",
  "sellerPubky",
  "serviceUrl",
  "pubkySession",
  "pubkyWebhookSecret",
  "pubkyWebhookKeyId",
] as const;

/** Group and world bits are rejected. Owner execute is allowed because some volumes force it. */
export function assertPrivateMode(mode: number): void {
  if ((mode & 0o077) !== 0) {
    throw new ShopifyBridgeError("secret_file_permissions");
  }
}

function secretString(value: unknown, field: string, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    !SECRET_TEXT.test(value)
  ) {
    throw new ShopifyBridgeError("invalid_secret_file", { field });
  }
  return value;
}

function optionalSecret(value: unknown, field: string): string {
  if (value === undefined || value === "") {
    return "";
  }
  return secretString(value, field, 16, 512);
}

export function parseBridgeSecrets(value: unknown): BridgeSecrets {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ShopifyBridgeError("invalid_secret_file");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(SECRET_KEYS as readonly string[]).includes(key)) {
      throw new ShopifyBridgeError("invalid_secret_file", { field: "unknown" });
    }
  }
  const shopDomain = secretString(record.shopDomain, "shopDomain", 1, 255).toLowerCase();
  if (!SHOP_DOMAIN.test(shopDomain)) {
    throw new ShopifyBridgeError("invalid_secret_file", { field: "shopDomain" });
  }
  const currency = secretString(record.currency, "currency", 3, 3);
  if (!CURRENCY.test(currency)) {
    throw new ShopifyBridgeError("invalid_secret_file", { field: "currency" });
  }
  if (
    typeof record.exponent !== "number" ||
    !Number.isInteger(record.exponent) ||
    record.exponent < 0 ||
    record.exponent > 18
  ) {
    throw new ShopifyBridgeError("invalid_secret_file", { field: "exponent" });
  }
  const sellerPubky = secretString(record.sellerPubky, "sellerPubky", 52, 52);
  const serviceUrl = secretString(record.serviceUrl, "serviceUrl", 8, 2048);
  let parsed: URL;
  try {
    parsed = new URL(serviceUrl);
  } catch {
    throw new ShopifyBridgeError("invalid_secret_file", { field: "serviceUrl" });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new ShopifyBridgeError("invalid_secret_file", { field: "serviceUrl" });
  }
  const locationId = secretString(record.locationId, "locationId", 1, 128);
  if (!/^[0-9]+$/.test(locationId) && !locationId.startsWith("gid://shopify/Location/")) {
    throw new ShopifyBridgeError("invalid_secret_file", { field: "locationId" });
  }
  const keyId = optionalSecret(record.pubkyWebhookKeyId, "pubkyWebhookKeyId");
  if (keyId !== "" && !/^[0-9a-f-]{36}$/i.test(keyId)) {
    throw new ShopifyBridgeError("invalid_secret_file", { field: "pubkyWebhookKeyId" });
  }
  return {
    shopDomain,
    shopId: secretString(record.shopId, "shopId", 1, 128),
    adminAccessToken: secretString(record.adminAccessToken, "adminAccessToken", 16, 256),
    webhookSecret: secretString(record.webhookSecret, "webhookSecret", 16, 256),
    locationId,
    currency,
    exponent: record.exponent,
    sellerPubky,
    serviceUrl: parsed.origin,
    pubkySession: secretString(record.pubkySession, "pubkySession", 16, 4096),
    pubkyWebhookSecret: optionalSecret(record.pubkyWebhookSecret, "pubkyWebhookSecret"),
    pubkyWebhookKeyId: keyId,
  };
}

export async function loadBridgeSecrets(file: string): Promise<BridgeSecrets> {
  const info = await stat(file);
  assertPrivateMode(info.mode);
  const raw = await readFile(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ShopifyBridgeError("invalid_secret_file");
  }
  return parseBridgeSecrets(parsed);
}

export async function writeBridgeSecrets(file: string, secrets: BridgeSecrets): Promise<void> {
  const body = `${JSON.stringify(secrets)}\n`;
  await writeFile(file, body, { mode: 0o600 });
  await chmod(file, 0o600);
}

export function secretValues(secrets: BridgeSecrets): readonly string[] {
  return [
    secrets.adminAccessToken,
    secrets.webhookSecret,
    secrets.pubkySession,
    secrets.pubkyWebhookSecret,
  ].filter((value) => value.length > 0);
}
