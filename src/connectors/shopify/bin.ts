#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { argv, exit, stdin, stdout } from "node:process";
import { homeserverSessionStoreFor, loadStoredHomeserverSession } from "../../cli/credentials.js";
import { canonicalPubky } from "../../cli/proof.js";
import { PubkyShopClient } from "../../client.js";
import { exportCanonicalCsv } from "../../csv.js";
import { PubkyShopError } from "../../errors.js";
import { type RecordedShopifyFixtures, recordedShopifyAdmin, shopifyAdminHttp } from "./admin.js";
import { applyShopifyWebhook, renderBridgeResult } from "./effects.js";
import { ShopifyBridgeError } from "./errors.js";
import { canonicalRowsFor, mapShopifyProductCsv } from "./map.js";
import { FileCatalog, FileReceiptLog } from "./receipts.js";
import { redact } from "./redact.js";
import { loadBridgeSecrets, secretValues } from "./secrets.js";
import { writerFromStoredHomeserverSession } from "./session-writer.js";

function flag(name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function writeOut(text: string, secrets: readonly string[]): void {
  stdout.write(redact(text, secrets));
}

async function mapCsv(): Promise<number> {
  const input = flag("--input");
  const seller = flag("--seller");
  const currency = flag("--currency");
  const exponentText = flag("--exponent");
  const output = flag("--output");
  const lossesPath = flag("--losses");
  if (
    input === undefined ||
    seller === undefined ||
    currency === undefined ||
    exponentText === undefined ||
    output === undefined ||
    lossesPath === undefined
  ) {
    writeOut("map-csv requires --input --seller --currency --exponent --output --losses\n", []);
    return 2;
  }
  const exponent = Number(exponentText);
  if (!Number.isInteger(exponent)) {
    writeOut("invalid exponent\n", []);
    return 2;
  }
  const mapped = mapShopifyProductCsv(await readFile(input), {
    sellerPubky: seller,
    currency,
    exponent,
  });
  const rows = mapped.products.flatMap((product) => canonicalRowsFor(product));
  await writeFile(output, rows.length === 0 ? "" : exportCanonicalCsv(rows));
  const losses = {
    headerLosses: mapped.headerLosses,
    products: mapped.products.map((product) => ({
      handle: product.handle,
      losses: product.losses,
    })),
    skipped: mapped.skipped,
  };
  await writeFile(lossesPath, `${JSON.stringify(losses)}\n`, { mode: 0o600 });
  writeOut(
    `${JSON.stringify({ products: mapped.products.length, skipped: mapped.skipped.length })}\n`,
    [],
  );
  return 0;
}

async function configSummary(): Promise<number> {
  const file = flag("--secrets");
  if (file === undefined) {
    writeOut("config-summary requires --secrets\n", []);
    return 2;
  }
  const secrets = await loadBridgeSecrets(file);
  const summary = {
    shopDomain: secrets.shopDomain,
    shopId: secrets.shopId,
    locationId: secrets.locationId,
    sellerPubky: secrets.sellerPubky,
    serviceUrl: secrets.serviceUrl,
    currency: secrets.currency,
    exponent: secrets.exponent,
  };
  writeOut(`${JSON.stringify(summary)}\n`, secretValues(secrets));
  return 0;
}

async function webhook(): Promise<number> {
  const secretsFile = flag("--secrets");
  const receiptsDir = flag("--receipts");
  const fixturesPath = flag("--admin-fixtures");
  if (argv.includes("--put-dir")) {
    writeOut("put-dir is not a homeserver\n", []);
    return 2;
  }
  if (secretsFile === undefined || receiptsDir === undefined) {
    writeOut("webhook requires --secrets --receipts\n", []);
    return 2;
  }
  const secrets = await loadBridgeSecrets(secretsFile);
  const stored = await loadStoredHomeserverSession(
    homeserverSessionStoreFor(process.env, process.cwd()),
    secrets.serviceUrl,
    process.env,
  );
  if (stored === undefined) {
    writeOut("homeserver_session_missing\n", secretValues(secrets));
    return 1;
  }
  if (canonicalPubky(stored.pubky) !== canonicalPubky(secrets.sellerPubky)) {
    writeOut("homeserver_seller_mismatch\n", secretValues(secrets));
    return 1;
  }
  const homeserver = await writerFromStoredHomeserverSession(stored);
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks);
  const headers = {
    hmac: flag("--hmac") ?? "",
    topic: flag("--topic") ?? "",
    shopDomain: flag("--shop-domain") ?? "",
    webhookId: flag("--webhook-id") ?? "",
    eventId: flag("--event-id") ?? "",
    triggeredAt: flag("--triggered-at") ?? "",
  };
  const admin =
    fixturesPath === undefined
      ? shopifyAdminHttp({ shopDomain: secrets.shopDomain, accessToken: secrets.adminAccessToken })
      : recordedShopifyAdmin(
          JSON.parse(await readFile(fixturesPath, "utf8")) as RecordedShopifyFixtures,
        );
  const result = await applyShopifyWebhook(raw, headers, {
    secrets,
    admin,
    pubky: new PubkyShopClient({ session: secrets.pubkySession, serviceUrl: secrets.serviceUrl }),
    homeserver,
    receipts: new FileReceiptLog(receiptsDir),
    catalog: new FileCatalog(receiptsDir),
    nowMs: Date.now(),
  });
  writeOut(renderBridgeResult(result, secrets), secretValues(secrets));
  return result.outcome === "rejected" ? 1 : 0;
}

const command = argv[2];
const run =
  command === "map-csv"
    ? mapCsv
    : command === "config-summary"
      ? configSummary
      : command === "webhook"
        ? webhook
        : async () => {
            writeOut("commands: map-csv, config-summary, webhook\n", []);
            return 2;
          };

run()
  .then((code) => {
    exit(code);
  })
  .catch((error: unknown) => {
    const code =
      error instanceof ShopifyBridgeError || error instanceof PubkyShopError
        ? error.message
        : "failed";
    writeOut(`${code}\n`, []);
    exit(1);
  });
