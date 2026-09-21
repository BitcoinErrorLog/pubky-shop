import assert from "node:assert/strict";

const sdk = await import("../dist/index.js");
const node = await import("../dist/node.js");

assert.equal(typeof sdk.PubkyShopClient, "function");
assert.equal(typeof sdk.exportCanonicalCsv, "function");
assert.equal(typeof sdk.parseCanonicalCsvStream, "function");
assert.equal(typeof sdk.encodeCanonicalJson, "function");
assert.equal(typeof sdk.parseBoundedJsonLossless, "function");
assert.equal(typeof sdk.listings, "undefined");
assert.equal(typeof sdk.PubkyShopClient.prototype.listings, "function");
assert.equal(typeof sdk.PubkyShopClient.prototype.syncMany, "function");
assert.equal(sdk.planImport, undefined);
assert.equal(sdk.FileManifestStore, undefined);
assert.equal(typeof node.FileManifestStore, "function");
assert.equal(typeof node.planImportStream, "function");
assert.equal(typeof node.planImport, "function");
