import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MemoryManifestStore,
  canonicalCsvRowIdentity,
  canonicalJson,
  canonicalRowHashes,
  deterministicIdempotencyKey,
  exportCanonicalCsv,
  normalizedCsvRowHash,
  normalizedListingFactsHash,
  planImport as planImportBrowser,
  sha256Hex,
  sha256HexSubtle,
  type CanonicalCsvColumn,
  type CanonicalCsvRow,
} from "../src/index.js";
import { FileManifestStore, planImport as planImportNode } from "../src/node.js";
import { sampleRow } from "./helpers.js";

const encoder = new TextEncoder();

/**
 * Column set and cell encoding from 0.1.3 (`ddc0d68`). The one-pass helper
 * must keep hashing these exact payloads.
 */
const V013_LISTING_COLUMNS = [
  "record_uri",
  "seller_pubky",
  "listing_id",
  "source_listing_key",
  "record_revision",
  "state",
  "title",
  "description",
  "taxonomy_json",
  "category",
  "condition",
  "tags_json",
  "amount_minor",
  "currency",
  "exponent",
  "media_json",
  "shipping_options_json",
  "return_policy_json",
  "sale_json",
  "external_refs_json",
] as const satisfies readonly CanonicalCsvColumn[];

function v013CanonicalCells(row: CanonicalCsvRow): Readonly<Record<CanonicalCsvColumn, string>> {
  return {
    record_uri: row.recordUri,
    seller_pubky: row.sellerPubky,
    listing_id: row.listingId,
    source_listing_key: row.sourceListingKey,
    record_revision: row.recordRevision === null ? "" : String(row.recordRevision),
    variant_id: row.variantId,
    sku: row.sku,
    state: row.state,
    title: row.title,
    description: row.description,
    taxonomy_json: canonicalJson(row.taxonomy),
    category: row.category,
    condition: row.condition,
    tags_json: canonicalJson(row.tags),
    amount_minor: String(row.amountMinor),
    currency: row.currency,
    exponent: String(row.exponent),
    variant_quantity: String(row.variantQuantity),
    variant_enabled: String(row.variantEnabled),
    options_json: canonicalJson(row.options),
    media_json: canonicalJson(row.media),
    shipping_options_json: canonicalJson(row.shippingOptions),
    return_policy_json: canonicalJson(row.returnPolicy),
    sale_json: canonicalJson(row.sale),
    external_refs_json: canonicalJson(row.externalRefs),
  };
}

function nodeSha256Hex(text: string): string {
  return createHash("sha256").update(encoder.encode(text)).digest("hex");
}

function v013Hashes(row: CanonicalCsvRow): {
  readonly normalizedHash: string;
  readonly listingFactsHash: string;
} {
  const cells = v013CanonicalCells(row);
  const extra = Object.fromEntries(
    Object.entries(row.extraFields).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  return {
    listingFactsHash: nodeSha256Hex(
      canonicalJson(
        Object.fromEntries(V013_LISTING_COLUMNS.map((column) => [column, cells[column]])),
      ),
    ),
    normalizedHash: nodeSha256Hex(canonicalJson({ ...cells, extra })),
  };
}

const SAMPLE_V013 = v013Hashes(sampleRow());

test("sha256Hex matches Web Crypto for empty, abc, and a 300-byte buffer", async () => {
  const cases = [new Uint8Array(), new TextEncoder().encode("abc"), new Uint8Array(300).fill(7)];
  for (const bytes of cases) {
    assert.equal(sha256Hex(bytes), await sha256HexSubtle(bytes));
  }
  assert.equal(
    sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("canonical row hashes stay byte-identical to 0.1.3 on . and ./node", async () => {
  const row = sampleRow();
  const expected = SAMPLE_V013;
  const combined = canonicalRowHashes(row);
  assert.equal(combined.normalizedHash, expected.normalizedHash);
  assert.equal(combined.listingFactsHash, expected.listingFactsHash);
  assert.equal(normalizedCsvRowHash(row), expected.normalizedHash);
  assert.equal(normalizedListingFactsHash(row), expected.listingFactsHash);
  assert.equal(combined.normalizedHash, normalizedCsvRowHash(row));
  assert.equal(combined.listingFactsHash, normalizedListingFactsHash(row));

  const csv = exportCanonicalCsv([row]);
  const manifestId = "hash-identity-v013";
  const expectedKey = deterministicIdempotencyKey(
    manifestId,
    canonicalCsvRowIdentity(row),
    expected.normalizedHash,
  );

  const browser = await planImportBrowser(csv, {
    store: new MemoryManifestStore(),
    manifestId,
  });
  assert.equal(browser.ok, true);
  if (!browser.ok) {
    return;
  }
  assert.equal(browser.value.rows[0]?.normalizedHash, expected.normalizedHash);
  assert.equal(browser.value.rows[0]?.idempotencyKey, expectedKey);

  const directory = await mkdtemp(join(tmpdir(), "pubky-shop-hash-"));
  try {
    const node = await planImportNode(csv, {
      store: new FileManifestStore(directory),
      manifestId,
    });
    assert.equal(node.ok, true);
    if (!node.ok) {
      return;
    }
    assert.equal(node.value.rows[0]?.normalizedHash, expected.normalizedHash);
    assert.equal(node.value.rows[0]?.idempotencyKey, expectedKey);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
