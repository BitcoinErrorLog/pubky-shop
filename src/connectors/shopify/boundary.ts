/**
 * Fixture proof boundary. The Admin API client and webhook verifier are real.
 * They are not pointed at a Shopify shop until the operator supplies a
 * development store and a token that stays in the bridge secret file.
 */
export const SHOPIFY_ADMIN_API_VERSION = "2025-10";

export const LIVE_SHOPIFY_BOUNDARY = Object.freeze({
  liveStoreCalls: false,
  ebay: false,
  hostedCredentials: false,
  sellerRootKey: false,
  recoveryFile: false,
  shopInventoryBoard: false,
  multiLocationSum: false,
  perVariantStockAuthority: false,
  automaticRevisionRecompute: false,
  homeserverMediaPutOnCliSession: true,
  liveHomeserverMediaPut: false,
});

export const LIVE_PROOF_REQUIRES = Object.freeze([
  "A Shopify development store and its *.myshopify.com domain.",
  "A custom-app Admin API access token with product read, inventory read, and inventory write. The token stays in the bridge secret file and is not a marketplace-service secret.",
  "For inbound webhooks from Shopify, an HTTPS URL Shopify can reach. Polling the Admin API can prove inbound inventory without that URL; it does not prove webhook HMAC or replay.",
] as const);
