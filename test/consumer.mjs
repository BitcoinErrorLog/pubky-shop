import assert from "node:assert/strict";

const sdk = await import("../dist/index.js");

assert.equal(typeof sdk.PubkyShopClient, "function");
assert.equal(typeof sdk.exportCanonicalCsv, "function");
assert.equal(typeof sdk.parseCanonicalCsvStream, "function");
assert.equal(typeof sdk.FileManifestStore, "function");
assert.equal(typeof sdk.planImportStream, "function");
assert.equal(typeof sdk.encodeCanonicalJson, "function");
assert.equal(typeof sdk.parseBoundedJsonLossless, "function");
