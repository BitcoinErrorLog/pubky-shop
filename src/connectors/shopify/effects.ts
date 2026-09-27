import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PubkyShopClient } from "../../client.js";
import type { LosslessJsonObject, LosslessJsonValue } from "../../json.js";
import { canonicalJson } from "../../json.js";
import type { ShopifyAdmin } from "./admin.js";
import { downloadHttpsBytes } from "./download.js";
import { ShopifyBridgeError } from "./errors.js";
import { shopifyTriggeredAtFresh, verifyPubkyWebhook, verifyShopifyHmac } from "./hmac.js";
import {
  idempotencyKeyFor,
  listingAggregateId,
  payloadHash,
  sameShopifyId,
  shopifyGid,
} from "./ids.js";
import {
  applyLocationQuantities,
  canonicalRowsFor,
  isMappedProduct,
  type MappedProduct,
  mapInventoryLevel,
  mapProductUpdate,
  mapShopifyProductCsv,
  type ShopifyLoss,
} from "./map.js";
import type {
  CatalogVariantPlan,
  FileCatalog,
  FileReceiptLog,
  PlannedEffect,
  Receipt,
  StoredAdjust,
} from "./receipts.js";
import { catalogRecordText, listingRecordPath, mediaRecordPath } from "./record.js";
import { redact } from "./redact.js";
import { type BridgeSecrets, secretValues } from "./secrets.js";

const MAX_WEBHOOK_BYTES = 2_000_000;
const DEFAULT_SKEW_MS = 5 * 60 * 1000;
const PUBKY_SKEW_SECONDS = 300;
const MAX_EVENT_PAGES = 20;

export interface HomeserverWriter {
  putText(path: string, body: string): Promise<void>;
  putBytes(path: string, body: Uint8Array, contentType: string): Promise<void>;
}

export interface BridgeResult {
  readonly outcome: "applied" | "replayed" | "quarantined" | "ignored" | "rejected";
  readonly reason: string;
  readonly losses: readonly ShopifyLoss[];
  readonly listingId: string;
  readonly adjustDelta: string;
  readonly idempotencyKey: string;
}

export interface ShopifyWebhookHeaders {
  readonly hmac: string;
  readonly topic: string;
  readonly shopDomain: string;
  readonly webhookId: string;
  readonly triggeredAt: string;
}

export interface ApplyContext {
  readonly secrets: BridgeSecrets;
  readonly admin: ShopifyAdmin;
  readonly pubky: PubkyShopClient;
  readonly homeserver: HomeserverWriter;
  readonly receipts: FileReceiptLog;
  readonly catalog: FileCatalog;
  readonly nowMs: number;
  readonly maxSkewMs?: number;
  readonly downloadFetch?: typeof fetch;
  readonly crashAfterState?: "effect-planned" | "effect-complete";
}

export interface PubkyStockEvent {
  readonly id: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly revision: string;
}

function emptyResult(
  outcome: BridgeResult["outcome"],
  reason: string,
  losses: readonly ShopifyLoss[] = [],
): BridgeResult {
  return { outcome, reason, losses, listingId: "", adjustDelta: "", idempotencyKey: "" };
}

function fromPlan(
  outcome: BridgeResult["outcome"],
  reason: string,
  plan: PlannedEffect | undefined,
): BridgeResult {
  const losses = plan?.losses ?? [];
  const listingId = plan !== undefined && "listingId" in plan ? plan.listingId : "";
  const adjust = plan !== undefined && "adjust" in plan ? plan.adjust : null;
  return {
    outcome,
    reason,
    losses,
    listingId,
    adjustDelta: adjust?.delta ?? "",
    idempotencyKey: adjust?.idempotency_key ?? "",
  };
}

function crashIf(ctx: ApplyContext, state: "effect-planned" | "effect-complete"): void {
  if (ctx.crashAfterState === state) {
    throw new ShopifyBridgeError("crash_injected");
  }
}

function printable(value: string, maximum: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    })
  );
}

async function projectionAvailable(
  pubky: PubkyShopClient,
  aggregateId: string,
): Promise<
  | { readonly found: false }
  | { readonly found: true; readonly available: bigint; readonly revision: bigint }
> {
  const result = await pubky.getInventoryProjection(aggregateId);
  if (!result.ok) {
    if (
      result.error.details.serviceCode === "listing_not_found" ||
      result.error.details.status === 404
    ) {
      return { found: false };
    }
    throw new ShopifyBridgeError("pubky_rejected");
  }
  return {
    found: true,
    available: result.value.stock.available,
    revision: result.value.server_revision,
  };
}

function storedAdjust(
  secrets: BridgeSecrets,
  externalEventId: string,
  hash: string,
  aggregateId: string,
  listingId: string,
  target: number,
  available: bigint,
  revision: bigint,
): StoredAdjust | null | "delta_out_of_range" {
  const delta = BigInt(target) - available;
  if (delta === 0n) {
    return null;
  }
  if (delta < -1_000_000n || delta > 1_000_000n) {
    return "delta_out_of_range";
  }
  return {
    schema_version: 1,
    kind: "inventory.adjust",
    aggregate_id: aggregateId,
    listing_id: listingId,
    expected_revision: revision.toString(10),
    delta: delta.toString(10),
    idempotency_key: idempotencyKeyFor(`shopify|${secrets.shopId}|${externalEventId}|${hash}`),
    external_ref: { channel: "shopify", external_id: externalEventId },
  };
}

async function downloadedMedia(
  product: MappedProduct,
  fetchImpl: typeof fetch | undefined,
): Promise<{
  readonly media: { id: string; alt: string }[];
  readonly files: { path: string; base64: string; contentType: string }[];
  readonly losses: ShopifyLoss[];
}> {
  const media: { id: string; alt: string }[] = [];
  const files: { path: string; base64: string; contentType: string }[] = [];
  const losses: ShopifyLoss[] = [];
  if (fetchImpl === undefined) {
    if (product.images.length > 0) {
      losses.push({
        code: "image_src_requires_seller_download",
        source: "images",
        detail: "No image downloader was configured.",
      });
    }
    return { media, files, losses };
  }
  let index = 0;
  for (const image of product.images) {
    index += 1;
    try {
      const downloaded = await downloadHttpsBytes(image.src, fetchImpl);
      const id = `m${index}`;
      media.push({ id, alt: image.alt });
      files.push({
        path: mediaRecordPath(product.listingId, id),
        base64: Buffer.from(downloaded.bytes).toString("base64"),
        contentType: downloaded.contentType,
      });
    } catch {
      losses.push({
        code: "image_download_failed",
        source: "images.src",
        detail: "The image bytes were not downloaded.",
      });
    }
  }
  return { media, files, losses };
}

async function catalogPlan(
  product: MappedProduct,
  ctx: ApplyContext,
  externalEventId: string,
  hash: string,
): Promise<PlannedEffect> {
  const levels = [];
  for (const variant of product.variants) {
    if (variant.inventoryItemId === "") {
      continue;
    }
    levels.push(...(await ctx.admin.inventoryLevels(variant.inventoryItemId)));
  }
  const located = applyLocationQuantities(product, levels, ctx.secrets.locationId);
  const positive = located.product.variants.filter(
    (variant) => variant.quantity > 0 && variant.inventoryItemId !== "",
  );
  if (positive.length === 0) {
    return {
      kind: "noop",
      reason: "no_stock_at_location",
      losses: [
        ...located.product.losses,
        {
          code: "no_stock_at_location",
          source: "location",
          detail: "The chosen location has no stock to publish.",
        },
      ],
    };
  }
  const images = await downloadedMedia(
    { ...located.product, images: product.images },
    ctx.downloadFetch,
  );
  const rows = canonicalRowsFor(
    { ...located.product, variants: positive, losses: located.product.losses },
    images.media,
  );
  const aggregateId = listingAggregateId(ctx.secrets.sellerPubky, product.listingId);
  const current = await projectionAvailable(ctx.pubky, aggregateId);
  const target = positive.reduce((sum, variant) => sum + variant.quantity, 0);
  let adjust: StoredAdjust | null = null;
  if (current.found) {
    const planned = storedAdjust(
      ctx.secrets,
      externalEventId,
      hash,
      aggregateId,
      product.listingId,
      target,
      current.available,
      current.revision,
    );
    if (planned === "delta_out_of_range") {
      return { kind: "noop", reason: "delta_out_of_range", losses: located.product.losses };
    }
    adjust = planned;
  }
  const catalogVariants: CatalogVariantPlan[] = positive.map((variant) => ({
    variantId: variant.variantId,
    sku: variant.sku,
    inventoryItemId: variant.inventoryItemId,
    quantity: variant.quantity,
  }));
  return {
    kind: "catalog",
    listingId: product.listingId,
    aggregateId,
    recordText: catalogRecordText(rows),
    media: images.files,
    sellerPubky: ctx.secrets.sellerPubky,
    catalogVariants,
    adjust,
    losses: [...located.product.losses, ...images.losses].filter(
      (entry, index, all) =>
        all.findIndex(
          (candidate) => candidate.code === entry.code && candidate.source === entry.source,
        ) === index,
    ),
  };
}

async function buildWebhookPlan(
  topic: string,
  raw: Uint8Array,
  externalEventId: string,
  hash: string,
  ctx: ApplyContext,
): Promise<PlannedEffect | BridgeResult> {
  if (topic === "products/update") {
    const mapped = mapProductUpdate(raw, ctx.secrets);
    if (!isMappedProduct(mapped)) {
      return {
        kind: "noop",
        reason: mapped.losses[0]?.code ?? "unpublished_product",
        losses: mapped.losses,
      };
    }
    return catalogPlan(mapped, ctx, externalEventId, hash);
  }
  const level = mapInventoryLevel(raw);
  const chosen = shopifyGid("Location", ctx.secrets.locationId);
  if (!sameShopifyId(level.locationId, chosen, "Location")) {
    return {
      kind: "noop",
      reason: "location_not_selected",
      losses: [
        {
          code: "location_not_selected",
          source: "location_id",
          detail: "The inventory level is not the configured location and is not added.",
        },
      ],
    };
  }
  const entry = await ctx.catalog.getByInventoryItem(level.inventoryItemId);
  if (entry === undefined) {
    return emptyResult("quarantined", "unknown_inventory_item");
  }
  const siblings = await ctx.catalog.listByAggregate(entry.aggregateId);
  const catalogVariants = siblings.map((sibling) => ({
    variantId: sibling.variantId,
    sku: sibling.sku,
    inventoryItemId: sibling.inventoryItemId,
    quantity:
      sibling.inventoryItemId === level.inventoryItemId ? level.available : sibling.quantity,
  }));
  const target = catalogVariants.reduce((sum, variant) => sum + variant.quantity, 0);
  const current = await projectionAvailable(ctx.pubky, entry.aggregateId);
  if (!current.found) {
    return emptyResult("quarantined", "projection_missing", [
      {
        code: "no_stock_at_location",
        source: "projection",
        detail: "Pubky has no stock projection for this listing.",
      },
    ]);
  }
  const planned = storedAdjust(
    ctx.secrets,
    externalEventId,
    hash,
    entry.aggregateId,
    entry.listingId,
    target,
    current.available,
    current.revision,
  );
  if (planned === "delta_out_of_range") {
    return emptyResult("quarantined", "delta_out_of_range");
  }
  return {
    kind: "stock",
    listingId: entry.listingId,
    aggregateId: entry.aggregateId,
    catalogVariants,
    adjust: planned,
    losses: [],
  };
}

async function sendAdjust(
  ctx: ApplyContext,
  adjust: StoredAdjust,
): Promise<
  { readonly action: "ok" | "retry" } | { readonly action: "quarantine"; readonly reason: string }
> {
  const result = await ctx.pubky.adjustInventory({
    schema_version: 1,
    kind: "inventory.adjust",
    aggregate_id: adjust.aggregate_id,
    listing_id: adjust.listing_id,
    expected_revision: BigInt(adjust.expected_revision),
    delta: BigInt(adjust.delta),
    idempotency_key: adjust.idempotency_key,
    external_ref: adjust.external_ref,
  });
  if (result.ok) {
    return { action: "ok" };
  }
  const code = result.error.details.serviceCode;
  if (code === "revision_conflict" || code === "idempotency_conflict") {
    return { action: "quarantine", reason: code };
  }
  return { action: "retry" };
}

async function executePlan(receipt: Receipt, ctx: ApplyContext): Promise<BridgeResult> {
  const plan = receipt.plan;
  if (plan === undefined) {
    throw new ShopifyBridgeError("receipt_conflict");
  }
  if (plan.kind === "catalog") {
    for (const file of plan.media) {
      await ctx.homeserver.putBytes(
        file.path,
        Buffer.from(file.base64, "base64"),
        file.contentType,
      );
    }
    await ctx.homeserver.putText(listingRecordPath(plan.listingId), plan.recordText);
    const synced = await ctx.pubky.syncMany([
      { seller_pubky: plan.sellerPubky, listing_id: plan.listingId },
    ]);
    if (!synced.ok) {
      return fromPlan("rejected", "pubky_rejected", plan);
    }
    if (plan.adjust !== null) {
      const sent = await sendAdjust(ctx, plan.adjust);
      if (sent.action === "quarantine") {
        await ctx.receipts.quarantine(receipt, sent.reason);
        return fromPlan("quarantined", sent.reason, plan);
      }
      if (sent.action === "retry") {
        return fromPlan("rejected", "pubky_rejected", plan);
      }
    }
    await ctx.catalog.replaceListing(
      plan.aggregateId,
      plan.catalogVariants.map((variant) => ({
        ...variant,
        listingId: plan.listingId,
        aggregateId: plan.aggregateId,
      })),
    );
  } else if (plan.kind === "stock") {
    if (plan.adjust !== null) {
      const sent = await sendAdjust(ctx, plan.adjust);
      if (sent.action === "quarantine") {
        await ctx.receipts.quarantine(receipt, sent.reason);
        return fromPlan("quarantined", sent.reason, plan);
      }
      if (sent.action === "retry") {
        return fromPlan("rejected", "pubky_rejected", plan);
      }
    }
    await ctx.catalog.replaceListing(
      plan.aggregateId,
      plan.catalogVariants.map((variant) => ({
        ...variant,
        listingId: plan.listingId,
        aggregateId: plan.aggregateId,
      })),
    );
  } else if (plan.kind === "inventory-set") {
    try {
      await ctx.admin.inventorySet({
        inventoryItemId: plan.inventoryItemId,
        locationId: plan.locationId,
        quantity: plan.quantity,
        referenceDocumentUri: plan.referenceDocumentUri,
      });
    } catch (error) {
      if (error instanceof ShopifyBridgeError && error.code === "unrecorded_shopify_call") {
        throw error;
      }
      return fromPlan("rejected", "shopify_rejected", plan);
    }
  }
  const completed = await ctx.receipts.markComplete(receipt);
  crashIf(ctx, "effect-complete");
  await ctx.receipts.checkpoint(completed);
  if (plan.kind === "noop") {
    return fromPlan("ignored", plan.reason, plan);
  }
  return fromPlan("applied", "ok", plan);
}

async function resume(
  receipt: Receipt,
  ctx: ApplyContext,
  build: () => Promise<PlannedEffect | BridgeResult>,
): Promise<BridgeResult> {
  if (receipt.state === "quarantined") {
    return fromPlan("quarantined", receipt.reason, receipt.plan);
  }
  if (receipt.state === "checkpointed") {
    return fromPlan("replayed", "replay", receipt.plan);
  }
  if (receipt.state === "effect-complete") {
    await ctx.receipts.checkpoint(receipt);
    return fromPlan("replayed", "replay", receipt.plan);
  }
  if (receipt.state === "effect-planned") {
    return executePlan(receipt, ctx);
  }
  const planned = await build();
  if ("outcome" in planned) {
    if (planned.outcome === "quarantined") {
      await ctx.receipts.quarantine(receipt, planned.reason);
    }
    return planned;
  }
  const stored = await ctx.receipts.savePlan(receipt, planned);
  crashIf(ctx, "effect-planned");
  return executePlan(stored, ctx);
}

export async function applyShopifyWebhook(
  raw: Uint8Array,
  headers: ShopifyWebhookHeaders,
  ctx: ApplyContext,
): Promise<BridgeResult> {
  if (raw.byteLength > MAX_WEBHOOK_BYTES) {
    return emptyResult("rejected", "body_too_large");
  }
  if (!verifyShopifyHmac(raw, headers.hmac, ctx.secrets.webhookSecret)) {
    return emptyResult("rejected", "bad_hmac");
  }
  if (headers.shopDomain.toLowerCase() !== ctx.secrets.shopDomain) {
    return emptyResult("rejected", "domain_mismatch");
  }
  if (!shopifyTriggeredAtFresh(headers.triggeredAt, ctx.nowMs, ctx.maxSkewMs ?? DEFAULT_SKEW_MS)) {
    return emptyResult("rejected", "clock_skew");
  }
  if (headers.topic !== "products/update" && headers.topic !== "inventory_levels/update") {
    return emptyResult("rejected", "unsupported_topic");
  }
  if (!printable(headers.webhookId, 128)) {
    return emptyResult("rejected", "webhook_id");
  }
  const hash = payloadHash(raw);
  const receipt = await ctx.receipts.open(ctx.secrets.shopId, headers.webhookId, hash);
  return resume(receipt, ctx, () =>
    buildWebhookPlan(headers.topic, raw, headers.webhookId, hash, ctx),
  );
}

export async function applyShopifyProductCsv(
  bytes: Uint8Array,
  ctx: ApplyContext,
): Promise<readonly BridgeResult[]> {
  const mapped = mapShopifyProductCsv(bytes, ctx.secrets);
  const hash = payloadHash(bytes);
  const results: BridgeResult[] = mapped.skipped.map((skipped) =>
    emptyResult("ignored", skipped.losses[0]?.code ?? "skipped", skipped.losses),
  );
  for (const product of mapped.products) {
    const eventId = `csv:${product.handle}`;
    const receipt = await ctx.receipts.open(ctx.secrets.shopId, eventId, hash);
    results.push(
      await resume(receipt, ctx, async () => {
        const resolved = await resolveCsvInventory(product, ctx);
        if (!("listingId" in resolved)) {
          return {
            kind: "noop",
            reason: resolved.losses[0]?.code ?? "location_stock_unresolved",
            losses: resolved.losses,
          };
        }
        return catalogPlan(resolved, ctx, eventId, hash);
      }),
    );
  }
  return results;
}

async function resolveCsvInventory(
  product: MappedProduct,
  ctx: ApplyContext,
): Promise<MappedProduct | { losses: ShopifyLoss[] }> {
  const variants = [];
  const losses = [...product.losses];
  for (const variant of product.variants) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(variant.sku)) {
      losses.push({
        code: "sku_not_searchable",
        source: "Variant SKU",
        detail: "The SKU cannot be looked up.",
      });
      continue;
    }
    const found = await ctx.admin.variantBySku(variant.sku);
    if (found === undefined) {
      losses.push({
        code: "location_stock_unresolved",
        source: "Variant SKU",
        detail: "The SKU has no recorded Shopify variant.",
      });
      continue;
    }
    variants.push({ ...variant, inventoryItemId: found.inventoryItemId, quantity: 0 });
  }
  if (variants.length === 0) {
    return { losses };
  }
  return { ...product, variants, losses };
}

export async function applyOutboundEvent(
  event: PubkyStockEvent,
  hash: string,
  ctx: ApplyContext,
): Promise<BridgeResult> {
  if (event.type !== "inventory.adjusted") {
    return emptyResult("ignored", "ignored_event");
  }
  if (!printable(event.id, 128)) {
    return emptyResult("rejected", "event_id");
  }
  const eventId = `pubky:${event.id}`;
  const receipt = await ctx.receipts.open(ctx.secrets.shopId, eventId, hash);
  return resume(receipt, ctx, async () => {
    const entries = await ctx.catalog.listByAggregate(event.aggregateId);
    if (entries.length === 0) {
      return emptyResult("quarantined", "unknown_aggregate");
    }
    if (entries.length !== 1) {
      return emptyResult("quarantined", "listing_total_not_per_variant", [
        {
          code: "listing_total_not_per_variant",
          source: "aggregate",
          detail: "Listing-total stock is not split across Shopify variants.",
        },
      ]);
    }
    const entry = entries[0];
    if (entry === undefined) {
      return emptyResult("quarantined", "unknown_aggregate");
    }
    const current = await projectionAvailable(ctx.pubky, event.aggregateId);
    if (!current.found) {
      return emptyResult("quarantined", "projection_missing");
    }
    if (current.available < 0n || current.available > 1_000_000_000n) {
      return emptyResult("quarantined", "quantity_not_representable");
    }
    return {
      kind: "inventory-set",
      inventoryItemId: entry.inventoryItemId,
      locationId: shopifyGid("Location", ctx.secrets.locationId),
      quantity: Number(current.available),
      referenceDocumentUri: `https://pubky.app/marketplace/events/${event.id}`,
      losses: [],
    };
  });
}

function eventHash(event: PubkyStockEvent): string {
  return payloadHash(
    new TextEncoder().encode(
      canonicalJson({
        aggregateId: event.aggregateId,
        id: event.id,
        revision: event.revision,
        type: event.type,
      }),
    ),
  );
}

function readEvent(value: LosslessJsonValue): PubkyStockEvent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as LosslessJsonObject;
  const id = record.id;
  const type = record.type;
  const aggregateId = record.aggregate_id;
  const revision = record.revision;
  if (typeof id !== "string" || typeof type !== "string" || typeof aggregateId !== "string") {
    return undefined;
  }
  if (typeof revision !== "bigint" && typeof revision !== "string") {
    return undefined;
  }
  return { id, type, aggregateId, revision: revision.toString() };
}

export async function pullInventoryEvents(ctx: ApplyContext): Promise<readonly BridgeResult[]> {
  const results: BridgeResult[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const response = await ctx.pubky.events(
      ctx.secrets.sellerPubky,
      cursor === "" ? {} : { since: cursor },
    );
    if (!response.ok) {
      results.push(emptyResult("rejected", "pubky_rejected"));
      return results;
    }
    const events = response.value.events;
    if (!Array.isArray(events)) {
      results.push(emptyResult("rejected", "pubky_rejected"));
      return results;
    }
    for (const entry of events) {
      const event = readEvent(entry);
      if (event === undefined || event.type !== "inventory.adjusted") {
        continue;
      }
      results.push(await applyOutboundEvent(event, eventHash(event), ctx));
    }
    const next = response.value.next_cursor;
    if (typeof next !== "string" || next === "") {
      return results;
    }
    cursor = next;
  }
  results.push(emptyResult("rejected", "event_page_limit"));
  return results;
}

export async function applyPubkyWebhook(
  raw: Uint8Array,
  headers: {
    readonly eventId: string;
    readonly timestamp: string;
    readonly keyId: string;
    readonly signature: string;
  },
  ctx: ApplyContext,
): Promise<BridgeResult> {
  if (ctx.secrets.pubkyWebhookSecret === "" || ctx.secrets.pubkyWebhookKeyId === "") {
    return emptyResult("rejected", "pubky_webhook_unconfigured");
  }
  const verdict = verifyPubkyWebhook({
    raw,
    secretBase64Url: ctx.secrets.pubkyWebhookSecret,
    expectedKeyId: ctx.secrets.pubkyWebhookKeyId,
    eventId: headers.eventId,
    timestamp: headers.timestamp,
    keyId: headers.keyId,
    signature: headers.signature,
    nowSeconds: Math.floor(ctx.nowMs / 1000),
    maxSkewSeconds: PUBKY_SKEW_SECONDS,
  });
  if (!verdict.ok) {
    return emptyResult("rejected", verdict.reason);
  }
  let parsed: LosslessJsonValue;
  try {
    const { parseBoundedJsonLossless } = await import("../../json.js");
    parsed = parseBoundedJsonLossless(raw, {
      maxBytes: raw.byteLength,
      maxDepth: 8,
      maxNodes: 1_000,
      maxStringBytes: raw.byteLength,
    });
  } catch {
    return emptyResult("rejected", "malformed");
  }
  const event = readEvent(parsed);
  if (event === undefined || event.id !== headers.eventId) {
    return emptyResult("rejected", "malformed");
  }
  return applyOutboundEvent(event, payloadHash(raw), ctx);
}

export function renderBridgeResult(
  result: BridgeResult | readonly BridgeResult[],
  secrets: BridgeSecrets,
): string {
  return redact(`${JSON.stringify(result)}\n`, secretValues(secrets));
}

export async function directoryHomeserverWriter(directory: string): Promise<HomeserverWriter> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const resolve = (filePath: string): string => {
    const relative = filePath.replace(/^\/+/, "");
    if (relative === "" || relative.split("/").some((part) => part === ".." || part === "")) {
      throw new ShopifyBridgeError("homeserver_path");
    }
    const target = path.resolve(directory, relative);
    const root = path.resolve(directory);
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new ShopifyBridgeError("homeserver_path");
    }
    return target;
  };
  return {
    async putText(filePath, body) {
      const target = resolve(filePath);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, body, { mode: 0o600 });
    },
    async putBytes(filePath, body, contentType) {
      const target = resolve(filePath);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, body, { mode: 0o600 });
      await writeFile(`${target}.content-type`, contentType, { mode: 0o600 });
    },
  };
}
