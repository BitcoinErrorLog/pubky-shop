import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CANONICAL_CSV_COLUMNS,
  PubkyShopError,
  exportCanonicalCsv,
  parseCanonicalCsv,
} from "../src/index.js";
import { sampleRow } from "./helpers.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const goldenUrl = new URL("test/fixtures/csv/canonical.csv", `file://${process.cwd()}/`);

function code(error: unknown, expected: string): boolean {
  return error instanceof PubkyShopError && error.code === expected;
}

test("RFC 4180 export matches golden, round-trips, and has a stable second export", async () => {
  const rows = [
    sampleRow(),
    sampleRow({
      variantId: "black_l",
      sku: "BOOTS-BLK-L",
      variantQuantity: 2,
      options: { size: "L", color: "black" },
    }),
  ];
  const first = exportCanonicalCsv(rows);
  const golden = await readFile(goldenUrl);
  assert.equal(Buffer.compare(Buffer.from(first), golden), 0);
  assert.equal(first[0], '"'.charCodeAt(0), "normal exports have no BOM");
  const text = decoder.decode(first);
  assert.match(text, /\r\n/);
  assert.doesNotMatch(text.replaceAll("\r\n", ""), /[\r\n]/);
  assert.match(text, /Boots, ""Night""\r\nSecond line/);
  assert.match(text, /'=literal formula-like description/);
  assert.match(text, /'@literal note/);

  const parsed = parseCanonicalCsv(first);
  assert.equal(parsed.hadBom, false);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0]?.description, "=literal formula-like description");
  assert.equal(parsed.rows[0]?.extraFields.channel_note, "@literal note");
  const second = exportCanonicalCsv(parsed.rows);
  assert.deepEqual(second, first);
});

test("parser accepts BOM or no BOM and Excel mode emits one explicit BOM", () => {
  const normal = exportCanonicalCsv([sampleRow()]);
  const excel = exportCanonicalCsv([sampleRow()], { excelBom: true });
  assert.deepEqual(excel.slice(0, 3), new Uint8Array([0xef, 0xbb, 0xbf]));
  assert.notDeepEqual(normal.slice(0, 3), new Uint8Array([0xef, 0xbb, 0xbf]));
  assert.equal(parseCanonicalCsv(normal).hadBom, false);
  assert.equal(parseCanonicalCsv(excel).hadBom, true);
  assert.deepEqual(
    parseCanonicalCsv(excel).rows.map((row) => row.title),
    parseCanonicalCsv(normal).rows.map((row) => row.title),
  );
});

test("malformed and truncated CSV fail closed", () => {
  const valid = decoder.decode(exportCanonicalCsv([sampleRow()]));
  assert.throws(
    () => parseCanonicalCsv(encoder.encode(valid.replace(/\r\n/g, "\n"))),
    (error: unknown) => code(error, "malformed_csv"),
  );
  assert.throws(
    () => parseCanonicalCsv(encoder.encode(`${valid}"truncated`)),
    (error: unknown) => code(error, "malformed_csv"),
  );
  assert.throws(
    () => parseCanonicalCsv(encoder.encode(valid.replace(/^"record_uri"/, 'record"_uri'))),
    (error: unknown) => code(error, "malformed_csv"),
  );
  assert.throws(
    () => parseCanonicalCsv(encoder.encode('"record_uri"\r\n"only-one-cell"\r\n')),
    (error: unknown) => code(error, "invalid_csv_header"),
  );
});

test("raw spreadsheet formula payloads are rejected in every import cell", () => {
  const valid = decoder.decode(exportCanonicalCsv([sampleRow()]));
  const attacked = valid.replace(
    "'=literal formula-like description",
    '=HYPERLINK(""https://attacker.example"")',
  );
  assert.throws(
    () => parseCanonicalCsv(encoder.encode(attacked)),
    (error: unknown) => code(error, "formula_payload"),
  );
});

test("duplicate rows, variants, SKUs, and conflicting listing fields are rejected", () => {
  assert.throws(
    () => exportCanonicalCsv([sampleRow(), sampleRow()]),
    (error: unknown) => code(error, "duplicate_row"),
  );
  assert.throws(
    () =>
      exportCanonicalCsv([sampleRow(), sampleRow({ sku: "DIFFERENT-SKU", variantQuantity: 4 })]),
    (error: unknown) => code(error, "duplicate_variant_id"),
  );
  assert.throws(
    () =>
      exportCanonicalCsv([
        sampleRow(),
        sampleRow({
          listingId: "other",
          recordUri: sampleRow().recordUri.replace("boots_01", "other"),
          variantId: "other_variant",
        }),
      ]),
    (error: unknown) => code(error, "ambiguous_sku"),
  );
  assert.throws(
    () =>
      exportCanonicalCsv([
        sampleRow(),
        sampleRow({
          variantId: "black_l",
          sku: "BOOTS-BLK-L",
          title: "Conflicting title",
        }),
      ]),
    (error: unknown) => code(error, "conflicting_listing_fields"),
  );
});

test("record URI, seller, listing, revision, and explicit new-source identity must agree", () => {
  assert.throws(
    () => exportCanonicalCsv([sampleRow({ sellerPubky: "z".repeat(52) })]),
    (error: unknown) => code(error, "invalid_identity"),
  );
  assert.throws(
    () =>
      exportCanonicalCsv([
        sampleRow({
          recordUri: "",
          sellerPubky: "",
          listingId: "orphan-listing",
          sourceListingKey: "",
          recordRevision: 1,
        }),
      ]),
    (error: unknown) => code(error, "invalid_identity"),
  );
  assert.throws(
    () =>
      exportCanonicalCsv([
        sampleRow({
          recordUri: "",
          sellerPubky: "",
          listingId: "",
          sourceListingKey: "new-source",
          recordRevision: 1,
        }),
      ]),
    (error: unknown) => code(error, "invalid_identity"),
  );
});

test("explicit byte, row, cell, column, nesting, and working-set limits are typed", () => {
  const bytes = exportCanonicalCsv([sampleRow()]);
  for (const limits of [
    { maxBytes: bytes.byteLength - 1 },
    { maxCellBytes: 8 },
    { maxColumns: CANONICAL_CSV_COLUMNS.length - 1 },
    { maxNestingDepth: 1 },
    { maxWorkingSetBytes: bytes.byteLength - 1 },
  ]) {
    assert.throws(
      () => parseCanonicalCsv(bytes, limits),
      (error: unknown) => code(error, "limit_exceeded"),
    );
  }
  const twoRows = exportCanonicalCsv([
    sampleRow(),
    sampleRow({
      variantId: "black_l",
      sku: "BOOTS-BLK-L",
      options: { color: "black", size: "L" },
    }),
  ]);
  assert.throws(
    () => parseCanonicalCsv(twoRows, { maxRows: 1 }),
    (error: unknown) => code(error, "limit_exceeded"),
  );
});
