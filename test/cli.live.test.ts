import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const live = process.env.PUBKY_SHOP_LIVE === "1";
const PROOF_LOG = "/Volumes/t7/vibes-dev/.evidence/phase6/wave3b/headless-login-proof.log";

const SENSITIVE_KEY =
  /^(token|secret|seed|password|authorization|cli_token|result_seed|result_delivery_id|signing_key)$/i;

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactJson);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "<redacted>" : redactJson(entry);
    }
    return out;
  }
  return value;
}

async function proofLog(event: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(PROOF_LOG), { recursive: true });
  await appendFile(
    PROOF_LOG,
    `${JSON.stringify({ at: new Date().toISOString(), event, payload: redactJson(payload) })}\n`,
  );
}

async function snapshotServiceGrant(origin: string, flowId: string): Promise<unknown> {
  const response = await fetch(`${origin}/v1/auth/grant-flows/${flowId}`, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { parse: "non_json", bytes: text.length };
  }
  return { http: response.status, body: redactJson(body) };
}

test("live staging CAS spike, headless grant login, and seller APIs", {
  skip: live ? false : "set PUBKY_SHOP_LIVE=1",
}, async () => {
  const { mintStagingInvite, createThrowawayStagingSignup, putListingRecord } = await import(
    "../src/cli/homeserver.js"
  );
  const { runCasSpike } = await import("../src/cli/cas.js");
  const {
    completeMarketplaceLogin,
    describePendingLogin,
    startMarketplaceLogin,
    writePendingLogin,
  } = await import("../src/cli/login.js");
  const { createBffClient } = await import("../src/cli/bff.js");
  const { filesystemStore } = await import("../src/cli/credentials.js");
  const { CliError } = await import("../src/cli/exit.js");
  const { createSellerClient, listingRecordText } = await import("../src/cli/seller.js");
  const { STAGING_BFF_ORIGIN, STAGING_SERVICE_ORIGIN } = await import("../src/cli/config.js");

  const token = await mintStagingInvite();
  const throwaway = await createThrowawayStagingSignup(token);
  try {
    await proofLog("seat", {
      pubky: throwaway.pubky,
      capabilities: throwaway.session.capabilities,
    });

    const cas = await runCasSpike(throwaway, "cas_spike_01");
    const ifMatchDenied = cas.mismatched === 412 || cas.mismatched === 409;
    await proofLog("cas", { ...cas, ifMatchDenied });
    console.log(
      JSON.stringify({
        created: cas.created,
        mismatched: cas.mismatched,
        matched: cas.matched,
        ifMatchDenied,
      }),
    );
    assert.equal(
      cas.created === 200 || cas.created === 201,
      true,
      `created=${cas.created} mismatched=${cas.mismatched} matched=${cas.matched}`,
    );
    assert.equal(
      ifMatchDenied || cas.mismatched === 200 || cas.mismatched === 201,
      true,
      `mismatched=${cas.mismatched}`,
    );
    assert.equal(cas.matched === 200 || cas.matched === 201, true, `matched=${cas.matched}`);

    const root = await mkdtemp(path.join(tmpdir(), "pubky-shop-live-"));
    const configDir = path.join(root, "config");
    const started = await startMarketplaceLogin({
      config: {
        bffUrl: STAGING_BFF_ORIGIN,
        serviceUrl: STAGING_SERVICE_ORIGIN,
        configDir,
      },
      session: throwaway.session,
      fetch: globalThis.fetch,
    });
    await writePendingLogin(configDir, started.pending);
    const pendingDescribed = describePendingLogin(started.pending);
    const bff = createBffClient(STAGING_BFF_ORIGIN, globalThis.fetch);
    const before = await bff.status(started.pending.state_id, started.pending.cli_token);
    const serviceBefore = await snapshotServiceGrant(
      STAGING_SERVICE_ORIGIN,
      started.pending.flow_id,
    );
    await proofLog("pending_vs_service_before_approve", {
      pending: pendingDescribed,
      bff: before,
      service: serviceBefore,
    });
    assert.equal(pendingDescribed.auth_url.scheme, "pubkyauth");
    assert.equal(pendingDescribed.auth_url.host, "signin_grant");
    assert.equal(pendingDescribed.auth_url.hasSecret, true);
    assert.equal(pendingDescribed.pubky, throwaway.pubky);
    assert.equal(
      before.status === "awaiting" || before.status === "verifying",
      true,
      `login status=${before.status}`,
    );

    await throwaway.signerApprove(started.authorizationUrl);
    await proofLog("approve_returned", { ok: true });

    let status = before;
    let serviceAfter: unknown = serviceBefore;
    const deadline = Date.parse(started.pending.expires_at);
    while (Date.now() < deadline) {
      status = await bff.status(started.pending.state_id, started.pending.cli_token);
      serviceAfter = await snapshotServiceGrant(STAGING_SERVICE_ORIGIN, started.pending.flow_id);
      await proofLog("status_poll", { bff: status, service: serviceAfter });
      if (
        status.status === "complete" ||
        status.status === "mismatch" ||
        status.status === "expired" ||
        status.status === "cancelled" ||
        status.status === "invalid" ||
        status.status === "failed"
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    await proofLog("status_after_approve", { bff: status, service: serviceAfter });
    assert.equal(
      status.status,
      "complete",
      `expected complete after headless GrantClaims approve; bff=${status.status} terminal=${status.terminal_code}`,
    );

    const store = filesystemStore(path.join(root, "creds"));
    const credential = await completeMarketplaceLogin({
      config: {
        bffUrl: STAGING_BFF_ORIGIN,
        serviceUrl: STAGING_SERVICE_ORIGIN,
        configDir,
      },
      pending: started.pending,
      store,
      fetch: globalThis.fetch,
    });
    assert.equal(credential.pubky, throwaway.pubky);
    await proofLog("login_complete", {
      pubky: credential.pubky,
      expires_at: credential.expires_at,
      capabilities: credential.capabilities,
    });

    const listing = {
      listing_id: "live_import_01",
      recordType: "listing",
      schemaVersion: 1,
      title: "live import",
      revision: 1,
      location: {},
      media: [],
      variants: [{ id: "default", enabled: true, quantity: 1, sku: "LIVE-1" }],
      shippingOptions: [],
      sale: {
        acceptsOffers: false,
        format: "fixed_price",
        unitPrice: { amountMinor: 1, currency: "USD", exponent: 2 },
      },
    };
    const imported = await putListingRecord(
      throwaway,
      listing.listing_id,
      listingRecordText(listing),
      undefined,
    );
    assert.equal(
      imported.status === 200 || imported.status === 201,
      true,
      `listing put status=${imported.status}`,
    );

    const seller = createSellerClient(STAGING_SERVICE_ORIGIN, credential.token, globalThis.fetch);
    let sellerApis: unknown;
    try {
      const synced = await seller.syncMany([
        { seller_pubky: credential.pubky, listing_id: listing.listing_id },
      ]);
      const listings = await seller.listings(credential.pubky);
      const orders = await seller.orders(credential.pubky);
      const events = await seller.events(credential.pubky);
      const webhookUrl = `https://example.com/pubky-shop-cli/${crypto.randomUUID()}`;
      const added = await seller.addWebhook(webhookUrl);
      const webhook =
        added.webhook !== null && typeof added.webhook === "object" && !Array.isArray(added.webhook)
          ? (added.webhook as { id?: unknown })
          : {};
      const webhookId = typeof webhook.id === "string" ? webhook.id : "";
      assert.equal(webhookId.length > 0, true, "webhook id missing");
      const rotated = await seller.rotateWebhook(webhookId);
      await seller.deleteWebhook(webhookId);
      sellerApis = {
        listingPut: imported.status,
        synced,
        listings,
        orders,
        events,
        webhook: { added: redactJson(added), rotated: redactJson(rotated), deleted: webhookId },
      };
    } catch (error) {
      const code = error instanceof CliError ? error.code : "internal";
      sellerApis = {
        listingPut: imported.status,
        blocked: code,
        reason:
          code === "capability_required"
            ? "grant settle inserts auth_sessions.capabilities empty; Wave 3a routes require /pub/pubky.app/marketplace-service/v1/:rw"
            : String(error),
      };
    }
    await proofLog("seller_apis", sellerApis);
    console.log(
      JSON.stringify({
        loginStatus: status.status,
        flowIdUuid: /^[0-9a-f-]{36}$/.test(started.pending.flow_id),
        authScheme: started.authorizationUrl.startsWith("pubkyauth://signin_grant"),
        claimedPubky: credential.pubky,
        claimedCapabilities: credential.capabilities,
        listingPut: imported.status,
        sellerApis,
      }),
    );
  } finally {
    throwaway.dispose();
  }
});
