# @bitcoinerrorlog/pubky-shop

Private TypeScript SDK for the Pubky Marketplace inventory HTTP contract,
deterministic JSON/CSV interchange, and durable import planning. The package is
ESM-only, requires Node 22 or newer, and is not published by this repository.

## Package exports

- `.` is the browser-safe entry: codecs, `PubkyShopClient` (Wave 1 inventory
  and Wave 3a HTTP), and the in-memory import planner (`planImport`,
  `planImportStream`, `MemoryManifestStore`, `resumeTasks`, chunked
  `sync-many` helpers). It hashes with Web Crypto-compatible SHA-256 and never
  imports `node:` or `@synonymdev/pubky`.
- `./node` is the Node spool planner: `FileManifestStore`, disk-backed
  `planImport` / `planImportStream`, `resumeTasks`, and `streamResumeTasks`.
- `@synonymdev/pubky` is an optional peer used only by the CLI / `./node`.

```ts
import {
  MemoryManifestStore,
  PubkyShopClient,
  planImport,
} from "@bitcoinerrorlog/pubky-shop";
import { FileManifestStore, planImport as planImportNode } from "@bitcoinerrorlog/pubky-shop/node";
```

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
unknown response fields for forward compatibility. Wave 3a seller HTTP is on
the same class: `listings`, `orders`, `events`, `getListing`, `syncMany`
(chunks of 100), webhooks, and sessions. `createSession` POSTs AuthToken bytes
as `application/octet-stream` and does not attach an existing bearer. Wave 1 Rust `i64` fields
(`server_revision` and every stock quantity) are exposed consistently as
`bigint`, including ordinary small values. Integer JSON tokens are captured
before JavaScript `Number` conversion, values outside the signed 64-bit range
and non-integer tokens fail with `invalid_response`, and unknown integer fields
are also retained losslessly as `bigint`.

`InventoryAdjustRequest.expected_revision` and `delta` are `bigint`. The SDK
serializes them as exact unquoted JSON integer tokens; for example
`expected_revision: 9007199254740992n` sends
`"expected_revision":9007199254740992`. Response bodies remain bounded,
server messages are never reflected, and only allowlisted service error codes
are exposed.

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

`parseCanonicalCsvStream(source, onRow, limits)` is the unbounded-catalog byte
API. `source` may be an `AsyncIterable<Uint8Array>`, a
`ReadableStream<Uint8Array>`, or a synchronous iterable. It incrementally
hashes source bytes, decodes UTF-8, recognizes a BOM even when its three bytes
arrive separately, and preserves RFC 4180 state across chunk-split CRLF,
escaped quotes, and multibyte characters. It retains only the current bounded
row/cell and reports measured peak parser-owned bytes. Cross-row duplicate and
listing-group validation is performed by `planImportStream` before commit.

`parseCanonicalCsv(bytes)` is the bounded, materializing convenience codec. It
accepts BOM or no BOM and rejects lone LF/CR, truncated quotes, duplicate
headers/rows/variant ids, ambiguous SKUs, conflicting listing fields, raw
formula payloads, invalid identity/mapping, unsafe integers, and over-limit
input. Unknown extra columns are retained in `extraFields` and exported
deterministically.

Canonical columns are:

`record_uri`, `seller_pubky`, `listing_id`, `source_listing_key`,
`record_revision`, `variant_id`, `sku`, `state`, `title`, `description`,
`taxonomy_json`, `category`, `condition`, `tags_json`, `amount_minor`,
`currency`, `exponent`, `variant_quantity`, `variant_enabled`,
`options_json`, `media_json`, `shipping_options_json`,
`return_policy_json`, `sale_json`, and `external_refs_json`.

Identity comes only from `record_uri`, `(seller_pubky, listing_id)`, or an
explicit `source_listing_key` for a new record. Title is never identity.
Streaming input has no fixed total-byte or total-row cap. Row bytes, cell
bytes, columns, nested JSON depth, and parser/planner working sets are bounded
and fail with typed safe observed values. The byte-array convenience parser
and exporter additionally retain explicit total byte/row caps.

## Durable import planning

Browser hosts plan against an in-memory `ManifestStore` (Shop supplies Dexie):

```ts
import {
  MemoryManifestStore,
  browserFileSource,
  planImportStream,
  resumeTasks,
} from "@bitcoinerrorlog/pubky-shop";

const store = new MemoryManifestStore();
const planned = await planImportStream(browserFileSource(file), { store });
```

`planImport` / `planImportStream` on `.` stream-parse with Web APIs, bound the
working set (64 MiB convenience / parser-planner bytes), and call `store.create`
only after EOF, UTF-8/CSV/JSON/mapping validation, identity-index checks, and
source SHA-256 completion. Parse failure leaves zero rows. JSON is a bounded
convenience path (`[{…}]` or `{rows:[…]}`); CSV is streamed. Idempotency keys
are UUID v5-like from SHA-256 of schema, manifest id, row identity, and
normalized hash — the same bytes as the Node planner. `chunkSyncManyListings`
splits publish batches at 100. `classifySyncManyItem` reads per-id 207 results.

Node hosts keep the disk spool planner:

```ts
import {
  FileManifestStore,
  planImportStream,
  replayImport,
  resumeTasks,
} from "@bitcoinerrorlog/pubky-shop/node";

const store = new FileManifestStore("/secure/host-owned/import-manifests");
const planned = await planImportStream(fileReadable, { store });
```

Planning incrementally writes a mode-0600 spool and external grouping indexes
inside the host-provided manifest directory. Bounded external merge sorts
validate duplicate rows, variant identities, SKUs, and listing-level facts
without retaining decoded source or all rows in process memory. The first
committed manifest write occurs only after EOF, UTF-8/CSV/mapping validation,
external grouping, generated-id collision checks, and source SHA-256
completion. Malformed late input removes the planning spool and leaves no
manifest.

A manifest fixes its id, exact source SHA-256 and decimal source-byte count,
parser/mapping/schema versions, complete immutable row identities, normalized
row hashes, actions, generated listing ids, and deterministic idempotency
keys. The JSONL manifest is streamed to an fsynced temporary file and
atomically renamed. `loadSummary` and `streamRows` avoid materialization;
`load` and `planImport(bytes, ...)` are explicitly bounded convenience APIs.
`streamRows` validates the complete file and trailing row count before it
yields any authoritative row. `checkpointImportRow` performs a bounded
streaming atomic rewrite, and `streamResumeTasks` resumes catalogs of any row
count without calling `load`. Generated ids are persisted before a future
publisher may act.

`FileManifestStore` is the production host-supplied adapter included in this
package. It canonicalizes the configured root once, pins its device, inode,
and mode, and verifies that identity before and after lock, manifest, spool,
quarantine, and cleanup operations. Final opens use no-follow flags where Node
exposes them; files are mode 0600, the root and planning directories are mode
0700, and writes use inter-process exclusion, fsync, and atomic rename or
append.

This is deliberately not an `openat` confinement claim: Node has no
directory-relative no-follow API. The host configuration and the canonical
root's parent are trusted and must not be concurrently renameable by an
attacker. Detected root replacement fails closed, but a privileged
parent-directory attacker racing the unavoidable check/open gap is outside the
adapter's threat model. A symlink in a trusted parent is canonicalized; a
symlink as the configured final root or a managed final file is refused.
Abandoned dead-process `.planning` and `.tmp` artifacts are reaped only after
the configured age, while live-PID, young, changed-identity, and unknown files
are retained.

Per-row checkpoints are `planned`, `publishing`, `published_unsynced`,
`complete`, `conflict`, and `failed`. Restart maps an uncertain `publishing`
row to `reconcile_publish`, never a blind repeat; `published_unsynced` resumes
only the service-sync leg.

`replayImport` returns the existing manifest for identical row identities and
hashes. Changed content is recorded in a separate immutable
`pubky-shop-replay-quarantine` JSONL log with its own monotonic version and a
compare-and-append check against the manifest version. Identity is
`SHA-256(manifest schema/version, replay source SHA-256, canonical conflict
hash)`: sequential, concurrent, and post-restart duplicate replays return the
existing durable record without adding a version. Metadata records are bounded
and appended with `O_APPEND`; conflict rows live in an immutable,
content-verified JSONL sidecar and are read with `streamReplayConflicts`.
Neither append nor read rewrites or materializes prior history.

D6.19 retention is host-operated: retain manifest/result and quarantine files
for at least 30 days, then call `compactReplayQuarantines` with the retention
cutoff. Compaction is the explicit bounded streaming maintenance operation;
after an identity ages out, a later replay may create a new audit record.
Storage is therefore bounded by the host's retained replay volume, not by an
unsafe in-process cap. A truncated quarantine tail fails closed until the host
calls `repairReplayQuarantineTail`, which validates every complete record and
removes only the incomplete final fragment. `discardManifest` is the
version-CAS discard control; it makes the manifest unavailable first, then
removes its retained quarantine/conflict files. Replay never changes
`complete`, `conflict`, `failed`, or any other row checkpoint. Quarantine
reports survive a new `FileManifestStore` instance. Malformed or truncated CSV
creates no manifest. Wave 2 has no homeserver PUT, fake compare-and-swap,
service publication, connector, CLI, webhook, payment, or UI surface.

External grouping retains only one fixed fan-in batch. Generated runs use
deterministic generation/index names rather than an in-memory path catalog.
The byte budget charges each input's fixed 64 KiB stream/readline/decoder
overhead, line head, iterator, pathname, and output metadata; fan-in is the
minimum allowed by that budget and the explicit descriptor cap
(`maxSortOpenFiles`, default 16). Reported resource usage includes both the
configured cap and measured descriptor/metadata/working-set high-water marks.
A configuration that cannot support a two-way merge is rejected before
reading input.

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

## Seller CLI

`pubky-shop` is the seller command-line client. Shipped defaults are production
origins (`https://shop.pubky.app` and
`https://marketplace-service-production-ce23.up.railway.app`). Override with
`--bff-url` / `--service-url`, `PUBKY_SHOP_BFF_URL` / `PUBKY_SHOP_SERVICE_URL`,
or `$XDG_CONFIG_HOME/pubky-shop/config.json` keys `bff_url` and `service_url`
(flags beat env beat file).

Marketplace login uses Shop BFF CLI grant routes. The CLI generates
`result_cpk` / `result_delivery_id`, proves an existing homeserver session with
a homeserver PoP PUT, and never holds Shop cookies or BFF signing keys. Login
binds the grant to the homeserver session pubky. Headless proof (CI and live
tests) mints a staging seat, then calls `@synonymdev/pubky` 0.11
`Signer.approveAuthRequest` on the `pubkyauth://signin_grant` URL so the SDK
posts GrantClaims. `@synonymdev/pubky` 0.8 posts an AuthToken onto that inbox
and the grant worker terminalizes `grant_invalid`. After approval, `auth login
--complete` tickets and claims the service bearer. `auth login` loads a stored
homeserver session covering `/pub/pubky.app/marketplace/:rw` from keychain
service `pubky-shop`, account `{origin}|{pubky}|homeserver-session`, or from a
mode-0600 file in `PUBKY_SHOP_CREDENTIAL_DIR` / the config credential
directory. The payload is `{pubky,capabilities,secret}` where `secret` is
`Session.exportLocalSecret()`. Missing that item is exit 2
`homeserver_session_missing`. Unreadable or unrestorable material is exit 2
`homeserver_session_invalid`. The marketplace bearer is a separate item,
account `{origin}|{pubky}`. Claim does not return a session id; `auth logout`
requires `--force-local` unless a UUID session id is present.

```sh
PUBKY_SHOP_LIVE=1 npm test -- test/cli.live.test.ts
pubky-shop auth login --json --complete
pubky-shop auth status --json
pubky-shop listings export --format json --output listings.json
pubky-shop listings import --input listings.json
pubky-shop orders export --json
pubky-shop events tail --json
pubky-shop webhook add --url https://example.invalid/hook
pubky-shop webhook rotate --id <webhook-id>
pubky-shop webhook delete --id <webhook-id>
pubky-shop auth logout --force-local
```

`--json` prints `{ok,data,error{code,message}}`. Exit `0` success, `1` usage,
`2` auth/denied, `3` remote/rate-limit/unavailable.

## Development gates

Runtime dependencies (`@noble/curves`, `qrcode`) belong to the CLI.
`@synonymdev/pubky` is an optional peer of `./node` and the CLI. The `.`
export does not import them.

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
