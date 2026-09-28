import type { CanonicalCsvRow } from "../../csv.js";
import type { JsonObject, JsonValue, LosslessJsonValue } from "../../json.js";
import { canonicalJson, parseBoundedJsonLossless } from "../../json.js";
import { ShopifyBridgeError } from "./errors.js";
import { isPubkyId, payloadHash, shopifyGid } from "./ids.js";

export const SHOPIFY_LOSS_CODES = [
  "html_body",
  "unpublished_product",
  "market_price_list",
  "location_not_selected",
  "csv_quantity_unscoped",
  "variant_inventory_quantity_unscoped",
  "compare_at_price",
  "cost",
  "barcode",
  "seo",
  "google_shopping",
  "weight",
  "inventory_policy",
  "tax",
  "gift_card",
  "image_src_requires_seller_download",
  "image_download_failed",
  "condition_defaulted",
  "shipping_price_absent",
  "return_policy_absent",
  "unmapped_header",
  "price_scale",
  "variant_price_not_representable",
  "no_stock_at_location",
  "zero_quantity_variant_omitted",
  "listing_total_not_per_variant",
  "category_absent",
  "handle_not_identity",
  "location_stock_unresolved",
  "sku_not_searchable",
  "metafield",
  "collection",
] as const;

export type ShopifyLossCode = (typeof SHOPIFY_LOSS_CODES)[number];

export interface ShopifyLoss {
  readonly code: ShopifyLossCode;
  readonly source: string;
  readonly detail: string;
}

export interface ShopifyMapConfig {
  readonly sellerPubky: string;
  readonly currency: string;
  readonly exponent: number;
}

export interface LocationLevel {
  readonly inventoryItemId: string;
  readonly locationId: string;
  readonly available: number;
}

export interface MappedVariant {
  readonly variantId: string;
  readonly sku: string;
  readonly inventoryItemId: string;
  readonly quantity: number;
  readonly options: JsonObject;
}

export interface MappedImage {
  readonly src: string;
  readonly alt: string;
}

export interface MappedProduct {
  readonly handle: string;
  readonly listingId: string;
  readonly sellerPubky: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly condition: string;
  readonly tags: readonly string[];
  readonly taxonomy: JsonObject;
  readonly amountMinor: number;
  readonly currency: string;
  readonly exponent: number;
  readonly externalId: string;
  readonly variants: readonly MappedVariant[];
  readonly images: readonly MappedImage[];
  readonly losses: readonly ShopifyLoss[];
}

export interface SkippedShopifyProduct {
  readonly handle: string;
  readonly losses: readonly ShopifyLoss[];
}

export interface ShopifyCsvMap {
  readonly products: readonly MappedProduct[];
  readonly skipped: readonly SkippedShopifyProduct[];
  readonly headerLosses: readonly ShopifyLoss[];
}

/**
 * Current published product CSV columns and the legacy names they replaced.
 * Both spellings normalize to one internal field. See Shopify's product CSV table.
 */
export const SHOPIFY_PRODUCT_CSV_HEADERS = [
  "Title",
  "URL handle",
  "Handle",
  "Description",
  "Body (HTML)",
  "Vendor",
  "Product category",
  "Product Category",
  "Type",
  "Tags",
  "Published on online store",
  "Published",
  "Status",
  "SKU",
  "Variant SKU",
  "Option1 name",
  "Option1 Name",
  "Option1 value",
  "Option1 Value",
  "Price",
  "Variant Price",
  "Inventory quantity",
  "Variant Inventory Qty",
  "Product image URL",
  "Image Src",
  "Image alt text",
  "Image Alt Text",
  "Gift card",
  "Gift Card",
] as const;

const HEADER_FIELDS: Readonly<Record<string, string>> = {
  Title: "title",
  "URL handle": "handle",
  Handle: "handle",
  Description: "description",
  "Body (HTML)": "description",
  Vendor: "vendor",
  "Product category": "product_category",
  "Product Category": "product_category",
  Type: "type",
  Tags: "tags",
  "Published on online store": "published",
  Published: "published",
  Status: "status",
  SKU: "sku",
  "Variant SKU": "sku",
  "Option1 name": "option1_name",
  "Option1 Name": "option1_name",
  "Option1 value": "option1_value",
  "Option1 Value": "option1_value",
  "Option2 name": "option2_name",
  "Option2 Name": "option2_name",
  "Option2 value": "option2_value",
  "Option2 Value": "option2_value",
  "Option3 name": "option3_name",
  "Option3 Name": "option3_name",
  "Option3 value": "option3_value",
  "Option3 Value": "option3_value",
  Price: "price",
  "Variant Price": "price",
  "Inventory quantity": "inventory_quantity",
  "Variant Inventory Qty": "inventory_quantity",
  "Product image URL": "image_src",
  "Image Src": "image_src",
  "Image position": "image_position",
  "Image Position": "image_position",
  "Image alt text": "image_alt",
  "Image Alt Text": "image_alt",
  "Variant image URL": "variant_image",
  "Variant Image": "variant_image",
  "Gift card": "gift_card",
  "Gift Card": "gift_card",
  "Google Shopping / Condition": "condition",
};

const HEADER_LOSSES: Readonly<Record<string, ShopifyLossCode>> = {
  "Compare-at price": "compare_at_price",
  "Variant Compare At Price": "compare_at_price",
  "Cost per item": "cost",
  Barcode: "barcode",
  "Variant Barcode": "barcode",
  "SEO title": "seo",
  "SEO Title": "seo",
  "SEO description": "seo",
  "SEO Description": "seo",
  "Weight value (grams)": "weight",
  "Variant Grams": "weight",
  "Weight unit for display": "weight",
  "Variant Weight Unit": "weight",
  "Inventory tracker": "inventory_policy",
  "Variant Inventory Tracker": "inventory_policy",
  "Continue selling when out of stock": "inventory_policy",
  "Variant Inventory Policy": "inventory_policy",
  "Fulfillment service": "inventory_policy",
  "Variant Fulfillment Service": "inventory_policy",
  "Charge tax": "tax",
  "Variant Taxable": "tax",
  "Variant Tax Code": "tax",
  "Requires shipping": "shipping_price_absent",
  "Variant Requires Shipping": "shipping_price_absent",
  "Inventory quantity": "csv_quantity_unscoped",
  "Variant Inventory Qty": "csv_quantity_unscoped",
  Collection: "collection",
};

function loss(code: ShopifyLossCode, source: string, detail: string): ShopifyLoss {
  return { code, source, detail };
}

function isObject(
  value: LosslessJsonValue | undefined,
): value is { [key: string]: LosslessJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idString(value: LosslessJsonValue | undefined): string | undefined {
  if (typeof value === "bigint" && value >= 0n) {
    return value.toString(10);
  }
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[0-9A-Za-z:/_.-]+$/.test(value)
  ) {
    return value;
  }
  return undefined;
}

function text(value: LosslessJsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function minorUnits(price: string, exponent: number): number | undefined {
  if (!/^\d+(\.\d+)?$/.test(price)) {
    return undefined;
  }
  const [whole, fraction = ""] = price.split(".");
  if (whole === undefined || fraction.length > exponent) {
    return undefined;
  }
  const scale = 10n ** BigInt(exponent);
  const minor = BigInt(whole) * scale + BigInt(fraction.padEnd(exponent, "0") || "0");
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  return Number(minor);
}

function parseRfc4180(textBody: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < textBody.length; index += 1) {
    const character = textBody[index];
    if (quoted) {
      if (character === '"') {
        if (textBody[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character ?? "";
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (character !== "\r") {
      cell += character ?? "";
    }
  }
  if (quoted) {
    throw new ShopifyBridgeError("malformed_shopify_csv");
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => value !== ""));
}

function headerRole(
  header: string,
): "field" | "loss" | "image" | "market" | "google" | "metafield" | "unknown" {
  if (
    header.startsWith("Price / ") ||
    header.startsWith("Compare-at price / ") ||
    header.startsWith("Compare At Price / ") ||
    header.startsWith("Included / ")
  ) {
    return "market";
  }
  if (header.includes("product.metafields.") || /^Option\d+ LinkedTo$/i.test(header)) {
    return "metafield";
  }
  if (header.startsWith("Google Shopping /") && header !== "Google Shopping / Condition") {
    return "google";
  }
  if (HEADER_FIELDS[header] !== undefined) {
    return header === "Product image URL" ||
      header === "Image Src" ||
      header === "Variant image URL" ||
      header === "Variant Image" ||
      header === "Image position" ||
      header === "Image Position" ||
      header === "Image alt text" ||
      header === "Image Alt Text"
      ? "image"
      : "field";
  }
  if (HEADER_LOSSES[header] !== undefined) {
    return "loss";
  }
  return "unknown";
}

function headerLosses(headers: readonly string[]): ShopifyLoss[] {
  const losses: ShopifyLoss[] = [];
  for (const header of headers) {
    const role = headerRole(header);
    if (role === "market") {
      losses.push(
        loss("market_price_list", header, "Market and price-list columns are not imported."),
      );
      continue;
    }
    if (role === "metafield") {
      losses.push(loss("metafield", header, "Metafield columns have no Pubky field."));
      continue;
    }
    if (role === "google") {
      losses.push(loss("google_shopping", header, "Google Shopping columns have no Pubky field."));
      continue;
    }
    if (role === "image") {
      losses.push(
        loss(
          "image_src_requires_seller_download",
          header,
          "Image URLs are not stored. The bridge downloads bytes.",
        ),
      );
      continue;
    }
    const code = HEADER_LOSSES[header];
    if (code !== undefined) {
      losses.push(
        loss(code, header, "The Shopify column has no Pubky field and is not copied into stock."),
      );
      continue;
    }
    if (role === "unknown") {
      losses.push(
        loss(
          "unmapped_header",
          header.slice(0, 80),
          "The header is not in the published Shopify product CSV map.",
        ),
      );
    }
  }
  return losses;
}

interface CsvRecord {
  readonly values: Readonly<Record<string, string>>;
}

function recordsFromCsv(bytes: Uint8Array): { headers: string[]; records: CsvRecord[] } {
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  const table = parseRfc4180(decoded);
  const headerRow = table[0];
  if (headerRow === undefined || headerRow.length === 0) {
    throw new ShopifyBridgeError("invalid_shopify_csv_header");
  }
  const headers = headerRow.map((header) => header.trim());
  if (headers.some((header) => header === "") || new Set(headers).size !== headers.length) {
    throw new ShopifyBridgeError("invalid_shopify_csv_header");
  }
  const fields = new Set(
    headers.map((header) => HEADER_FIELDS[header]).filter((field) => field !== undefined),
  );
  if (!fields.has("handle") || !fields.has("title") || !fields.has("price")) {
    throw new ShopifyBridgeError("invalid_shopify_csv_header");
  }
  const records: CsvRecord[] = [];
  for (const cells of table.slice(1)) {
    const values: Record<string, string> = Object.create(null) as Record<string, string>;
    headers.forEach((header, index) => {
      const field = HEADER_FIELDS[header];
      if (field === undefined) {
        return;
      }
      const cell = cells[index] ?? "";
      const current = values[field];
      if (current !== undefined && current !== "" && cell !== "" && current !== cell) {
        throw new ShopifyBridgeError("invalid_shopify_csv_header");
      }
      if (current === undefined || current === "") {
        values[field] = cell;
      }
    });
    records.push({ values });
  }
  return { headers, records };
}

export function csvProductSourceHash(bytes: Uint8Array, handle: string): string {
  const { records } = recordsFromCsv(bytes);
  const rows = records
    .filter((record) => (record.values.handle ?? "").trim() === handle)
    .map((record) => {
      const copy: Record<string, string> = { ...record.values };
      delete copy.inventory_quantity;
      return copy;
    });
  return payloadHash(new TextEncoder().encode(canonicalJson(rows)));
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && /^(true|yes)$/i.test(value.trim());
}

function publishedActive(values: Readonly<Record<string, string>>): boolean {
  const status = (values.status ?? "").trim().toLowerCase();
  if (status === "draft" || status === "archived") {
    return false;
  }
  const published = (values.published ?? "").trim();
  if (published !== "" && !truthy(published)) {
    return false;
  }
  return status === "" || status === "active";
}

function conditionFrom(values: Readonly<Record<string, string>>, losses: ShopifyLoss[]): string {
  const raw = (values.condition ?? "").trim().toLowerCase();
  if (raw === "new" || raw === "used" || raw === "refurbished") {
    return raw === "refurbished" ? "used" : raw;
  }
  losses.push(
    loss("condition_defaulted", "Google Shopping / Condition", "Condition defaults to new."),
  );
  return "new";
}

function tagsFrom(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function optionsFrom(values: Readonly<Record<string, string>>): JsonObject {
  const options: JsonObject = {};
  for (const index of [1, 2, 3] as const) {
    const name = (values[`option${index}_name`] ?? "").trim();
    const optionValue = (values[`option${index}_value`] ?? "").trim();
    if (name !== "" && optionValue !== "") {
      options[name] = optionValue;
    }
  }
  return options;
}

function isVariantRow(values: Readonly<Record<string, string>>): boolean {
  return (values.price ?? "").trim() !== "" || (values.sku ?? "").trim() !== "";
}

export function mapShopifyProductCsv(bytes: Uint8Array, config: ShopifyMapConfig): ShopifyCsvMap {
  if (config.sellerPubky.length !== 52 || !/^[A-Z]{3}$/.test(config.currency)) {
    throw new ShopifyBridgeError("invalid_configuration");
  }
  const { headers, records } = recordsFromCsv(bytes);
  const grouped = new Map<string, CsvRecord[]>();
  for (const record of records) {
    const handle = (record.values.handle ?? "").trim();
    if (handle === "") {
      continue;
    }
    const current = grouped.get(handle) ?? [];
    current.push(record);
    grouped.set(handle, current);
  }
  const products: MappedProduct[] = [];
  const skipped: SkippedShopifyProduct[] = [];
  for (const [handle, rows] of grouped) {
    const first = rows[0];
    if (first === undefined) {
      continue;
    }
    const losses: ShopifyLoss[] = [];
    if (!isPubkyId(handle)) {
      skipped.push({
        handle,
        losses: [loss("handle_not_identity", "Handle", "The handle is not a Pubky listing id.")],
      });
      continue;
    }
    if (rows.some((row) => truthy(row.values.gift_card ?? ""))) {
      skipped.push({
        handle,
        losses: [loss("gift_card", "Gift Card", "Gift cards are not imported.")],
      });
      continue;
    }
    if (!publishedActive(first.values)) {
      skipped.push({
        handle,
        losses: [
          loss("unpublished_product", "Status", "Unpublished or draft products are not imported."),
        ],
      });
      continue;
    }
    const title =
      rows.map((row) => (row.values.title ?? "").trim()).find((value) => value !== "") ?? "";
    const html =
      rows.map((row) => row.values.description ?? "").find((value) => value.trim() !== "") ?? "";
    if (html.trim() !== "" && /<[^>]+>/.test(html)) {
      losses.push(loss("html_body", "Description", "HTML was stripped to text and is not stored."));
    }
    const description = stripHtml(html);
    const category =
      (first.values.product_category ?? "").trim() || (first.values.type ?? "").trim();
    if (category === "") {
      losses.push(loss("category_absent", "Product category", "No category was present."));
    }
    const vendor = (first.values.vendor ?? "").trim();
    const productType = (first.values.type ?? "").trim();
    const productCategory = (first.values.product_category ?? "").trim();
    const taxonomy: JsonObject = {};
    if (vendor !== "") {
      taxonomy.vendor = vendor;
    }
    if (productType !== "") {
      taxonomy.productType = productType;
    }
    if (productCategory !== "") {
      taxonomy.productCategory = productCategory;
    }
    const tags = tagsFrom(first.values.tags ?? "");
    const condition = conditionFrom(first.values, losses);
    losses.push(
      loss(
        "shipping_price_absent",
        "Variant Requires Shipping",
        "Shopify CSV has no shipping price.",
      ),
    );
    losses.push(loss("return_policy_absent", "return_policy", "Shopify CSV has no return policy."));
    const images: MappedImage[] = [];
    for (const row of rows) {
      const src = (row.values.image_src ?? "").trim() || (row.values.variant_image ?? "").trim();
      if (src !== "") {
        images.push({ src, alt: (row.values.image_alt ?? "").trim() });
      }
    }
    const variants: MappedVariant[] = [];
    const prices: number[] = [];
    rows.forEach((row, index) => {
      if (!isVariantRow(row.values)) {
        return;
      }
      const price = minorUnits((row.values.price ?? "").trim(), config.exponent);
      if (price === undefined) {
        losses.push(
          loss("price_scale", "Price", "The price does not fit the configured exponent."),
        );
        return;
      }
      prices.push(price);
      const sku = (row.values.sku ?? "").trim();
      const variantId = isPubkyId(sku) ? sku : `v${index + 1}`;
      const quantityText = (row.values.inventory_quantity ?? "").trim();
      if (quantityText !== "") {
        losses.push(
          loss(
            "csv_quantity_unscoped",
            "Inventory quantity",
            "CSV quantity is not a selected location and is not canonical stock.",
          ),
        );
      }
      variants.push({
        variantId,
        sku,
        inventoryItemId: "",
        quantity: 0,
        options: optionsFrom(row.values),
      });
    });
    if (prices.length === 0 || variants.length === 0) {
      skipped.push({ handle, losses });
      continue;
    }
    const firstPrice = prices[0];
    if (firstPrice === undefined || prices.some((price) => price !== firstPrice)) {
      skipped.push({
        handle,
        losses: [
          ...losses,
          loss(
            "variant_price_not_representable",
            "Variant Price",
            "Canonical CSV has one listing price.",
          ),
        ],
      });
      continue;
    }
    products.push({
      handle,
      listingId: handle,
      sellerPubky: config.sellerPubky,
      title,
      description,
      category,
      condition,
      tags,
      taxonomy,
      amountMinor: firstPrice,
      currency: config.currency,
      exponent: config.exponent,
      externalId: `handle:${handle}`,
      variants,
      images,
      losses,
    });
  }
  return { products, skipped, headerLosses: headerLosses(headers) };
}

export function canonicalRowsFor(
  product: MappedProduct,
  media: JsonValue = [],
  options?: { readonly includeZeroQuantity?: boolean },
): CanonicalCsvRow[] {
  const kept = options?.includeZeroQuantity
    ? product.variants
    : product.variants.filter((variant) => variant.quantity > 0);
  const externalRefs: JsonObject = {
    channel: "shopify",
    external_id: product.externalId,
    handle: product.handle,
  };
  const recordUri = `pubky://${product.sellerPubky}/pub/pubky.app/marketplace/v1/listings/${product.listingId}`;
  return kept.map((variant) => ({
    recordUri,
    sellerPubky: product.sellerPubky,
    listingId: product.listingId,
    sourceListingKey: product.handle,
    recordRevision: 1,
    variantId: variant.variantId,
    sku: variant.sku,
    state: "active",
    title: product.title,
    description: product.description,
    taxonomy: product.taxonomy,
    category: product.category,
    condition: product.condition,
    tags: [...product.tags],
    amountMinor: product.amountMinor,
    currency: product.currency,
    exponent: product.exponent,
    variantQuantity: variant.quantity,
    variantEnabled: true,
    options: variant.options,
    media,
    shippingOptions: [],
    returnPolicy: { accepted: false },
    sale: { format: "fixed_price" },
    externalRefs,
    extraFields: {},
  }));
}

export function mapProductUpdate(
  bytes: Uint8Array,
  config: ShopifyMapConfig,
): MappedProduct | SkippedShopifyProduct {
  const parsed = parseBoundedJsonLossless(bytes, {
    maxBytes: bytes.byteLength,
    maxDepth: 16,
    maxNodes: 100_000,
    maxStringBytes: bytes.byteLength,
  });
  if (!isObject(parsed)) {
    throw new ShopifyBridgeError("malformed_shopify_payload");
  }
  const handle = text(parsed.handle).trim();
  const losses: ShopifyLoss[] = [];
  if (!isPubkyId(handle)) {
    return {
      handle,
      losses: [loss("handle_not_identity", "handle", "The handle is not a Pubky listing id.")],
    };
  }
  const status = text(parsed.status).trim().toLowerCase();
  if (status !== "" && status !== "active") {
    return {
      handle,
      losses: [loss("unpublished_product", "status", "Unpublished products are not imported.")],
    };
  }
  if (parsed.published_at === null) {
    return {
      handle,
      losses: [
        loss("unpublished_product", "published_at", "Unpublished products are not imported."),
      ],
    };
  }
  const html = text(parsed.body_html);
  if (html.trim() !== "") {
    losses.push(loss("html_body", "body_html", "HTML was stripped to text and is not stored."));
  }
  const productId = idString(parsed.id);
  const externalId =
    productId === undefined ? `handle:${handle}` : shopifyGid("Product", productId);
  const tags = tagsFrom(text(parsed.tags));
  const taxonomy: JsonObject = {};
  if (text(parsed.vendor).trim() !== "") {
    taxonomy.vendor = text(parsed.vendor).trim();
  }
  if (text(parsed.product_type).trim() !== "") {
    taxonomy.productType = text(parsed.product_type).trim();
  }
  losses.push(
    loss("shipping_price_absent", "shipping", "The product payload has no shipping price."),
  );
  losses.push(
    loss("return_policy_absent", "return_policy", "The product payload has no return policy."),
  );
  losses.push(loss("condition_defaulted", "condition", "Condition defaults to new."));
  const variantsIn = Array.isArray(parsed.variants) ? parsed.variants : [];
  const variants: MappedVariant[] = [];
  const prices: number[] = [];
  variantsIn.forEach((entry, index) => {
    if (!isObject(entry)) {
      return;
    }
    if (entry.inventory_quantity !== undefined) {
      losses.push(
        loss(
          "variant_inventory_quantity_unscoped",
          "variants.inventory_quantity",
          "Variant inventory quantity is not a single location and is not used as stock.",
        ),
      );
    }
    const price = minorUnits(text(entry.price).trim(), config.exponent);
    if (price === undefined) {
      losses.push(
        loss("price_scale", "variants.price", "The price does not fit the configured exponent."),
      );
      return;
    }
    prices.push(price);
    const sku = text(entry.sku).trim();
    const variantNumeric = idString(entry.id);
    const variantId = isPubkyId(sku)
      ? sku
      : variantNumeric === undefined
        ? `v${index + 1}`
        : `v${variantNumeric}`;
    const inventoryItem = idString(entry.inventory_item_id);
    const options: JsonObject = {};
    if (text(entry.option1) !== "") {
      options.option1 = text(entry.option1);
    }
    if (text(entry.option2) !== "") {
      options.option2 = text(entry.option2);
    }
    if (text(entry.option3) !== "") {
      options.option3 = text(entry.option3);
    }
    if (!isPubkyId(variantId)) {
      losses.push(loss("handle_not_identity", "variants.id", "A variant id is not a Pubky id."));
      return;
    }
    variants.push({
      variantId,
      sku,
      inventoryItemId:
        inventoryItem === undefined ? "" : shopifyGid("InventoryItem", inventoryItem),
      quantity: 0,
      options,
    });
  });
  const firstPrice = prices[0];
  if (firstPrice === undefined || variants.length === 0) {
    return { handle, losses };
  }
  if (prices.some((price) => price !== firstPrice)) {
    return {
      handle,
      losses: [
        ...losses,
        loss(
          "variant_price_not_representable",
          "variants.price",
          "Canonical CSV has one listing price.",
        ),
      ],
    };
  }
  const images: MappedImage[] = [];
  if (Array.isArray(parsed.images)) {
    for (const image of parsed.images) {
      if (!isObject(image)) {
        continue;
      }
      const src = text(image.src).trim();
      if (src !== "") {
        images.push({ src, alt: text(image.alt).trim() });
        losses.push(
          loss(
            "image_src_requires_seller_download",
            "images.src",
            "Image URLs are downloaded by the bridge.",
          ),
        );
      }
    }
  }
  const category = text(parsed.product_type).trim();
  return {
    handle,
    listingId: handle,
    sellerPubky: config.sellerPubky,
    title: text(parsed.title).trim(),
    description: stripHtml(html),
    category,
    condition: "new",
    tags,
    taxonomy,
    amountMinor: firstPrice,
    currency: config.currency,
    exponent: config.exponent,
    externalId,
    variants,
    images,
    losses,
  };
}

export function mapInventoryLevel(bytes: Uint8Array): {
  readonly inventoryItemId: string;
  readonly locationId: string;
  readonly available: number;
} {
  const parsed = parseBoundedJsonLossless(bytes, {
    maxBytes: bytes.byteLength,
    maxDepth: 8,
    maxNodes: 1_000,
    maxStringBytes: bytes.byteLength,
  });
  if (!isObject(parsed)) {
    throw new ShopifyBridgeError("malformed_shopify_payload");
  }
  const inventoryItemId = idString(parsed.inventory_item_id);
  const locationId = idString(parsed.location_id);
  const available = parsed.available;
  if (inventoryItemId === undefined || locationId === undefined || typeof available !== "bigint") {
    throw new ShopifyBridgeError("malformed_shopify_payload");
  }
  if (available < 0n || available > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ShopifyBridgeError("malformed_shopify_payload");
  }
  return {
    inventoryItemId: shopifyGid("InventoryItem", inventoryItemId),
    locationId: shopifyGid("Location", locationId),
    available: Number(available),
  };
}

export function isMappedProduct(
  value: MappedProduct | SkippedShopifyProduct,
): value is MappedProduct {
  return "listingId" in value;
}

export function applyLocationQuantities(
  product: MappedProduct,
  levels: readonly LocationLevel[],
  locationId: string,
): { readonly product: MappedProduct; readonly otherLocations: readonly string[] } {
  const chosen = shopifyGid("Location", locationId);
  const other = new Set<string>();
  const variants = product.variants.map((variant) => {
    if (variant.inventoryItemId === "") {
      return variant;
    }
    const itemLevels = levels.filter((level) => level.inventoryItemId === variant.inventoryItemId);
    for (const level of itemLevels) {
      if (level.locationId !== chosen) {
        other.add(level.locationId);
      }
    }
    const match = itemLevels.find((level) => level.locationId === chosen);
    return match === undefined
      ? { ...variant, quantity: 0 }
      : { ...variant, quantity: match.available };
  });
  const losses = [...product.losses];
  if (other.size > 0) {
    losses.push(
      loss(
        "location_not_selected",
        "location",
        "Quantities at other locations are not added to the chosen location.",
      ),
    );
  }
  const unresolved = variants.some((variant) => variant.inventoryItemId === "");
  if (unresolved) {
    losses.push(
      loss("location_stock_unresolved", "inventory_item_id", "A variant has no inventory item id."),
    );
  }
  return {
    product: { ...product, variants, losses },
    otherLocations: [...other],
  };
}
