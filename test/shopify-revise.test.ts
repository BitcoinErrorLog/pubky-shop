import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { filesystemHomeserverSessionStore } from "../src/cli/credentials.js";
import { wrapSession } from "../src/cli/homeserver.js";
import type { HomeserverSession } from "../src/cli/proof.js";
import { PubkyShopClient } from "../src/client.js";
import {
  type ApplyContext,
  applyOutboundEvent,
  applyShopifyProductCsv,
  applyShopifyWebhook,
  type BridgeSecrets,
  canonicalRowsFor,
  type HomeserverWriter,
  LIVE_SHOPIFY_BOUNDARY,
  mapShopifyProductCsv,
  ShopifyBridgeError,
  shopifyAdminHttp,
  shopifyGid,
  verifyShopifyHmac,
  writeBridgeSecrets,
} from "../src/connectors/shopify/index.js";
import { csvProductSourceHash } from "../src/connectors/shopify/map.js";
import { FileCatalog, FileReceiptLog } from "../src/connectors/shopify/receipts.js";
import { writerFromHomeserverSession } from "../src/connectors/shopify/session-writer.js";
import { SELLER_PUBKY } from "./helpers.js";

const TOKEN = "shpat_canarytokenvalue123456";
const SESSION = "pubky-session-canary-value-123456";
const WEBHOOK_SECRET = "shpss_canarywebhooksecret1234";
const NOW = Date.parse("2026-01-15T12:00:00.000Z");
const LOCATION = "905684977";
const ITEM = "gid://shopify/InventoryItem/808950810";

function fixture(name: string): URL {
  return new URL(`../../test/fixtures/shopify/${name}`, import.meta.url);
}

function secrets(): BridgeSecrets {
  return {
    shopDomain: "fixture-shop.myshopify.com",
    shopId: "646096977",
    adminAccessToken: TOKEN,
    webhookSecret: WEBHOOK_SECRET,
    locationId: LOCATION,
    currency: "USD",
    exponent: 2,
    sellerPubky: SELLER_PUBKY,
    serviceUrl: "https://inventory.example",
    pubkySession: SESSION,
    pubkyWebhookSecret: "",
    pubkyWebhookKeyId: "",
  };
}

function sign(raw: Uint8Array): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("base64");
}

function headers(
  raw: Uint8Array,
  topic: string,
  webhookId: string,
  eventId: string,
  triggeredAt = "2026-01-15T12:00:00.000Z",
) {
  return {
    hmac: sign(raw),
    topic,
    shopDomain: "fixture-shop.myshopify.com",
    webhookId,
    eventId,
    triggeredAt,
  };
}

function productBody(title: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      id: 1001,
      title,
      body_html: "",
      vendor: "Acme",
      product_type: "Boots",
      handle: "night-boots",
      status: "active",
      published_at: "2026-01-01T00:00:00Z",
      tags: "",
      variants: [
        {
          id: 2002,
          title: "M",
          price: "125.00",
          sku: "BOOT-M",
          inventory_item_id: 808950810,
          inventory_quantity: 19,
        },
      ],
    }),
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function syncItem(status: number) {
  return {
    schema_version: 1,
    kind: "listing.sync_many",
    results: [
      {
        seller_pubky: SELLER_PUBKY,
        listing_id: "night-boots",
        status,
        result:
          status >= 200 && status < 300
            ? { ok: true }
            : { ok: false, error: { code: "sync", message: "no" } },
      },
    ],
  };
}

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "shopify-revise-"));
}

test("current Shopify CSV headers map and do not publish unscoped quantity", async () => {
  const bytes = await readFile(fixture("product-current.csv"));
  const mapped = mapShopifyProductCsv(bytes, {
    sellerPubky: SELLER_PUBKY,
    currency: "USD",
    exponent: 2,
  });
  assert.equal(mapped.products.length, 1);
  assert.equal(mapped.skipped.length, 1);
  const product = mapped.products[0];
  assert.ok(product);
  assert.equal(product.title, "Night Boots");
  assert.equal(product.description, "Lined boots");
  assert.deepEqual(
    product.variants.map((variant) => variant.quantity),
    [0, 0],
  );
  assert.equal(canonicalRowsFor(product).length, 0);
  for (const code of [
    "csv_quantity_unscoped",
    "market_price_list",
    "barcode",
    "seo",
    "cost",
    "collection",
    "html_body",
  ]) {
    assert.equal(
      mapped.headerLosses.some((entry) => entry.code === code) ||
        product.losses.some((entry) => entry.code === code),
      true,
      code,
    );
  }
});

test("malformed Shopify HMAC and clock skew fail closed on the webhook path", async () => {
  const raw = new TextEncoder().encode("{}");
  const signature = sign(raw);
  assert.equal(verifyShopifyHmac(raw, signature, WEBHOOK_SECRET), true);
  assert.equal(verifyShopifyHmac(raw, `${signature}!!!!`, WEBHOOK_SECRET), false);
  const directory = await scratch();
  const ctx = context(directory, async () => json({ ok: false }, 404), {
    async putText() {},
    async putBytes() {},
  });
  const stale = await applyShopifyWebhook(
    raw,
    headers(
      raw,
      "products/update",
      "00000000-0000-4000-8000-0000000000a1",
      "evt-stale",
      "2026-01-15T11:00:00.000Z",
    ),
    ctx,
  );
  assert.equal(stale.reason, "clock_skew");
  const edge = await applyShopifyWebhook(
    raw,
    headers(
      raw,
      "products/update",
      "00000000-0000-4000-8000-0000000000a2",
      "evt-edge",
      "2026-01-15T12:05:00.000Z",
    ),
    ctx,
  );
  assert.notEqual(edge.reason, "clock_skew");
  const past = await applyShopifyWebhook(
    raw,
    headers(
      raw,
      "products/update",
      "00000000-0000-4000-8000-0000000000a3",
      "evt-past",
      "2026-01-15T12:05:00.001Z",
    ),
    ctx,
  );
  assert.equal(past.reason, "clock_skew");
  const bad = await applyShopifyWebhook(
    raw,
    {
      ...headers(raw, "products/update", "00000000-0000-4000-8000-0000000000a4", "evt-bad"),
      hmac: `${signature}!!!!`,
    },
    ctx,
  );
  assert.equal(bad.reason, "bad_hmac");
});

test("sync-many item 404 and 409 quarantine and 500 retries", async () => {
  const body = productBody("Night Boots");
  const seen: number[] = [];
  let mode = 404;
  const directory = await scratch();
  let puts = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("myshopify.com")) {
      return levels(4);
    }
    if (url.includes("/v1/listings/sync-many")) {
      seen.push(mode);
      return json(syncItem(mode), 207);
    }
    if (url.includes("/v1/inventory/listings/")) {
      return json({ ok: false, error: { code: "listing_not_found", message: "missing" } }, 404);
    }
    return json({ ok: false, error: { code: "invalid_request", message: "no" } }, 404);
  };
  const ctx = context(directory, fetchImpl, {
    async putText() {
      puts += 1;
    },
    async putBytes() {},
  });
  const missing = await applyShopifyWebhook(
    body,
    headers(body, "products/update", "00000000-0000-4000-8000-0000000000b1", "evt-404"),
    ctx,
  );
  assert.equal(missing.outcome, "quarantined");
  assert.equal(missing.reason, "sync_item_rejected");
  assert.equal(puts, 1);
  mode = 409;
  const conflict = await applyShopifyWebhook(
    productBody("Night Boots"),
    headers(
      productBody("Night Boots"),
      "products/update",
      "00000000-0000-4000-8000-0000000000b2",
      "evt-409",
    ),
    ctx,
  );
  assert.equal(conflict.outcome, "quarantined");
  assert.equal(conflict.reason, "sync_item_rejected");
  mode = 500;
  const retryBody = productBody("Night Boots");
  const retryHeaders = headers(
    retryBody,
    "products/update",
    "00000000-0000-4000-8000-0000000000b3",
    "evt-500",
  );
  const retry = await applyShopifyWebhook(retryBody, retryHeaders, ctx);
  assert.equal(retry.outcome, "rejected");
  assert.equal(retry.reason, "sync_item_retry");
  mode = 207;
  const recovered = await applyShopifyWebhook(retryBody, retryHeaders, ctx);
  assert.equal(recovered.outcome, "applied");
  assert.deepEqual(seen, [404, 409, 500, 207]);
});

test("a later product update quarantines instead of rewriting revision 1", async () => {
  const first = productBody("Night Boots");
  const changed = productBody("Revised Boots");
  let puts = 0;
  const directory = await scratch();
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("myshopify.com")) {
      return levels(4);
    }
    if (url.includes("/v1/listings/sync-many")) {
      return json(syncItem(207), 207);
    }
    if (url.includes("/v1/inventory/listings/")) {
      return json({ ok: false, error: { code: "listing_not_found", message: "missing" } }, 404);
    }
    return json({ ok: false, error: { code: "invalid_request", message: "no" } }, 404);
  };
  const ctx = context(directory, fetchImpl, {
    async putText() {
      puts += 1;
    },
    async putBytes() {},
  });
  const imported = await applyShopifyWebhook(
    first,
    headers(first, "products/update", "00000000-0000-4000-8000-0000000000c1", "evt-import"),
    ctx,
  );
  assert.equal(imported.outcome, "applied");
  assert.equal(puts, 1);
  const replay = await applyShopifyWebhook(
    first,
    headers(first, "products/update", "00000000-0000-4000-8000-0000000000c2", "evt-import"),
    ctx,
  );
  assert.equal(replay.outcome, "replayed");
  assert.equal(puts, 1);
  const unchanged = await applyShopifyWebhook(
    first,
    headers(first, "products/update", "00000000-0000-4000-8000-0000000000c4", "evt-same-catalog"),
    ctx,
  );
  assert.equal(unchanged.outcome, "ignored");
  assert.equal(unchanged.reason, "catalog_unchanged");
  assert.equal(puts, 1);
  const next = await applyShopifyWebhook(
    changed,
    headers(changed, "products/update", "00000000-0000-4000-8000-0000000000c3", "evt-revised"),
    ctx,
  );
  assert.equal(next.outcome, "quarantined");
  assert.equal(next.reason, "catalog_changed");
  assert.equal(puts, 1);
});

test("a CSV edit of another product does not quarantine this product", async () => {
  const first = new TextEncoder().encode(
    "URL handle,Title,Price,SKU,Published on online store,Status\nnight-boots,Night Boots,10.00,BOOT-M,true,active\nother-boot,Other,10.00,BOOT-X,true,active\n",
  );
  const second = new TextEncoder().encode(
    "URL handle,Title,Price,SKU,Published on online store,Status\nnight-boots,Night Boots,10.00,BOOT-M,true,active\nother-boot,Changed,10.00,BOOT-X,true,active\n",
  );
  assert.equal(
    csvProductSourceHash(first, "night-boots"),
    csvProductSourceHash(second, "night-boots"),
  );
  assert.notEqual(
    csvProductSourceHash(first, "other-boot"),
    csvProductSourceHash(second, "other-boot"),
  );
  const directory = await scratch();
  const fetchImpl: typeof fetch = async () => json({ data: { productVariants: { nodes: [] } } });
  const ctx = context(directory, fetchImpl, { async putText() {}, async putBytes() {} });
  const applied = await applyShopifyProductCsv(first, ctx);
  assert.deepEqual(
    applied.map((result) => result.outcome),
    ["ignored", "ignored"],
  );
  const again = await applyShopifyProductCsv(second, ctx);
  assert.deepEqual(
    again.map((result) => [result.outcome, result.reason]),
    [
      ["replayed", "replay"],
      ["quarantined", "changed_payload"],
    ],
  );
});

test("outbound stock compares quantity and does not set twice after a crash", async () => {
  const event = {
    id: "00000000-0000-4000-8000-0000000000d1",
    type: "inventory.adjusted",
    aggregateId: `listing:${SELLER_PUBKY}_night-boots`,
    revision: "2",
  };
  const hash = "b".repeat(64);
  const staleDir = await scratch();
  await seedCatalog(staleDir, 4);
  let staleSets = 0;
  const stale = await applyOutboundEvent(
    event,
    hash,
    context(
      staleDir,
      shopifyFetch(
        () => 9,
        () => {
          staleSets += 1;
          return setOk();
        },
      ),
      writer(),
    ),
  );
  assert.equal(stale.outcome, "quarantined");
  assert.equal(stale.reason, "shopify_quantity_conflict");
  assert.equal(staleSets, 0);

  const conflictDir = await scratch();
  await seedCatalog(conflictDir, 4);
  let conflictSets = 0;
  let conflictBody = "";
  const conflict = await applyOutboundEvent(
    event,
    hash,
    context(
      conflictDir,
      shopifyFetch(
        () => 4,
        (body) => {
          conflictSets += 1;
          conflictBody = body;
          return setConflict("COMPARE_QUANTITY_STALE");
        },
      ),
      writer(),
    ),
  );
  assert.equal(conflict.outcome, "quarantined");
  assert.equal(conflict.reason, "shopify_quantity_conflict");
  assert.equal(conflictSets, 1);
  assert.equal(conflictBody.includes('"ignoreCompareQuantity":false'), true);
  assert.equal(conflictBody.includes('"compareQuantity":4'), true);
  const conflictAgain = await applyOutboundEvent(
    event,
    hash,
    context(
      conflictDir,
      shopifyFetch(
        () => 4,
        () => {
          conflictSets += 1;
          return setConflict("INVALID_COMPARE_QUANTITY");
        },
      ),
      writer(),
    ),
  );
  assert.equal(conflictAgain.outcome, "quarantined");
  assert.equal(conflictSets, 1);

  const crashDir = await scratch();
  await seedCatalog(crashDir, 4);
  let available = 4;
  let sets = 0;
  let setBody = "";
  const fetchImpl = shopifyFetch(
    () => available,
    (body) => {
      sets += 1;
      setBody = body;
      available = 6;
      return setOk();
    },
  );
  const crashed = context(crashDir, fetchImpl, writer(), "after-remote");
  await assert.rejects(
    () => applyOutboundEvent(event, hash, crashed),
    (error: unknown) => error instanceof ShopifyBridgeError && error.code === "crash_injected",
  );
  assert.equal(sets, 1);
  assert.equal(setBody.includes('"ignoreCompareQuantity":false'), true);
  assert.equal(setBody.includes('"compareQuantity":4'), true);
  const resumed = await applyOutboundEvent(event, hash, context(crashDir, fetchImpl, writer()));
  assert.equal(resumed.outcome, "applied");
  assert.equal(sets, 1);

  const sentDir = await scratch();
  await seedCatalog(sentDir, 4);
  let sentAvailable = 4;
  let sentSets = 0;
  const sentFetch = shopifyFetch(
    () => sentAvailable,
    () => {
      sentSets += 1;
      sentAvailable = 6;
      return setOk();
    },
  );
  await assert.rejects(
    () => applyOutboundEvent(event, hash, context(sentDir, sentFetch, writer(), "effect-sent")),
    (error: unknown) => error instanceof ShopifyBridgeError && error.code === "crash_injected",
  );
  assert.equal(sentSets, 0);
  const sentResumed = await applyOutboundEvent(event, hash, context(sentDir, sentFetch, writer()));
  assert.equal(sentResumed.outcome, "applied");
  assert.equal(sentSets, 1);
});

test("homeserver writer puts bytes on the session and the command does not use a directory", async () => {
  const calls: string[] = [];
  const session: HomeserverSession = {
    pubky: SELLER_PUBKY,
    capabilities: ["/:rw"],
    async putText(filePath) {
      calls.push(`text:${filePath}`);
    },
    async putBytes(filePath, body) {
      calls.push(`bytes:${filePath}:${body.byteLength}`);
    },
    async delete() {},
  };
  assert.equal(LIVE_SHOPIFY_BOUNDARY.homeserverMediaPutOnCliSession, false);
  const writer = writerFromHomeserverSession(session);
  await writer.putBytes(
    "/pub/pubky.app/marketplace/v1/listings/night-boots/media/m1",
    new Uint8Array([1, 2, 3]),
    "image/png",
  );
  assert.equal(calls[0], "bytes:/pub/pubky.app/marketplace/v1/listings/night-boots/media/m1:3");
  let forwarded = 0;
  const wrapped = wrapSession({
    info: { publicKey: { z32: () => SELLER_PUBKY }, capabilities: ["/:rw"] },
    storage: {
      async putText() {},
      async putBytes() {
        forwarded += 1;
      },
      async delete() {},
    },
    free() {},
  } as never);
  await wrapped.putBytes(
    "/pub/pubky.app/marketplace/v1/listings/night-boots/media/m1",
    new Uint8Array([9]),
  );
  assert.equal(forwarded, 1);
  const directory = await scratch();
  await writeBridgeSecrets(path.join(directory, "secrets.json"), secrets());
  const creds = path.join(directory, "creds");
  await filesystemHomeserverSessionStore(creds).put("https://inventory.example", {
    pubky: SELLER_PUBKY,
    secret: "not-a-real-session-secret",
    capabilities: ["/:rw"],
  });
  const bin = fileURLToPath(new URL("../src/connectors/shopify/bin.js", import.meta.url));
  const run = spawnSync(
    process.execPath,
    [
      bin,
      "webhook",
      "--secrets",
      path.join(directory, "secrets.json"),
      "--receipts",
      path.join(directory, "receipts"),
    ],
    {
      encoding: "utf8",
      input: "",
      env: { ...process.env, PUBKY_SHOP_CREDENTIAL_DIR: creds, PUBKY_SHOP_PUBKY: SELLER_PUBKY },
    },
  );
  assert.equal(run.status, 1);
  assert.equal(run.stdout.includes("homeserver_session_invalid"), true);
  assert.equal(run.stdout.includes("--put-dir"), false);
  const refused = spawnSync(
    process.execPath,
    [
      bin,
      "webhook",
      "--secrets",
      path.join(directory, "secrets.json"),
      "--receipts",
      path.join(directory, "receipts"),
      "--put-dir",
      directory,
    ],
    { encoding: "utf8", input: "" },
  );
  assert.equal(refused.status, 2);
  assert.equal(refused.stdout.includes("put-dir is not a homeserver"), true);
  const bare = spawnSync(
    process.execPath,
    [
      bin,
      "webhook",
      "--secrets",
      path.join(directory, "secrets.json"),
      "--receipts",
      path.join(directory, "receipts"),
      "--put-dir",
    ],
    { encoding: "utf8", input: "" },
  );
  assert.equal(bare.status, 2);
  assert.equal(bare.stdout.includes("put-dir is not a homeserver"), true);
  const otherPubky = "z".repeat(52);
  const otherCreds = path.join(directory, "other-creds");
  await filesystemHomeserverSessionStore(otherCreds).put("https://inventory.example", {
    pubky: otherPubky,
    secret: "not-a-real-session-secret",
    capabilities: ["/:rw"],
  });
  const mismatch = spawnSync(
    process.execPath,
    [
      bin,
      "webhook",
      "--secrets",
      path.join(directory, "secrets.json"),
      "--receipts",
      path.join(directory, "receipts"),
    ],
    {
      encoding: "utf8",
      input: "",
      env: { ...process.env, PUBKY_SHOP_CREDENTIAL_DIR: otherCreds, PUBKY_SHOP_PUBKY: otherPubky },
    },
  );
  assert.equal(mismatch.status, 1);
  assert.equal(mismatch.stdout.includes("homeserver_seller_mismatch"), true);
  assert.equal(mismatch.stdout.includes("not-a-real-session-secret"), false);
});

function levels(quantity: number): Response {
  return json({
    data: {
      inventoryItem: {
        id: ITEM,
        inventoryLevels: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              location: { id: shopifyGid("Location", LOCATION) },
              quantities: [{ name: "available", quantity }],
            },
          ],
        },
      },
    },
  });
}

function projection(available: number): Response {
  return json({
    schema_version: 1,
    kind: "inventory_projection",
    aggregate_id: `listing:${SELLER_PUBKY}_night-boots`,
    seller_pubky: SELLER_PUBKY,
    listing_id: "night-boots",
    server_revision: 2,
    stock: { authority: "listing_total", available, reserved: 0, sold: 0, total: available },
  });
}

function writer(): HomeserverWriter {
  return { async putText() {}, async putBytes() {} };
}

async function seedCatalog(directory: string, quantity: number): Promise<void> {
  const catalog = new FileCatalog(directory);
  await catalog.replaceListing(`listing:${SELLER_PUBKY}_night-boots`, [
    {
      listingId: "night-boots",
      aggregateId: `listing:${SELLER_PUBKY}_night-boots`,
      variantId: "BOOT-M",
      sku: "BOOT-M",
      inventoryItemId: ITEM,
      quantity,
    },
  ]);
}

function setOk(): Response {
  return json({
    data: {
      inventorySetQuantities: {
        inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1" },
        userErrors: [],
      },
    },
  });
}

function setConflict(code: string): Response {
  return json({
    data: {
      inventorySetQuantities: {
        inventoryAdjustmentGroup: null,
        userErrors: [{ field: ["compareQuantity"], message: "stale", code }],
      },
    },
  });
}

function shopifyFetch(available: () => number, onSet: (body: string) => Response): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.includes("myshopify.com")) {
      const body = String(init?.body ?? "");
      if (body.includes("inventorySetQuantities")) {
        return onSet(body);
      }
      return levels(available());
    }
    if (url.includes("/v1/inventory/listings/")) {
      return projection(6);
    }
    return json({ ok: false }, 404);
  };
}

function context(
  directory: string,
  fetchImpl: typeof fetch,
  homeserver: HomeserverWriter,
  crashAfterState?: ApplyContext["crashAfterState"],
): ApplyContext {
  const bridgeSecrets = secrets();
  return {
    secrets: bridgeSecrets,
    admin: shopifyAdminHttp({
      shopDomain: bridgeSecrets.shopDomain,
      accessToken: TOKEN,
      fetch: fetchImpl,
    }),
    pubky: new PubkyShopClient({
      session: SESSION,
      serviceUrl: bridgeSecrets.serviceUrl,
      fetch: fetchImpl,
    }),
    homeserver,
    receipts: new FileReceiptLog(directory),
    catalog: new FileCatalog(directory),
    nowMs: NOW,
    downloadFetch: fetchImpl,
    ...(crashAfterState === undefined ? {} : { crashAfterState }),
  };
}
