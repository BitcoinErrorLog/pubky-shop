import assert from "node:assert/strict";
import test from "node:test";

const live = process.env.PUBKY_SHOP_LIVE === "1";

test("live staging CAS spike and listings import", {
  skip: live ? false : "set PUBKY_SHOP_LIVE=1",
}, async () => {
  const { mintStagingInvite, createThrowawayStagingSignup, putListingRecord } = await import(
    "../src/cli/homeserver.js"
  );
  const { runCasSpike } = await import("../src/cli/cas.js");
  const { startMarketplaceLogin } = await import("../src/cli/login.js");
  const { createBffClient } = await import("../src/cli/bff.js");
  const { listingRecordText } = await import("../src/cli/seller.js");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { STAGING_BFF_ORIGIN, STAGING_SERVICE_ORIGIN } = await import("../src/cli/config.js");

  const token = await mintStagingInvite();
  const throwaway = await createThrowawayStagingSignup(token);
  try {
    const cas = await runCasSpike(throwaway, "cas_spike_01");
    const ifMatchDenied = cas.mismatched === 412 || cas.mismatched === 409;
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
    const started = await startMarketplaceLogin({
      config: {
        bffUrl: STAGING_BFF_ORIGIN,
        serviceUrl: STAGING_SERVICE_ORIGIN,
        configDir: path.join(root, "config"),
      },
      session: throwaway.session,
      fetch: globalThis.fetch,
    });
    const status = await createBffClient(STAGING_BFF_ORIGIN, globalThis.fetch).status(
      started.pending.state_id,
      started.pending.cli_token,
    );
    console.log(
      JSON.stringify({
        loginStatus: status.status,
        flowIdUuid: /^[0-9a-f-]{36}$/.test(started.pending.flow_id),
        authScheme: started.authorizationUrl.startsWith("pubkyauth://signin_grant"),
      }),
    );
    assert.equal(
      status.status === "awaiting" || status.status === "verifying",
      true,
      `login status=${status.status}`,
    );

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
  } finally {
    throwaway.dispose();
  }
});
