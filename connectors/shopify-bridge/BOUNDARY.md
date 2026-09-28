# Shopify bridge boundary

The bridge is the Node package export `@bitcoinerrorlog/pubky-shop/connectors/shopify`
and the `shopify-bridge` command. It runs on the operator's machine.

The Shopify Admin API token, the Shopify webhook secret, the Pubky service
session, and the Pubky webhook signing secret stay in the bridge secret file.
They are not sent to the other side: the Admin token is attached only to the
configured `*.myshopify.com` Admin GraphQL origin, and the Pubky session is
attached only to the configured marketplace-service origin.

The bridge does not read a seller recovery file. `shopify-bridge webhook`
loads the CLI's stored homeserver session only when that session's pubky is
the seller pubky in the secret file, then writes listing text with
`storage.putText` and media bytes with `storage.putBytes`. A homeserver
accepting those bytes is not part of this fixture gate.
`--put-dir` is refused, including when it is the last argument. A local
directory is not a homeserver writer on this command.

Stock is listing-total. Variant quantities at the single configured location
are summed into that total. Quantities at every other location are a loss and
are not added. Product CSV quantity columns (`Inventory quantity` and
`Variant Inventory Qty`) are not location-scoped. `map-csv` emits no
canonical stock from them. A CSV import publishes stock only after the Admin
API returns the configured location. Outbound Pubky `inventory.adjusted`
events call Shopify `inventorySetQuantities` with `ignoreCompareQuantity`
false and the catalog quantity as `compareQuantity`, and only when the
listing has one Shopify inventory item. A Shopify quantity that does not
match that compare value is quarantined as `shopify_quantity_conflict`. A
listing-total event for several variants is quarantined instead of being
split.

A Shopify receipt is the merchant action in `X-Shopify-Event-Id` when that
header is present, with `X-Shopify-Webhook-Id` aliased to the same receipt.
Without an event id, the webhook id is the receipt. The same identity and
hash returns the stored result. The same identity with a different hash is
quarantined until `releaseQuarantine`. CSV receipts hash that product's
rows, excluding the unscoped quantity column, so an edit to another product
does not change this product's hash. A crash after the remote call and
before `markComplete` leaves the receipt at `effect-sent`. Resume reads
Shopify available stock and does not call `inventorySetQuantities` again
when that stock is already the planned quantity. A crash after the plan is
stored replays that plan, including the same `inventory.adjust` idempotency
key. A `revision_conflict` or `idempotency_conflict` is quarantined. The
bridge does not read stock again and invent a new delta. A `sync-many` item
404 or 409 is quarantined before adjust or checkpoint. The homeserver record
written before that sync is left in place: the receipt is not checkpointed
and the catalog fingerprint is not remembered. A 408, 429, or 500 item
result is rejected and the same receipt retries.

Catalog PUT writes homeserver record revision 1 on the first import. A later
delivery with the same catalog fingerprint does not PUT again. A later
delivery whose catalog fingerprint differs is quarantined as
`catalog_changed` and does not overwrite revision 1.

Shopify webhook HMAC requires canonical Base64: a valid signature with extra
characters does not verify. `X-Shopify-Triggered-At` outside five minutes,
including one millisecond past the boundary, is `clock_skew`.

eBay, hosted credentials, and the Shop inventory board are outside this
bridge. Inventory Studio can call `mapShopifyProductCsv` for the same header
table; this change does not edit the Shop inventory board.

## Live proof

A live Shopify call needs three things from the operator:

1. A Shopify development store and its `*.myshopify.com` domain.
2. A custom-app Admin API access token with product read, inventory read, and
   inventory write, stored only in the bridge secret file.
3. For webhooks delivered by Shopify, an HTTPS URL Shopify can reach. Polling
   the Admin API can prove inbound inventory without that URL. It does not
   prove webhook HMAC or replay.

No new Pubky key is required. The first live pass can use the staging
marketplace service and the development store. The bridge still uses the
marketplace session the CLI already stores, not a recovery file.
