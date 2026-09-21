import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { filesystemStore } from "../src/cli/credentials.js";
import { decodeBase64Url32, encodeBase64Url, sha256Bytes } from "../src/cli/encoding.js";
import { HOMESERVER_CAPABILITY } from "../src/cli/config.js";
import { runCli } from "../src/cli/main.js";
import { proofDocumentText } from "../src/cli/proof.js";
import type { HomeserverSession } from "../src/cli/proof.js";

const PUBKY = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";
const FLOW_ID = "018f4f36-8d4c-7a7b-a2dd-d5ef304068ec";
const STATE_ID = "018f4f36-7a61-7d4e-8f22-3e31ed45d2af";
const CHALLENGE_ID = "018f4f36-7a61-7d4e-8f22-3e31ed45d2af";

function session(): HomeserverSession & { puts: string[]; deletes: string[] } {
  const puts: string[] = [];
  const deletes: string[] = [];
  return {
    pubky: PUBKY,
    capabilities: [HOMESERVER_CAPABILITY],
    puts,
    deletes,
    async putText(path, body) {
      puts.push(`${path}:${body}`);
    },
    async delete(path) {
      deletes.push(path);
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("encoding round-trips 32 bytes", () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
  const encoded = encodeBase64Url(bytes);
  assert.equal(decodeBase64Url32(encoded).length, 32);
  assert.equal(sha256Bytes(bytes).length, 32);
});

test("proof document is JCS with hashed nonce", () => {
  const nonce = Uint8Array.from({ length: 32 }, () => 9);
  const text = proofDocumentText({
    aud: "https://pubky-marketplace-staging.vercel.app",
    challengeId: CHALLENGE_ID,
    exp: 100,
    iat: 40,
    nonce,
    pubky: PUBKY,
    resultCpk: PUBKY,
    resultDeliveryId: encodeBase64Url(nonce),
  });
  assert.equal(text.startsWith("{"), true);
  assert.equal(text.includes("nonce_hash"), true);
  assert.equal(
    text.includes(encodeBase64Url(nonce)) === false || text.includes("nonce_hash"),
    true,
  );
});

test("auth login --stop-after-qr writes pending login and does not claim", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pubky-shop-cli-"));
  const hs = session();
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/api/cli/grant-challenges") && init?.method === "POST") {
      return jsonResponse(201, {
        challenge_id: CHALLENGE_ID,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        nonce: encodeBase64Url(Uint8Array.from({ length: 32 }, () => 9)),
        proof_uri: `pubky://${PUBKY}/pub/pubky.app/marketplace/v1/cli-grant-proofs/${CHALLENGE_ID}`,
      });
    }
    if (url.includes("/verify")) {
      return jsonResponse(201, {
        authorization_url: "pubkyauth://signin_grant?x=1",
        cli_token: `${STATE_ID}.${encodeBase64Url(Uint8Array.from({ length: 32 }, () => 7))}`,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        flow_id: FLOW_ID,
        state_id: STATE_ID,
        status: "awaiting",
      });
    }
    return jsonResponse(500, { error: { code: "unexpected" } });
  };
  const stdout: string[] = [];
  const code = await runCli(
    [
      "auth",
      "login",
      "--json",
      "--stop-after-qr",
      "--print-url",
      "--bff-url",
      "https://pubky-marketplace-staging.vercel.app",
      "--service-url",
      "https://marketplace-service-production.up.railway.app",
    ],
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
      homeserverSession: hs,
    },
  );
  assert.equal(code, 0);
  const payload = JSON.parse(stdout.join("")) as {
    ok: boolean;
    data: { status: string; flow_id?: string };
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.data.status, "awaiting_scan");
  assert.equal(
    calls.some((entry) => entry.includes("/claim")),
    false,
  );
  assert.equal(hs.puts.length, 1);
  const pending = await readFile(
    path.join(root, "config", "pubky-shop", "pending-login.json"),
    "utf8",
  );
  assert.equal(JSON.parse(pending).flow_id, FLOW_ID);
});

test("auth login --complete tickets and claims after status complete", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pubky-shop-cli-"));
  const store = filesystemStore(path.join(root, "creds"));
  const configDir = path.join(root, "config", "pubky-shop");
  const { mkdir, writeFile, chmod } = await import("node:fs/promises");
  await mkdir(configDir, { recursive: true });
  const pending = {
    version: 1,
    bff_url: "https://pubky-marketplace-staging.vercel.app",
    service_url: "https://marketplace-service-production.up.railway.app",
    pubky: PUBKY,
    state_id: STATE_ID,
    cli_token: `${STATE_ID}.${encodeBase64Url(Uint8Array.from({ length: 32 }, () => 7))}`,
    flow_id: FLOW_ID,
    result_seed: encodeBase64Url(Uint8Array.from({ length: 32 }, () => 3)),
    result_delivery_id: encodeBase64Url(Uint8Array.from({ length: 32 }, () => 4)),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    authorization_url: "pubkyauth://signin_grant?x=1",
    proof_path: `/pub/pubky.app/marketplace/v1/cli-grant-proofs/${CHALLENGE_ID}`,
  };
  await writeFile(path.join(configDir, "pending-login.json"), JSON.stringify(pending), {
    mode: 0o600,
  });
  await chmod(path.join(configDir, "pending-login.json"), 0o600);
  let statusCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/status")) {
      statusCalls += 1;
      return jsonResponse(200, {
        expires_at: pending.expires_at,
        flow_id: FLOW_ID,
        state_id: STATE_ID,
        status: "complete",
        terminal_code: null,
      });
    }
    if (url.endsWith("/result-nonces")) {
      return jsonResponse(201, {
        expires_at: pending.expires_at,
        nonce: encodeBase64Url(Uint8Array.from({ length: 32 }, () => 8)),
        nonce_id: "018f4f36-8d4c-7a7b-a2dd-d5ef304068ed",
      });
    }
    if (url.endsWith("/result-ticket")) {
      assert.equal(init?.method, "POST");
      return jsonResponse(200, { expires_at: pending.expires_at });
    }
    if (url.endsWith("/claim")) {
      return jsonResponse(200, {
        capabilities: "",
        expires_at: pending.expires_at,
        pubky: PUBKY,
        token: "bearer-token",
      });
    }
    return jsonResponse(500, { error: { code: "unexpected" } });
  };
  const stdout: string[] = [];
  const code = await runCli(
    [
      "auth",
      "login",
      "--json",
      "--complete",
      "--bff-url",
      "https://pubky-marketplace-staging.vercel.app",
      "--service-url",
      "https://marketplace-service-production.up.railway.app",
    ],
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
  assert.equal(statusCalls, 1);
  const stored = await store.get("https://marketplace-service-production.up.railway.app", PUBKY);
  assert.equal(stored?.token, "bearer-token");
  const payload = JSON.parse(stdout.join("")) as { data: { pubky: string } };
  assert.equal(payload.data.pubky, PUBKY);
});

test("auth login without a homeserver session is exit 2", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pubky-shop-cli-"));
  const code = await runCli(
    [
      "auth",
      "login",
      "--json",
      "--bff-url",
      "https://pubky-marketplace-staging.vercel.app",
      "--service-url",
      "https://marketplace-service-production.up.railway.app",
    ],
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
