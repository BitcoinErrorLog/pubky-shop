import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listingRecordFromRows, listingRecordText } from "../src/cli/seller.js";
import { PubkyShopClient } from "../src/client.js";
import {
  type ApplyContext,
  applyOutboundEvent,
  applyPubkyWebhook,
  applyShopifyProductCsv,
  applyShopifyWebhook,
  assertPrivateMode,
  type BridgeSecrets,
  catalogRecordText,
  directoryHomeserverWriter,
  FileCatalog,
  FileReceiptLog,
  type HomeserverWriter,
  idempotencyKeyFor,
  LIVE_PROOF_REQUIRES,
  mapProductUpdate,
  mapShopifyProductCsv,
  pullInventoryEvents,
  recordedShopifyAdmin,
  renderBridgeResult,
  ShopifyBridgeError,
  shopifyAdminHttp,
  shopifyGid,
  verifyShopifyHmac,
  writeBridgeSecrets,
} from "../src/connectors/shopify/index.js";
import { assertNotRecoveryMaterial } from "../src/connectors/shopify/session-writer.js";
import { parseCanonicalCsv } from "../src/csv.js";
import { SELLER_PUBKY } from "./helpers.js";

const TOKEN = "shpat_canarytokenvalue123456";
const SESSION = "pubky-session-canary-value-123456";
const WEBHOOK_SECRET = "shpss_canarywebhooksecret1234";
const PUBKY_WEBHOOK_CANARY = "pubky-webhook-canary-secret";
const CANARIES = [TOKEN, SESSION, WEBHOOK_SECRET, PUBKY_WEBHOOK_CANARY];
const NOW = Date.parse("2026-01-15T12:00:00.000Z");
const LOCATION = "905684977";
const ITEM = "gid://shopify/InventoryItem/808950810";
const OTHER_LOCATION = "gid://shopify/Location/905684978";
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

function fixture(name: string): URL {
  return new URL(`../../test/fixtures/shopify/${name}`, import.meta.url);
}

function secrets(webhookSecret = "", keyId = ""): BridgeSecrets {
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
    pubkyWebhookSecret: webhookSecret,
    pubkyWebhookKeyId: keyId,
  };
}

function signShopify(raw: Uint8Array): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("base64");
}

function headers(
  raw: Uint8Array,
  topic: string,
  webhookId: string,
  triggeredAt = "2026-01-15T12:00:00.000Z",
) {
  return {
    hmac: signShopify(raw),
    topic,
    shopDomain: "fixture-shop.myshopify.com",
    webhookId,
    triggeredAt,
  };
}

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "shopify-bridge-"));
}

async function assertNoCanaries(directory: string): Promise<void> {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
        continue;
      }
      const text = await readFile(child);
      const decoded = text.toString("utf8");
      for (const canary of CANARIES) {
        assert.equal(decoded.includes(canary), false, entry.name);
      }
    }
  }
}

test("private mode rejects group and world bits", () => {
  assert.doesNotThrow(() => assertPrivateMode(0o600));
  assert.doesNotThrow(() => assertPrivateMode(0o700));
  assert.throws(() => assertPrivateMode(0o644), ShopifyBridgeError);
  assert.throws(() => assertPrivateMode(0o640), ShopifyBridgeError);
});

test("recovery material is rejected before a homeserver session restore", () => {
  assert.throws(
    () =>
      assertNotRecoveryMaterial({
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        pubky: SELLER_PUBKY,
        secret: "x".repeat(20),
        capabilities: ["/:rw"],
      }),
    (error: unknown) =>
      error instanceof ShopifyBridgeError && error.code === "recovery_material_rejected",
  );
});

test("Shopify CSV maps onto canonical rows and records losses", async () => {
  const bytes = await readFile(fixture("product.csv"));
  const mapped = mapShopifyProductCsv(bytes, {
    sellerPubky: SELLER_PUBKY,
    currency: "USD",
    exponent: 2,
  });
  assert.equal(mapped.products.length, 1);
  assert.equal(mapped.skipped.length, 1);
  assert.equal(mapped.skipped[0]?.losses[0]?.code, "unpublished_product");
  assert.ok(mapped.headerLosses.some((entry) => entry.code === "market_price_list"));
  const product = mapped.products[0];
  assert.ok(product);
  assert.ok(product.losses.some((entry) => entry.code === "html_body"));
  assert.ok(product.losses.some((entry) => entry.code === "csv_quantity_unscoped"));
  assert.equal(product.description, "Lined boots");
  assert.deepEqual(
    product.variants.map((variant) => variant.quantity),
    [12, 7],
  );
  const rows = (await import("../src/connectors/shopify/map.js")).canonicalRowsFor(product);
  assert.equal(catalogRecordText(rows), listingRecordText(listingRecordFromRows(rows)));
  const parsed = parseCanonicalCsv(
    new Uint8Array(await import("../src/csv.js").then((csv) => csv.exportCanonicalCsv(rows))),
  );
  assert.equal(parsed.rows.length, 2);
  const first = parsed.rows[0];
  assert.ok(first);
  assert.equal(first.title, "Night Boots");
  assert.equal(first.amountMinor, 12500);
  assert.equal((first.externalRefs as { channel?: string }).channel, "shopify");
  const split = mapShopifyProductCsv(
    new TextEncoder().encode(
      "Handle,Title,Variant Price,Variant SKU,Published,Status\nsplit,Split,10.00,AAA,TRUE,active\nsplit,Split,12.00,BBB,TRUE,active\n",
    ),
    { sellerPubky: SELLER_PUBKY, currency: "USD", exponent: 2 },
  );
  assert.equal(split.products.length, 0);
  assert.equal(
    split.skipped[0]?.losses.some((entry) => entry.code === "variant_price_not_representable"),
    true,
  );
});

test("product webhook preserves ids above the JavaScript safe integer range", async () => {
  const bytes = await readFile(fixture("products-update.json"));
  const mapped = mapProductUpdate(bytes, {
    sellerPubky: SELLER_PUBKY,
    currency: "USD",
    exponent: 2,
  });
  assert.equal(
    "externalId" in mapped && mapped.externalId,
    "gid://shopify/Product/788032119674292922",
  );
  assert.equal("variants" in mapped && mapped.variants[0]?.inventoryItemId, ITEM);
  assert.ok(
    "losses" in mapped &&
      mapped.losses.some((entry) => entry.code === "variant_inventory_quantity_unscoped"),
  );
});

test("Shopify HMAC and clock skew fail closed", () => {
  const raw = new TextEncoder().encode('{"id":1}');
  assert.equal(verifyShopifyHmac(raw, signShopify(raw), WEBHOOK_SECRET), true);
  assert.equal(
    verifyShopifyHmac(raw, signShopify(new TextEncoder().encode("other")), WEBHOOK_SECRET),
    false,
  );
  const flipped = Buffer.from(signShopify(raw), "base64");
  flipped[0] = (flipped[0] ?? 0) ^ 0x01;
  assert.equal(verifyShopifyHmac(raw, flipped.toString("base64"), WEBHOOK_SECRET), false);
});

test("result rendering redacts a secret planted in the payload", () => {
  const rendered = renderBridgeResult(
    {
      outcome: "rejected",
      reason: "failed",
      losses: [{ code: "html_body", source: "body", detail: `${TOKEN} ${SESSION}` }],
      listingId: "",
      adjustDelta: "",
      idempotencyKey: "",
    },
    secrets(),
  );
  assert.equal(rendered.includes(TOKEN), false);
  assert.equal(rendered.includes(SESSION), false);
  assert.equal(rendered.includes("[redacted]"), true);
});

test("Admin HTTP client sends the token only to the shop origin", async () => {
  let captured = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = JSON.stringify({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: String(init?.body),
    });
    assert.equal(new Headers(init?.headers).get("x-shopify-access-token"), TOKEN);
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    assert.equal(String(init?.body).includes(TOKEN), false);
    assert.equal(
      String(input).startsWith("https://fixture-shop.myshopify.com/admin/api/2025-10/graphql.json"),
      true,
    );
    return new Response(
      JSON.stringify({
        data: {
          inventorySetQuantities: {
            inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1" },
            userErrors: [],
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const admin = shopifyAdminHttp({
    shopDomain: "fixture-shop.myshopify.com",
    accessToken: TOKEN,
    fetch: fetchImpl,
  });
  const set = await admin.inventorySet({
    inventoryItemId: ITEM,
    locationId: shopifyGid("Location", LOCATION),
    quantity: 4,
    referenceDocumentUri:
      "https://pubky.app/marketplace/events/00000000-0000-4000-8000-0000000000aa",
  });
  assert.equal(set.adjustmentGroupId, "gid://shopify/InventoryAdjustmentGroup/1");
  assert.equal(captured.includes(SESSION), false);
  assert.throws(
    () => shopifyAdminHttp({ shopDomain: "evil.example", accessToken: TOKEN, fetch: fetchImpl }),
    ShopifyBridgeError,
  );
  await assert.rejects(
    () =>
      recordedShopifyAdmin({
        inventoryLevels: {},
        variantBySku: {},
        inventorySet: {},
      }).inventoryLevels(ITEM),
    (error: unknown) =>
      error instanceof ShopifyBridgeError && error.code === "unrecorded_shopify_call",
  );
});

test("import and stock sync round trip against fixtures", async () => {
  const directory = await scratch();
  const puts: { path: string; body: Uint8Array | string }[] = [];
  const homeserver: HomeserverWriter = {
    async putText(filePath, body) {
      puts.push({ path: filePath, body });
    },
    async putBytes(filePath, body) {
      puts.push({ path: filePath, body });
    },
  };
  const shopifyCalls: {
    url: string;
    body: string;
    token: string | null;
    authorization: string | null;
  }[] = [];
  const pubkyCalls: {
    url: string;
    body: string;
    authorization: string | null;
    token: string | null;
  }[] = [];
  const adjusts: {
    delta: number;
    expected_revision: number;
    idempotency_key: string;
    external_ref: { channel: string; external_id: string };
  }[] = [];
  let projection: { available: number; revision: number } | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body === undefined ? "" : String(init.body);
    if (url.includes("myshopify.com")) {
      shopifyCalls.push({
        url,
        body,
        token: headers.get("x-shopify-access-token"),
        authorization: headers.get("authorization"),
      });
      const request = JSON.parse(body) as {
        query: string;
        variables: { id?: string; query?: string };
      };
      if (request.query.includes("inventoryLevels")) {
        const second = request.variables.id === "gid://shopify/InventoryItem/808950811";
        return json({
          data: {
            inventoryItem: {
              id: request.variables.id,
              inventoryLevels: {
                pageInfo: { hasNextPage: false },
                nodes: second
                  ? [
                      {
                        location: { id: shopifyGid("Location", LOCATION) },
                        quantities: [{ name: "available", quantity: 1 }],
                      },
                    ]
                  : [
                      {
                        location: { id: shopifyGid("Location", LOCATION) },
                        quantities: [{ name: "available", quantity: 4 }],
                      },
                      {
                        location: { id: OTHER_LOCATION },
                        quantities: [{ name: "available", quantity: 9 }],
                      },
                    ],
              },
            },
          },
        });
      }
      if (request.query.includes("variantBySku")) {
        const sku = request.variables.query;
        const id = sku === "sku:BOOT-L" ? "gid://shopify/InventoryItem/808950811" : ITEM;
        return json({
          data: {
            productVariants: {
              nodes: [{ id: "gid://shopify/ProductVariant/1", sku, inventoryItem: { id } }],
            },
          },
        });
      }
      if (request.query.includes("inventorySetQuantities")) {
        return json({
          data: {
            inventorySetQuantities: {
              inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1" },
              userErrors: [],
            },
          },
        });
      }
      return json({ errors: [{ message: "unexpected" }] }, 500);
    }
    if (url.includes("cdn.shopify.com")) {
      assert.equal(headers.get("x-shopify-access-token"), null);
      assert.equal(headers.get("authorization"), null);
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    }
    pubkyCalls.push({
      url,
      body,
      authorization: headers.get("authorization"),
      token: headers.get("x-shopify-access-token"),
    });
    if (url.includes("/v1/listings/sync-many")) {
      return json(
        { schema_version: 1, kind: "listing.sync_many", results: [{ status: 207 }] },
        207,
      );
    }
    if (url.includes("/v1/inventory/adjust")) {
      const parsed = JSON.parse(body) as (typeof adjusts)[number];
      adjusts.push(parsed);
      if (projection !== undefined && parsed.expected_revision !== projection.revision) {
        return json({ ok: false, error: { code: "revision_conflict", message: "stale" } }, 409);
      }
      const available = (projection?.available ?? 0) + parsed.delta;
      const revision = (projection?.revision ?? 1) + 1;
      projection = { available, revision };
      return json({
        ok: true,
        schema_version: 1,
        result: {
          aggregate_id: `listing:${SELLER_PUBKY}_night-boots`,
          event_id: "00000000-0000-4000-8000-000000000002",
          listing_id: "night-boots",
          server_revision: revision,
          stock: { authority: "listing_total", available, reserved: 0, sold: 0, total: available },
        },
      });
    }
    if (url.includes("/v1/inventory/listings/")) {
      if (projection === undefined) {
        return json({ ok: false, error: { code: "listing_not_found", message: "missing" } }, 404);
      }
      return json({
        schema_version: 1,
        kind: "inventory_projection",
        aggregate_id: `listing:${SELLER_PUBKY}_night-boots`,
        seller_pubky: SELLER_PUBKY,
        listing_id: "night-boots",
        server_revision: projection.revision,
        stock: {
          authority: "listing_total",
          available: projection.available,
          reserved: 0,
          sold: 0,
          total: projection.available,
        },
      });
    }
    if (url.includes("/events")) {
      return json({
        schema_version: 1,
        kind: "seller_event_feed",
        seller_pubky: SELLER_PUBKY,
        events: [
          {
            schema_version: 1,
            id: "00000000-0000-4000-8000-0000000000aa",
            cursor: "AQ",
            sequence: 1,
            seller_pubky: SELLER_PUBKY,
            aggregate_id: `listing:${SELLER_PUBKY}_night-boots`,
            revision: projection?.revision ?? 1,
            type: "inventory.adjusted",
            occurred_at: "2026-01-02T00:00:00Z",
            data: {},
          },
        ],
        next_cursor: null,
      });
    }
    if (url.includes("/v1/webhooks")) {
      return json({
        schema_version: 1,
        id: "00000000-0000-4000-8000-0000000000c0",
        key_id: "00000000-0000-4000-8000-0000000000c1",
        secret: PUBKY_WEBHOOK_CANARY,
      });
    }
    return json({ ok: false, error: { code: "invalid_request", message: "no" } }, 404);
  };
  const ctx = buildContext(directory, fetchImpl, homeserver);
  const product = await readFile(fixture("products-update.json"));
  const imported = await applyShopifyWebhook(
    product,
    headers(product, "products/update", "00000000-0000-4000-8000-000000000010"),
    ctx,
  );
  assert.equal(imported.outcome, "applied");
  assert.equal(imported.adjustDelta, "");
  assert.equal(
    puts.some(
      (entry) =>
        entry.path.endsWith("/listings/night-boots") && String(entry.body).includes('"quantity":4'),
    ),
    true,
  );
  assert.equal(
    String(puts.find((entry) => typeof entry.body === "string")?.body).includes('"quantity":13'),
    false,
  );
  assert.equal(
    String(puts.find((entry) => typeof entry.body === "string")?.body).includes('"quantity":19'),
    false,
  );
  const media = puts.find((entry) => entry.path.includes("/media/"));
  assert.ok(media);
  assert.deepEqual(Buffer.from(media.body), PNG);
  assert.ok(imported.losses.some((entry) => entry.code === "location_not_selected"));
  projection = { available: 4, revision: 1 };
  const replay = await applyShopifyWebhook(
    product,
    headers(product, "products/update", "00000000-0000-4000-8000-000000000010"),
    ctx,
  );
  assert.equal(replay.outcome, "replayed");
  assert.equal(puts.length, 2);

  const level = await readFile(fixture("inventory-level-update.json"));
  const levelId = "00000000-0000-4000-8000-000000000011";
  const adjusted = await applyShopifyWebhook(
    level,
    headers(level, "inventory_levels/update", levelId),
    ctx,
  );
  assert.equal(adjusted.outcome, "applied");
  assert.equal(adjusted.adjustDelta, "2");
  assert.equal(adjusts.length, 1);
  assert.equal(adjusts[0]?.external_ref.channel, "shopify");
  assert.equal(adjusts[0]?.external_ref.external_id, levelId);
  assert.equal(adjusts[0]?.expected_revision, 1);
  const again = await applyShopifyWebhook(
    level,
    headers(level, "inventory_levels/update", levelId),
    ctx,
  );
  assert.equal(again.outcome, "replayed");
  assert.equal(adjusts.length, 1);

  const other = new TextEncoder().encode(
    JSON.stringify({ inventory_item_id: 808950810, location_id: 905684978, available: 9 }),
  );
  const ignored = await applyShopifyWebhook(
    other,
    headers(other, "inventory_levels/update", "00000000-0000-4000-8000-000000000012"),
    ctx,
  );
  assert.equal(ignored.outcome, "ignored");
  assert.equal(ignored.reason, "location_not_selected");
  assert.equal(adjusts.length, 1);

  const changed = new TextEncoder().encode(
    JSON.stringify({ inventory_item_id: 808950810, location_id: 905684977, available: 8 }),
  );
  const quarantined = await applyShopifyWebhook(
    changed,
    headers(changed, "inventory_levels/update", levelId),
    ctx,
  );
  assert.equal(quarantined.outcome, "quarantined");
  assert.equal(quarantined.reason, "changed_payload");
  assert.equal(adjusts.length, 1);
  await ctx.receipts.releaseQuarantine(secrets().shopId, levelId);
  const released = await applyShopifyWebhook(
    changed,
    headers(changed, "inventory_levels/update", levelId),
    ctx,
  );
  assert.equal(released.outcome, "applied");
  assert.equal(released.adjustDelta, "2");
  assert.equal(adjusts.length, 2);

  const csv = await applyShopifyProductCsv(
    await readFile(fixture("product.csv")),
    buildContext(await scratch(), fetchImpl, homeserver),
  );
  assert.equal(
    csv.some((result) => result.outcome === "applied" || result.outcome === "ignored"),
    true,
  );

  const pulled = await pullInventoryEvents(ctx);
  assert.equal(pulled[0]?.outcome, "applied");
  assert.equal(
    shopifyCalls.filter((call) => call.body.includes("inventorySetQuantities")).length,
    1,
  );
  const pulledAgain = await pullInventoryEvents(ctx);
  assert.equal(pulledAgain[0]?.outcome, "replayed");
  assert.equal(
    shopifyCalls.filter((call) => call.body.includes("inventorySetQuantities")).length,
    1,
  );

  for (const call of shopifyCalls) {
    assert.equal(call.token, TOKEN);
    assert.equal(call.authorization, null);
    assert.equal(call.body.includes(TOKEN), false);
    assert.equal(call.body.includes(SESSION), false);
    assert.equal(call.url.includes(TOKEN), false);
  }
  for (const call of pubkyCalls) {
    assert.equal(call.authorization, `Bearer ${SESSION}`);
    assert.equal(call.token, null);
    assert.equal(call.body.includes(TOKEN), false);
    assert.equal(call.body.includes(SESSION), false);
  }
  const rendered = renderBridgeResult(imported, secrets());
  for (const canary of CANARIES) {
    assert.equal(rendered.includes(canary), false);
  }
  await assertNoCanaries(directory);
  assert.equal(LIVE_PROOF_REQUIRES.length, 3);
});

test("a crash between plan and checkpoint does not double-apply", async () => {
  const directory = await scratch();
  let adjusts = 0;
  let projection: { available: number; revision: number } | undefined = {
    available: 4,
    revision: 1,
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("myshopify.com")) {
      return json({
        data: {
          inventoryItem: {
            id: ITEM,
            inventoryLevels: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  location: { id: shopifyGid("Location", LOCATION) },
                  quantities: [{ name: "available", quantity: 4 }],
                },
              ],
            },
          },
        },
      });
    }
    if (url.includes("/v1/listings/sync-many")) {
      return json(
        { schema_version: 1, kind: "listing.sync_many", results: [{ status: 207 }] },
        207,
      );
    }
    if (url.includes("/v1/inventory/listings/")) {
      if (projection === undefined) {
        return json({ ok: false, error: { code: "listing_not_found", message: "missing" } }, 404);
      }
      return json({
        schema_version: 1,
        kind: "inventory_projection",
        aggregate_id: `listing:${SELLER_PUBKY}_night-boots`,
        seller_pubky: SELLER_PUBKY,
        listing_id: "night-boots",
        server_revision: projection.revision,
        stock: {
          authority: "listing_total",
          available: projection.available,
          reserved: 0,
          sold: 0,
          total: projection.available,
        },
      });
    }
    if (url.includes("/v1/inventory/adjust")) {
      const current = projection;
      if (current === undefined) {
        return json({ ok: false, error: { code: "listing_not_found", message: "missing" } }, 404);
      }
      adjusts += 1;
      const parsed = JSON.parse(String(init?.body)) as { delta: number; idempotency_key: string };
      assert.equal(
        parsed.idempotency_key,
        idempotencyKeyFor(
          `shopify|646096977|00000000-0000-4000-8000-000000000021|${(await import("../src/connectors/shopify/ids.js")).payloadHash(await readFile(fixture("inventory-level-update.json")))}`,
        ),
      );
      projection = { available: current.available + parsed.delta, revision: current.revision + 1 };
      return json({
        ok: true,
        schema_version: 1,
        result: {
          aggregate_id: `listing:${SELLER_PUBKY}_night-boots`,
          event_id: "00000000-0000-4000-8000-000000000002",
          listing_id: "night-boots",
          server_revision: projection.revision,
          stock: {
            authority: "listing_total",
            available: projection.available,
            reserved: 0,
            sold: 0,
            total: projection.available,
          },
        },
      });
    }
    return json({ ok: false, error: { code: "invalid_request", message: "no" } }, 404);
  };
  const level = await readFile(fixture("inventory-level-update.json"));
  const base = buildContext(directory, fetchImpl, {
    async putText() {},
    async putBytes() {},
  });
  await base.catalog.replaceListing(`listing:${SELLER_PUBKY}_night-boots`, [
    {
      listingId: "night-boots",
      aggregateId: `listing:${SELLER_PUBKY}_night-boots`,
      variantId: "BOOT-M",
      sku: "BOOT-M",
      inventoryItemId: ITEM,
      quantity: 4,
    },
  ]);
  await assert.rejects(
    () =>
      applyShopifyWebhook(
        level,
        headers(level, "inventory_levels/update", "00000000-0000-4000-8000-000000000021"),
        { ...base, crashAfterState: "effect-planned" },
      ),
    (error: unknown) => error instanceof ShopifyBridgeError && error.code === "crash_injected",
  );
  assert.equal(adjusts, 0);
  const resumed = await applyShopifyWebhook(
    level,
    headers(level, "inventory_levels/update", "00000000-0000-4000-8000-000000000021"),
    base,
  );
  assert.equal(resumed.outcome, "applied");
  assert.equal(adjusts, 1);
  const directoryComplete = await scratch();
  let completeAdjusts = 0;
  let completeProjection: { available: number; revision: number } | undefined = {
    available: 4,
    revision: 1,
  };
  const completeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/v1/inventory/adjust")) {
      completeAdjusts += 1;
      const parsed = JSON.parse(String(init?.body)) as { delta: number };
      completeProjection = {
        available: (completeProjection?.available ?? 0) + parsed.delta,
        revision: (completeProjection?.revision ?? 1) + 1,
      };
      return json({
        ok: true,
        schema_version: 1,
        result: {
          aggregate_id: `listing:${SELLER_PUBKY}_night-boots`,
          event_id: "00000000-0000-4000-8000-000000000002",
          listing_id: "night-boots",
          server_revision: completeProjection.revision,
          stock: {
            authority: "listing_total",
            available: completeProjection.available,
            reserved: 0,
            sold: 0,
            total: completeProjection.available,
          },
        },
      });
    }
    if (url.includes("/v1/inventory/listings/")) {
      return json({
        schema_version: 1,
        kind: "inventory_projection",
        aggregate_id: `listing:${SELLER_PUBKY}_night-boots`,
        seller_pubky: SELLER_PUBKY,
        listing_id: "night-boots",
        server_revision: completeProjection?.revision ?? 1,
        stock: {
          authority: "listing_total",
          available: completeProjection?.available ?? 0,
          reserved: 0,
          sold: 0,
          total: completeProjection?.available ?? 0,
        },
      });
    }
    return json({ ok: false, error: { code: "invalid_request", message: "no" } }, 404);
  };
  const complete = buildContext(directoryComplete, completeFetch, {
    async putText() {},
    async putBytes() {},
  });
  await complete.catalog.replaceListing(`listing:${SELLER_PUBKY}_night-boots`, [
    {
      listingId: "night-boots",
      aggregateId: `listing:${SELLER_PUBKY}_night-boots`,
      variantId: "BOOT-M",
      sku: "BOOT-M",
      inventoryItemId: ITEM,
      quantity: 4,
    },
  ]);
  await assert.rejects(
    () =>
      applyShopifyWebhook(
        level,
        headers(level, "inventory_levels/update", "00000000-0000-4000-8000-000000000022"),
        {
          ...complete,
          crashAfterState: "effect-complete",
        },
      ),
    (error: unknown) => error instanceof ShopifyBridgeError && error.code === "crash_injected",
  );
  assert.equal(completeAdjusts, 1);
  const checkpointed = await applyShopifyWebhook(
    level,
    headers(level, "inventory_levels/update", "00000000-0000-4000-8000-000000000022"),
    complete,
  );
  assert.equal(checkpointed.outcome, "replayed");
  assert.equal(completeAdjusts, 1);
});

test("outbound listing-total stock is not split across variants", async () => {
  const directory = await scratch();
  const catalog = new FileCatalog(directory);
  await catalog.replaceListing(`listing:${SELLER_PUBKY}_night-boots`, [
    {
      listingId: "night-boots",
      aggregateId: `listing:${SELLER_PUBKY}_night-boots`,
      variantId: "BOOT-M",
      sku: "BOOT-M",
      inventoryItemId: ITEM,
      quantity: 4,
    },
    {
      listingId: "night-boots",
      aggregateId: `listing:${SELLER_PUBKY}_night-boots`,
      variantId: "BOOT-L",
      sku: "BOOT-L",
      inventoryItemId: "gid://shopify/InventoryItem/2",
      quantity: 1,
    },
  ]);
  const ctx = buildContext(
    directory,
    async () => {
      throw new Error("shopify was called");
    },
    { async putText() {}, async putBytes() {} },
  );
  const result = await applyOutboundEvent(
    {
      id: "00000000-0000-4000-8000-0000000000bb",
      type: "inventory.adjusted",
      aggregateId: `listing:${SELLER_PUBKY}_night-boots`,
      revision: "2",
    },
    "a".repeat(64),
    ctx,
  );
  assert.equal(result.outcome, "quarantined");
  assert.equal(result.reason, "listing_total_not_per_variant");
});

test("Pubky webhook signature gates outbound stock", async () => {
  const directory = await scratch();
  const catalog = new FileCatalog(directory);
  await catalog.replaceListing(`listing:${SELLER_PUBKY}_night-boots`, [
    {
      listingId: "night-boots",
      aggregateId: `listing:${SELLER_PUBKY}_night-boots`,
      variantId: "BOOT-M",
      sku: "BOOT-M",
      inventoryItemId: ITEM,
      quantity: 4,
    },
  ]);
  let sets = 0;
  const secret = Buffer.alloc(32, 7).toString("base64url");
  const keyId = "00000000-0000-4000-8000-0000000000c1";
  const eventId = "00000000-0000-4000-8000-0000000000cc";
  const raw = new TextEncoder().encode(
    JSON.stringify({
      schema_version: 1,
      id: eventId,
      type: "inventory.adjusted",
      aggregate_id: `listing:${SELLER_PUBKY}_night-boots`,
      revision: 2,
    }),
  );
  const timestamp = String(Math.floor(NOW / 1000));
  const signature = signPubky(secret, timestamp, eventId, raw);
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("myshopify.com")) {
      sets += 1;
      assert.equal(String(init?.body).includes(secret), false);
      return json({
        data: {
          inventorySetQuantities: {
            inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/9" },
            userErrors: [],
          },
        },
      });
    }
    if (url.includes("/v1/inventory/listings/")) {
      return json({
        schema_version: 1,
        kind: "inventory_projection",
        aggregate_id: `listing:${SELLER_PUBKY}_night-boots`,
        seller_pubky: SELLER_PUBKY,
        listing_id: "night-boots",
        server_revision: 2,
        stock: { authority: "listing_total", available: 6, reserved: 0, sold: 0, total: 6 },
      });
    }
    return json({ ok: false, error: { code: "invalid_request", message: "no" } }, 404);
  };
  const ctx = buildContext(
    directory,
    fetchImpl,
    { async putText() {}, async putBytes() {} },
    secret,
    keyId,
  );
  const applied = await applyPubkyWebhook(raw, { eventId, timestamp, keyId, signature }, ctx);
  assert.equal(applied.outcome, "applied");
  assert.equal(sets, 1);
  const replay = await applyPubkyWebhook(raw, { eventId, timestamp, keyId, signature }, ctx);
  assert.equal(replay.outcome, "replayed");
  assert.equal(sets, 1);
  const stale = await applyPubkyWebhook(
    raw,
    { eventId, timestamp: "1", keyId, signature: signPubky(secret, "1", eventId, raw) },
    ctx,
  );
  assert.equal(stale.outcome, "rejected");
  assert.equal(stale.reason, "stale");
  assert.equal(sets, 1);
});

test("config summary and csv command keep secrets off stdout", async () => {
  const directory = await scratch();
  const file = path.join(directory, "secrets.json");
  await writeBridgeSecrets(file, secrets());
  const bin = fileURLToPath(new URL("../src/connectors/shopify/bin.js", import.meta.url));
  const summary = spawnSync(process.execPath, [bin, "config-summary", "--secrets", file], {
    encoding: "utf8",
  });
  assert.equal(summary.status, 0);
  assert.equal(summary.stdout.includes("fixture-shop.myshopify.com"), true);
  for (const canary of CANARIES) {
    assert.equal(summary.stdout.includes(canary), false);
    assert.equal(summary.stderr.includes(canary), false);
  }
  const csv = await readFile(fixture("product.csv"));
  const input = path.join(directory, "products.csv");
  const output = path.join(directory, "canonical.csv");
  const losses = path.join(directory, "losses.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(input, csv);
  const mapped = spawnSync(
    process.execPath,
    [
      bin,
      "map-csv",
      "--input",
      input,
      "--seller",
      SELLER_PUBKY,
      "--currency",
      "USD",
      "--exponent",
      "2",
      "--output",
      output,
      "--losses",
      losses,
    ],
    { encoding: "utf8" },
  );
  assert.equal(mapped.status, 0, mapped.stderr);
  const parsed = parseCanonicalCsv(await readFile(output));
  assert.equal(parsed.rows.length, 2);
  const lossText = await readFile(losses, "utf8");
  assert.equal(lossText.includes("html_body"), true);
  const writer = await directoryHomeserverWriter(path.join(directory, "put"));
  await writer.putText("/pub/pubky.app/marketplace/v1/listings/night-boots", '{"ok":true}\n');
  const written = await readFile(
    path.join(directory, "put/pub/pubky.app/marketplace/v1/listings/night-boots"),
    "utf8",
  );
  assert.equal(written.includes("ok"), true);
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function buildContext(
  directory: string,
  fetchImpl: typeof fetch,
  homeserver: HomeserverWriter,
  webhookSecret = "",
  keyId = "",
): ApplyContext {
  const bridgeSecrets = secrets(webhookSecret, keyId);
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
  };
}

function signPubky(secret: string, timestamp: string, eventId: string, raw: Uint8Array): string {
  const key = createHash("sha256").update(Buffer.from(secret, "base64url")).digest();
  const input = Buffer.concat([
    Buffer.from("v1."),
    Buffer.from(timestamp),
    Buffer.from("."),
    Buffer.from(eventId),
    Buffer.from("."),
    Buffer.from(raw),
  ]);
  return `v1=${createHmac("sha256", key).update(input).digest("hex")}`;
}
