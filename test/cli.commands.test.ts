import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { filesystemStore } from "../src/cli/credentials.js";
import { runCli } from "../src/cli/main.js";
import { sampleRow } from "./helpers.js";
import { exportCanonicalCsv } from "../src/csv.js";

const ORIGIN = "https://marketplace-service-production.up.railway.app";
const BFF = "https://pubky-marketplace-staging.vercel.app";

test("listings export uses the stored bearer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pubky-shop-cli-"));
  const store = filesystemStore(path.join(root, "creds"));
  await store.put(ORIGIN, {
    capabilities: "",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    pubky: "y".repeat(52),
    session_id: "",
    token: "stored-bearer",
  });
  let authorization: string | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization") ?? undefined;
    return new Response(JSON.stringify({ kind: "seller_listing_export", listings: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const stdout: string[] = [];
  const code = await runCli(
    ["listings", "export", "--json", "--bff-url", BFF, "--service-url", ORIGIN],
    {
      env: {
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, "config"),
        PUBKY_SHOP_CREDENTIAL_DIR: path.join(root, "creds"),
      },
      cwd: root,
      stdout: {
        write(chunk) {
          stdout.push(String(chunk));
          return true;
        },
      },
      stderr: {
        write() {
          return true;
        },
      },
      fetch: fetchImpl,
      platform: "linux",
    },
  );
  assert.equal(code, 0);
  assert.equal(authorization, "Bearer stored-bearer");
});

test("listings import PUTs then sync-many", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pubky-shop-cli-"));
  const store = filesystemStore(path.join(root, "creds"));
  await store.put(ORIGIN, {
    capabilities: "",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    pubky: sampleRow().sellerPubky,
    session_id: "",
    token: "stored-bearer",
  });
  const csvPath = path.join(root, "listings.csv");
  await writeFile(csvPath, exportCanonicalCsv([sampleRow()]));
  const puts: string[] = [];
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ results: [{ status: 200 }] }), {
      status: 207,
      headers: { "content-type": "application/json" },
    });
  };
  const code = await runCli(
    ["listings", "import", "--input", csvPath, "--json", "--bff-url", BFF, "--service-url", ORIGIN],
    {
      env: {
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, "config"),
        PUBKY_SHOP_CREDENTIAL_DIR: path.join(root, "creds"),
      },
      cwd: root,
      stdout: {
        write() {
          return true;
        },
      },
      stderr: {
        write() {
          return true;
        },
      },
      fetch: fetchImpl,
      platform: "linux",
      putListing: async (listingId, body) => {
        puts.push(`${listingId}:${body}`);
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(puts.length, 1);
  assert.equal(
    urls.some((url) => url.includes("/v1/listings/sync-many")),
    true,
  );
});

test("auth status without a bearer is exit 2", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pubky-shop-cli-"));
  const code = await runCli(
    ["auth", "status", "--json", "--bff-url", BFF, "--service-url", ORIGIN],
    {
      env: {
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, "config"),
        PUBKY_SHOP_CREDENTIAL_DIR: path.join(root, "creds"),
      },
      cwd: root,
      stdout: {
        write() {
          return true;
        },
      },
      stderr: {
        write() {
          return true;
        },
      },
      fetch: globalThis.fetch,
      platform: "linux",
    },
  );
  assert.equal(code, 2);
});
