# Shopify bridge boundary

The bridge is the Node package export `@bitcoinerrorlog/pubky-shop/connectors/shopify`
and the `shopify-bridge` command. It runs on the operator's machine.

The Shopify Admin API token, the Shopify webhook secret, the Pubky service
session, and the Pubky webhook signing secret stay in the bridge secret file.
They are not sent to the other side: the Admin token is attached only to the
configured `*.myshopify.com` Admin GraphQL origin, and the Pubky session is
attached only to the configured marketplace-service origin.

The bridge does not read a seller recovery file. `writerFromStoredHomeserverSession`
accepts the CLI's stored homeserver session (`{pubky, capabilities, secret}`)
and rejects mnemonic, seed, and recovery fields. The CLI session type can put
listing text. It cannot put media bytes. Image bytes are written only through
a homeserver writer that implements `putBytes`. The fixture proof uses a
directory writer. A live homeserver media put is not claimed.

Stock is listing-total. Variant quantities at the single configured location
are summed into that total. Quantities at every other location are a loss and
are not added. The product CSV `Variant Inventory Qty` column is not
location-scoped, so a CSV import publishes stock only after the Admin API
returns the configured location. Outbound Pubky `inventory.adjusted` events
call Shopify `inventorySetQuantities` only when the listing has one Shopify
inventory item. A listing-total event for several variants is quarantined
instead of being split.

A receipt is `(channel, shop id, external event id)` plus the payload hash.
The same identity and hash returns the stored result. The same identity with
a different hash is quarantined until `releaseQuarantine`. A crash after the
effect is stored and before the checkpoint does not run the effect again. A
crash after the plan is stored replays that plan, including the same
`inventory.adjust` idempotency key. A `revision_conflict` or
`idempotency_conflict` is quarantined. The bridge does not read stock again
and invent a new delta.

Catalog PUT writes homeserver record revision 1. A changed Shopify payload is
quarantined rather than published as a new revision.

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
