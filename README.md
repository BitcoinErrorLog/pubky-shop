# @bitcoinerrorlog/pubky-shop

Private TypeScript SDK for the Pubky Marketplace inventory HTTP contract,
deterministic JSON/CSV interchange, and durable import planning. The package is
ESM-only, requires Node 22 or newer, and is not published by this repository.

## Credential ownership

```ts
import { PubkyShopClient } from "@bitcoinerrorlog/pubky-shop";

const client = new PubkyShopClient({
  session: process.env.PUBKY_MARKETPLACE_SESSION!,
  serviceUrl: "https://marketplace.example/",
});
```

The host obtains the opaque service bearer out of band, owns persistence,
expiry policy, renewal, revocation, account binding, and sign-out cleanup. The
SDK:

- sends `Authorization: Bearer` only to the validated HTTPS service origin;
- rejects userinfo, query, fragment, non-root path, and non-HTTPS service URLs;
- never follows redirects and never silently refreshes a rejected session;
- returns a static `session_rejected` error for HTTP 401;
- never logs, serializes, persists, returns, or hashes the bearer;
- never accepts a seller secret key, seed, root key, or keypair.

`ServiceAuthTokenSigner` is an interface-only future host boundary. It returns
host-approved AuthToken postcard bytes and the expected pubky. This package
does not implement Ring, key storage, homeserver session minting, AuthToken
exchange, or automatic bearer renewal. A service AuthToken/bearer is separate
from any homeserver credential.

## Inventory client

`getInventoryProjection(aggregateId)` and `adjustInventory(request)` return
`SdkResult<T>`. They decode the generated Wave 1 contract while preserving
unknown response fields for forward compatibility. Response bodies are
bounded, integer values must be safe JavaScript integers, server messages are
never reflected, and only allowlisted service error codes are exposed.

The projection's `stock.authority` is always `listing_total`. Variant id and
SKU are catalog lookup assertions only. This package does not claim or expose
service-authoritative variant availability.

The pinned executable contract is
`test/fixtures/service/inventory.json`, copied byte-for-byte from
`BitcoinErrorLog/pubky-marketplace-service` revision
`4d5c07c0f273616c4fba06697f90d4baef5a7722`, migration `0034`. See the
fixture provenance file for source and SHA-256 details.

## Deterministic JSON

- `canonicalJson` implements RFC 8785 JCS text.
- `encodeCanonicalJson` emits UTF-8 with exactly one trailing LF.
- `parseBoundedJson` rejects invalid UTF-8, duplicate object names, excessive
  bytes/depth/nodes/string size, and unsupported Unicode.
- `decodeExportEnvelope` / `encodeExportEnvelope` preserve unknown envelope,
  listing-wrapper, and projection fields while keeping service projection
  fields out of seller-authored records.
- `captureSignedRecord` retains exact signed-record bytes and a SHA-256
  sidecar. `emitSignedRecord(capture)` is byte-identical for unchanged records.
  A changed record requires a host-injected production schema validator and is
  then JCS serialized. Validation refusal performs no write.

The JSON codec never merges service projections into signed records.

## RFC 4180 CSV

`exportCanonicalCsv(rows, { excelBom?: boolean })` writes a mandatory header,
one row per variant, quoted UTF-8 cells, CRLF records, deterministic columns
and row ordering, and canonical JSON nested cells. Normal output has no BOM;
the explicit Excel option emits one. Dangerous spreadsheet prefixes
(`=`, `+`, `-`, `@`) and leading apostrophes use a reversible apostrophe
escape.

`parseCanonicalCsv(bytes)` accepts BOM or no BOM and rejects lone LF/CR,
truncated quotes, duplicate headers/rows/variant ids, ambiguous SKUs,
conflicting listing fields, raw formula payloads, invalid identity/mapping,
unsafe integers, and over-limit input. Unknown extra columns are retained in
`extraFields` and exported deterministically.

Canonical columns are:

`record_uri`, `seller_pubky`, `listing_id`, `source_listing_key`,
`record_revision`, `variant_id`, `sku`, `state`, `title`, `description`,
`taxonomy_json`, `category`, `condition`, `tags_json`, `amount_minor`,
`currency`, `exponent`, `variant_quantity`, `variant_enabled`,
`options_json`, `media_json`, `shipping_options_json`,
`return_policy_json`, `sale_json`, and `external_refs_json`.

Identity comes only from `record_uri`, `(seller_pubky, listing_id)`, or an
explicit `source_listing_key` for a new record. Title is never identity.
Nested JSON, byte, row, column, cell, depth, and working-set limits are
configurable and fail with typed safe observed values.

## Durable import planning

```ts
import {
  FileManifestStore,
  planImport,
  replayImport,
  resumeTasks,
} from "@bitcoinerrorlog/pubky-shop";

const store = new FileManifestStore("/secure/host-owned/import-manifests");
const planned = await planImport(csvBytes, { store });
```

Planning parses and validates the complete source before the first durable
write and performs no remote write. A manifest fixes its id, exact source
SHA-256, parser/mapping/schema versions, complete row identities, normalized
row hashes, actions, generated listing ids, and deterministic idempotency
keys. Generated ids are persisted before a future publisher may act.

`FileManifestStore` is the production host-supplied adapter included in this
package. It uses mode-0600 files in a mode-0700 directory, an inter-process
exclusive lock, version compare-and-swap, fsync, and atomic rename. The
adapter refuses a symlinked or group/world-accessible storage directory
instead of silently weakening host persistence security. Per-row checkpoints
are `planned`, `publishing`, `published_unsynced`, `complete`, `conflict`, and
`failed`. Restart maps an uncertain `publishing` row to `reconcile_publish`,
never a blind repeat; `published_unsynced` resumes only the service-sync leg.

`replayImport` returns the existing manifest for identical row identities and
hashes. Same identity with changed content is atomically quarantined with a
row conflict report. Malformed or truncated CSV creates no manifest. Wave 2
has no homeserver PUT, fake compare-and-swap, service publication, connector,
CLI, webhook, payment, or UI surface.

## Safe errors and limits

`PubkyShopError` uses static messages. Details contain only bounded numbers,
field names, allowlisted service codes, manifest ids, and row identities.
Bearer values, transport exception text, server messages/bodies, and source
cell text are excluded.

Error codes:

`invalid_configuration`, `invalid_service_url`, `invalid_session`,
`origin_violation`, `session_rejected`, `transport_error`,
`response_limit_exceeded`, `invalid_response`, `service_error`,
`invalid_json`, `unsupported_json_value`, `limit_exceeded`, `malformed_csv`,
`invalid_csv_header`, `duplicate_row`, `duplicate_variant_id`,
`ambiguous_sku`, `conflicting_listing_fields`, `formula_payload`,
`invalid_identity`, `invalid_mapping`, `validation_failed`,
`unsupported_record_version_or_field`, `manifest_conflict`,
`manifest_store_error`, and `changed_replay_quarantined`.

## Development gates

Dependencies are only TypeScript, Node type declarations, and Biome.

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run pack:dry
npm run gate
```

`npm run pack:dry` validates package contents without publishing.
