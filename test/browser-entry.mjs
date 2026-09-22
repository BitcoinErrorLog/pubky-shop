import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const distRoot = fileURLToPath(new URL("../dist/", import.meta.url));
const browserRoot = fileURLToPath(new URL("../dist/browser/", import.meta.url));
const specifier = /['"](\.[^'"]+)['"]/g;

function resolveImport(fromFile, spec) {
  const resolved = new URL(spec, pathToFileURL(fromFile)).pathname;
  return resolved.endsWith(".js") ? resolved : `${resolved}.js`;
}

async function walkGraph(entry) {
  const pending = [entry];
  const seen = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(specifier)) {
      const spec = match[1];
      if (spec === undefined || !spec.startsWith(".")) {
        continue;
      }
      pending.push(resolveImport(file, spec));
    }
  }
  return seen;
}

const graph = await walkGraph(join(distRoot, "index.js"));
await rm(browserRoot, { recursive: true, force: true });
await mkdir(browserRoot, { recursive: true });

let nodeSpecifiers = 0;
let pubkySpecifiers = 0;
for (const file of graph) {
  const source = await readFile(file, "utf8");
  if (source.includes("node:") || source.includes("@synonymdev/pubky")) {
    if (source.includes("node:")) {
      nodeSpecifiers += 1;
      console.error("node: specifier in", file);
    }
    if (source.includes("@synonymdev/pubky")) {
      pubkySpecifiers += 1;
      console.error("pubky import in", file);
    }
  }
  const rel = file.startsWith(distRoot) ? file.slice(distRoot.length) : file;
  const out = join(browserRoot, rel);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, source);
}

assert.equal(nodeSpecifiers, 0, "browser graph must not contain node: specifiers");
assert.equal(pubkySpecifiers, 0, "browser graph must not import @synonymdev/pubky");

const grep = spawnSync("grep", ["-r", "node:", browserRoot], { encoding: "utf8" });
assert.equal(grep.status, 1, "grep -r node: dist/browser must have zero hits");
assert.equal(grep.stdout, "");
await rm(browserRoot, { recursive: true, force: true });

const sdk = await import("../dist/index.js");
assert.equal(typeof sdk.PubkyShopClient, "function");
assert.equal(typeof sdk.planImport, "function");
assert.equal(typeof sdk.planImportStream, "function");
assert.equal(typeof sdk.MemoryManifestStore, "function");
assert.equal(typeof sdk.chunkSyncManyListings, "function");
assert.equal(typeof sdk.classifySyncManyItem, "function");
assert.equal(typeof sdk.resumeTasks, "function");
assert.equal(typeof sdk.browserFileSource, "function");
assert.equal(sdk.FileManifestStore, undefined);
assert.equal(typeof sdk.sha256Hex, "function");

const payload = new TextEncoder().encode("abc");
const hex = sdk.sha256Hex(payload);
assert.equal(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
assert.equal(await sdk.sha256HexSubtle(payload), hex);

const client = new sdk.PubkyShopClient({
  session: "opaque-host-bearer",
  serviceUrl: "https://inventory.example/",
  fetch: async () =>
    new Response(
      '{"schema_version":1,"kind":"inventory_projection","aggregate_id":"listing:test","seller_pubky":"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy","listing_id":"test","server_revision":1,"stock":{"authority":"listing_total","available":1,"reserved":0,"sold":0,"total":1}}',
      { status: 200 },
    ),
});
const projected = await client.getInventoryProjection("listing:test");
assert.equal(projected.ok, true);
