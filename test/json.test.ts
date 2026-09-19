import assert from "node:assert/strict";
import test from "node:test";

import {
  PubkyShopError,
  canonicalJson,
  captureSignedRecord,
  decodeExportEnvelope,
  emitSignedRecord,
  encodeExportEnvelope,
  parseBoundedJson,
} from "../src/index.js";
import { SELLER_PUBKY } from "./helpers.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("RFC 8785 canonical JSON is key-stable UTF-8 with one LF", () => {
  const first = {
    z: 0,
    a: { "\u20ac": "Euro", "\r": "CR", one: 1e30, minusZero: -0 },
  };
  const second = {
    a: { minusZero: -0, one: 1e30, "\r": "CR", "\u20ac": "Euro" },
    z: 0,
  };
  const expected = '{"a":{"\\r":"CR","minusZero":0,"one":1e+30,"\u20ac":"Euro"},"z":0}';
  assert.equal(canonicalJson(first), expected);
  assert.equal(canonicalJson(second), expected);
});

test("bounded JSON rejects duplicate keys, invalid UTF-8, depth, and lone surrogates", () => {
  assert.throws(
    () => parseBoundedJson('{"same":1,"same":2}'),
    (error: unknown) => error instanceof PubkyShopError && error.code === "invalid_json",
  );
  assert.throws(
    () => parseBoundedJson(new Uint8Array([0xc3, 0x28])),
    (error: unknown) => error instanceof PubkyShopError && error.code === "invalid_json",
  );
  assert.throws(
    () => parseBoundedJson('{"a":{"b":{"c":1}}}', { maxDepth: 2 }),
    (error: unknown) => error instanceof PubkyShopError && error.code === "limit_exceeded",
  );
  assert.throws(
    () => parseBoundedJson("[0,0]", { maxNodes: 2 }),
    (error: unknown) => error instanceof PubkyShopError && error.code === "limit_exceeded",
  );
  assert.throws(
    () => parseBoundedJson('{"value":"12345"}', { maxStringBytes: 4 }),
    (error: unknown) => error instanceof PubkyShopError && error.code === "limit_exceeded",
  );
  assert.throws(
    () => parseBoundedJson("true", { maxBytes: 3 }),
    (error: unknown) => error instanceof PubkyShopError && error.code === "limit_exceeded",
  );
  assert.throws(
    () => canonicalJson({ bad: "\ud800" }),
    (error: unknown) => error instanceof PubkyShopError && error.code === "unsupported_json_value",
  );
});

test("bounded JSON scans dense numeric arrays without copying every remaining suffix", () => {
  const parsed = parseBoundedJson(`[${new Array(20_000).fill("0").join(",")}]`, {
    maxBytes: 50_000,
    maxNodes: 20_001,
  });
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 20_000);
});

test("export envelope preserves forward fields and keeps projection separate", () => {
  const input = encoder.encode(
    JSON.stringify({
      futureEnvelope: { enabled: true },
      orders: [],
      schemaVersion: 1,
      kind: "pubky-shop-export",
      cursor: null,
      sellerPubky: SELLER_PUBKY,
      drops: [],
      listings: [
        {
          recordUri: `pubky://${SELLER_PUBKY}/pub/pubky.app/marketplace/v1/listings/boots_01`,
          futureListing: 7,
          record: {
            schemaVersion: 1,
            recordType: "listing",
            listingId: "boots_01",
          },
          projection: {
            schema_version: 1,
            stock: { authority: "listing_total", total: 3 },
            futureProjection: "retained",
          },
        },
      ],
    }),
  );
  const decoded = decodeExportEnvelope(input);
  const encoded = encodeExportEnvelope(decoded);
  assert.equal(encoded.at(-1), 0x0a);
  assert.notEqual(encoded.at(-2), 0x0a);
  const roundTrip = decodeExportEnvelope(encoded);
  assert.equal((roundTrip.futureEnvelope as Record<string, unknown>).enabled, true);
  const roundTripListing = roundTrip.listings[0];
  assert.ok(roundTripListing);
  assert.equal(roundTripListing.futureListing, 7);
  assert.equal(
    (roundTripListing.projection as Record<string, unknown>).futureProjection,
    "retained",
  );

  const mixed = structuredClone(roundTrip);
  const listing = mixed.listings[0];
  assert.ok(listing);
  (listing.record as Record<string, unknown>).stock = { available: 1 };
  assert.throws(
    () => encodeExportEnvelope(mixed),
    (error: unknown) => error instanceof PubkyShopError && error.code === "validation_failed",
  );
});

test("unchanged signed records remain byte-identical with a SHA-256 sidecar", () => {
  const raw = encoder.encode(
    '{\r\n  "schemaVersion": 1,\r\n  "recordType": "listing",\r\n  "listingId": "boots_01"\r\n}',
  );
  const capture = captureSignedRecord(raw);
  const emitted = emitSignedRecord(capture);
  assert.equal(emitted.ok, true);
  if (emitted.ok) {
    assert.deepEqual(emitted.value, raw);
  }
  assert.match(capture.sha256, /^[0-9a-f]{64}$/);

  capture.rawBytes[0] = 0x00;
  const tampered = emitSignedRecord(capture);
  assert.equal(tampered.ok, false);
  if (!tampered.ok) {
    assert.equal(tampered.error.code, "validation_failed");
  }
});

test("changed signed records require validator injection and deterministic serialization", () => {
  const raw = encoder.encode('{"schemaVersion":1,"recordType":"listing","listingId":"boots_01"}');
  const capture = captureSignedRecord(raw);
  const changed = {
    listingId: "boots_01",
    recordType: "listing",
    schemaVersion: 1,
    title: "Changed",
  };
  const withoutValidator = emitSignedRecord(capture, changed);
  assert.equal(withoutValidator.ok, false);
  if (!withoutValidator.ok) {
    assert.equal(withoutValidator.error.code, "unsupported_record_version_or_field");
  }

  const emitted = emitSignedRecord(
    capture,
    changed,
    (record) =>
      record.schemaVersion === 1 &&
      record.recordType === "listing" &&
      typeof record.listingId === "string",
  );
  assert.equal(emitted.ok, true);
  if (emitted.ok) {
    assert.equal(
      decoder.decode(emitted.value),
      '{"listingId":"boots_01","recordType":"listing","schemaVersion":1,"title":"Changed"}\n',
    );
  }

  const mixed = emitSignedRecord(capture, { ...changed, server_revision: 9 }, () => true);
  assert.equal(mixed.ok, false);
  if (!mixed.ok) {
    assert.equal(mixed.error.code, "validation_failed");
  }
});
