import assert from "node:assert/strict";
import test from "node:test";

import {
  SHIPPED_BFF_ORIGIN,
  SHIPPED_SERVICE_ORIGIN,
  parseArgs,
  resolveConfig,
  validateHttpsOrigin,
} from "../src/cli/config.js";
import { CliError } from "../src/cli/exit.js";

test("parseArgs reads command and flags", () => {
  const parsed = parseArgs([
    "auth",
    "login",
    "--json",
    "--stop-after-qr",
    "--bff-url",
    "https://pubky-marketplace-staging.vercel.app",
    "--service-url=https://marketplace-service-production.up.railway.app",
  ]);
  assert.deepEqual(parsed.command, ["auth", "login"]);
  assert.equal(parsed.flags.json, true);
  assert.equal(parsed.flags.stopAfterQr, true);
  assert.equal(parsed.flags.bffUrl, "https://pubky-marketplace-staging.vercel.app");
  assert.equal(parsed.flags.serviceUrl, "https://marketplace-service-production.up.railway.app");
});

test("shipped defaults are production origins", async () => {
  const config = await resolveConfig(
    {
      json: false,
      printUrl: false,
      stopAfterQr: false,
      complete: false,
      forceLocal: false,
      help: false,
      version: false,
    },
    { HOME: "/tmp/pubky-shop-test-home" },
  );
  assert.equal(config.bffUrl, SHIPPED_BFF_ORIGIN);
  assert.equal(config.serviceUrl, SHIPPED_SERVICE_ORIGIN);
});

test("flags beat env and file", async () => {
  const config = await resolveConfig(
    {
      json: false,
      printUrl: false,
      stopAfterQr: false,
      complete: false,
      forceLocal: false,
      help: false,
      version: false,
      bffUrl: "https://pubky-marketplace-staging.vercel.app",
      serviceUrl: "https://marketplace-service-production.up.railway.app",
    },
    {
      HOME: "/tmp/pubky-shop-test-home",
      PUBKY_SHOP_BFF_URL: "https://shop.pubky.app",
      PUBKY_SHOP_SERVICE_URL: "https://marketplace-service-production-ce23.up.railway.app",
    },
  );
  assert.equal(config.bffUrl, "https://pubky-marketplace-staging.vercel.app");
  assert.equal(config.serviceUrl, "https://marketplace-service-production.up.railway.app");
});

test("rejects non-HTTPS service urls", () => {
  assert.throws(() => validateHttpsOrigin("http://example.com", "service_url"), CliError);
  assert.throws(
    () => validateHttpsOrigin("https://user:pass@example.com/", "service_url"),
    CliError,
  );
  assert.throws(() => validateHttpsOrigin("https://example.com/path", "service_url"), CliError);
});
