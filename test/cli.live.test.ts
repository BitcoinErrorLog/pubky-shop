import assert from "node:assert/strict";
import test from "node:test";

const live = process.env.PUBKY_SHOP_LIVE === "1";

test("live staging CAS spike and listings import", {
  skip: live ? false : "set PUBKY_SHOP_LIVE=1",
}, async () => {
  const { mintStagingInvite, createThrowawayStagingSignup } = await import(
    "../src/cli/homeserver.js"
  );
  const { runCasSpike } = await import("../src/cli/cas.js");
  const { startMarketplaceLogin, completeMarketplaceLogin, writePendingLogin } = await import(
    "../src/cli/login.js"
  );
  const { filesystemStore } = await import("../src/cli/credentials.js");
  const { runCli } = await import("../src/cli/main.js");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { STAGING_BFF_ORIGIN, STAGING_SERVICE_ORIGIN } = await import("../src/cli/config.js");

  const token = await mintStagingInvite();
  const throwaway = await createThrowawayStagingSignup(token);
  try {
    const cas = await runCasSpike(throwaway, "cas_spike_01");
    assert.equal(cas.created === 200 || cas.created === 201, true);
    assert.equal(cas.mismatched === 412 || cas.mismatched === 409 || cas.mismatched >= 400, true);
    assert.equal(cas.matched === 200 || cas.matched === 201, true);

    const root = await mkdtemp(path.join(tmpdir(), "pubky-shop-live-"));
    const store = filesystemStore(path.join(root, "creds"));
    const started = await startMarketplaceLogin({
      config: {
        bffUrl: STAGING_BFF_ORIGIN,
        serviceUrl: STAGING_SERVICE_ORIGIN,
        configDir: path.join(root, "config"),
      },
      session: throwaway.session,
      fetch: globalThis.fetch,
    });
    await throwaway.signerApprove(started.authorizationUrl);
    await writePendingLogin(path.join(root, "config"), started.pending);
    const credential = await completeMarketplaceLogin({
      config: {
        bffUrl: STAGING_BFF_ORIGIN,
        serviceUrl: STAGING_SERVICE_ORIGIN,
        configDir: path.join(root, "config"),
      },
      pending: started.pending,
      store,
      fetch: globalThis.fetch,
      sleep: async () => undefined,
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
    const file = path.join(root, "listing.json");
    await writeFile(file, JSON.stringify(listing));
    const code = await runCli(
      [
        "listings",
        "import",
        "--input",
        file,
        "--json",
        "--bff-url",
        STAGING_BFF_ORIGIN,
        "--service-url",
        STAGING_SERVICE_ORIGIN,
      ],
      {
        env: {
          HOME: root,
          XDG_CONFIG_HOME: path.join(root, "config"),
          PUBKY_SHOP_CREDENTIAL_DIR: path.join(root, "creds"),
          PUBKY_SHOP_PUBKY: credential.pubky,
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
        putListing: async (listingId, body) => {
          const { putListingRecord } = await import("../src/cli/homeserver.js");
          const response = await putListingRecord(throwaway, listingId, body, undefined);
          if (response.status >= 400) {
            throw new Error(`listing put failed: ${response.status}`);
          }
        },
      },
    );
    assert.equal(code, 0);
  } finally {
    throwaway.dispose();
  }
});
