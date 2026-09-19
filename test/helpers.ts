import type { CanonicalCsvRow } from "../src/index.js";

export const SELLER_PUBKY = "y".repeat(52);

export function sampleRow(overrides: Partial<CanonicalCsvRow> = {}): CanonicalCsvRow {
  return {
    recordUri: `pubky://${SELLER_PUBKY}/pub/pubky.app/marketplace/v1/listings/boots_01`,
    sellerPubky: SELLER_PUBKY,
    listingId: "boots_01",
    sourceListingKey: "",
    recordRevision: 1,
    variantId: "black_m",
    sku: "BOOTS-BLK-M",
    state: "active",
    title: 'Boots, "Night"\r\nSecond line',
    description: "=literal formula-like description",
    taxonomy: { department: "fashion", trail: ["shoes", "boots"] },
    category: "boots",
    condition: "new",
    tags: ["night", "leather"],
    amountMinor: 12_500,
    currency: "USD",
    exponent: 2,
    variantQuantity: 3,
    variantEnabled: true,
    options: { color: "black", size: "M" },
    media: [{ id: "m1", alt: 'front, quoted "view"' }],
    shippingOptions: [{ pricing: "free" }],
    returnPolicy: { accepted: true, days: 30 },
    sale: { format: "fixed_price" },
    externalRefs: { shopify: "gid://shopify/Product/1" },
    extraFields: { channel_note: "@literal note" },
    ...overrides,
  };
}
