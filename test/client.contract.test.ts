import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PubkyShopClient, PubkyShopError, type ServiceAuthTokenSigner } from "../src/index.js";
import { SELLER_PUBKY } from "./helpers.js";

const fixtureUrl = new URL("test/fixtures/service/inventory.json", `file://${process.cwd()}/`);
const fixtureBytes = await readFile(fixtureUrl);
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
  cases: Record<
    string,
    {
      request: { body: unknown; method: string; path: string };
      response: { body: Record<string, unknown>; status: number };
    }
  >;
};

function materialize<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value)
      .replaceAll("<pubky:seller>", SELLER_PUBKY)
      .replaceAll("<uuid:1>", "00000000-0000-4000-8000-000000000001")
      .replaceAll("<uuid:2>", "00000000-0000-4000-8000-000000000002"),
  ) as T;
}

test("pinned Wave 1 artifact has exact production provenance hash", () => {
  assert.equal(
    createHash("sha256").update(fixtureBytes).digest("hex"),
    "eced83226ed825ff8158afc63f454669eb3b7bb0a056739dc1c7395282b2e5c1",
  );
});

test("captured projection response runs through the real client decoder", async () => {
  const capture = materialize(fixture.cases.projection_after);
  assert.ok(capture);
  const responseBody = {
    ...capture.response.body,
    future_envelope_field: { retained: true },
    stock: {
      ...(capture.response.body.stock as Record<string, unknown>),
      future_stock_field: "retained",
    },
  };
  const observed: {
    url: string | undefined;
    authorization: string | undefined;
    redirect: string | undefined;
  } = {
    url: undefined,
    authorization: undefined,
    redirect: undefined,
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    observed.url = String(input);
    observed.authorization = new Headers(init?.headers).get("authorization") ?? undefined;
    observed.redirect = init?.redirect;
    return new Response(JSON.stringify(responseBody), {
      status: capture.response.status,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new PubkyShopClient({
    session: "opaque-host-bearer",
    serviceUrl: "https://inventory.example/",
    fetch,
  });
  const result = await client.getInventoryProjection(`listing:${SELLER_PUBKY}_boots_01`);

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.stock.authority, "listing_total");
  assert.equal((result.value.future_envelope_field as Record<string, unknown>).retained, true);
  assert.equal(result.value.stock.future_stock_field, "retained");
  assert.equal(
    observed.url,
    `https://inventory.example/v1/inventory/listings/listing%3A${SELLER_PUBKY}_boots_01`,
  );
  assert.equal(observed.authorization, "Bearer opaque-host-bearer");
  assert.equal(observed.redirect, "manual");
});

test("captured adjustment request and response run through the real client", async () => {
  const capture = materialize(fixture.cases.adjust_success);
  assert.ok(capture);
  let posted: unknown;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    posted = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(capture.response.body), {
      status: capture.response.status,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new PubkyShopClient({
    session: "opaque-host-bearer",
    serviceUrl: "https://inventory.example",
    fetch,
  });
  const request = capture.request.body as Parameters<PubkyShopClient["adjustInventory"]>[0];
  const result = await client.adjustInventory(request);

  assert.equal(result.ok, true);
  assert.deepEqual(posted, request);
  if (result.ok) {
    assert.equal(result.value.result.stock.total, 5);
    assert.equal(result.value.result.server_revision, 2);
  }
});

test("bearer is origin-confined and redirects are never followed", async () => {
  for (const serviceUrl of [
    "http://inventory.example/",
    "https://user@inventory.example/",
    "https://inventory.example/path",
    "https://inventory.example/?query=yes",
    "https://inventory.example/#fragment",
  ]) {
    assert.throws(
      () =>
        new PubkyShopClient({
          session: "opaque-host-bearer",
          serviceUrl,
        }),
      (error: unknown) => error instanceof PubkyShopError && error.code === "invalid_service_url",
    );
  }

  const calls: string[] = [];
  const redirectModes: Array<RequestRedirect | undefined> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push(`${String(input)} ${new Headers(init?.headers).get("authorization")}`);
    redirectModes.push(init?.redirect);
    return new Response(
      JSON.stringify({
        schema_version: 1,
        ok: false,
        error: { code: "internal", message: "redirect" },
      }),
      {
        status: 302,
        headers: { location: "https://attacker.example/collect" },
      },
    );
  };
  const client = new PubkyShopClient({
    session: "secret-bearer",
    serviceUrl: "https://inventory.example/",
    fetch,
  });
  const result = await client.getInventoryProjection("listing:test");
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(redirectModes, ["manual"]);
  assert.match(calls[0] ?? "", /^https:\/\/inventory\.example\//);
});

test("401, server attacker text, and transport exceptions redact the bearer", async () => {
  const bearer = "bearer-that-must-never-escape";
  for (const response of [
    new Response(`attacker ${bearer}`, { status: 401 }),
    new Response(
      JSON.stringify({
        error: {
          code: `unknown_${bearer}`,
          message: `attacker controlled ${bearer}`,
        },
      }),
      { status: 500 },
    ),
  ]) {
    const client = new PubkyShopClient({
      session: bearer,
      serviceUrl: "https://inventory.example/",
      fetch: async () => response,
    });
    const result = await client.getInventoryProjection("listing:test");
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(bearer));
    if (!result.ok && response.status === 401) {
      assert.equal(result.error.code, "session_rejected");
    }
  }

  const client = new PubkyShopClient({
    session: bearer,
    serviceUrl: "https://inventory.example/",
    fetch: async () => {
      throw new Error(`transport reflected ${bearer}`);
    },
  });
  const result = await client.getInventoryProjection("listing:test");
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(bearer));
  if (!result.ok) {
    assert.equal(result.error.code, "transport_error");
  }
});

test("optional signer contract exposes postcard bytes and pubky, never key material", async () => {
  const signer: ServiceAuthTokenSigner = {
    async approveServiceAuthToken(request) {
      assert.equal(request.requiredGrant, "/pub/pubky.app/marketplace-service/v1/:rw");
      return {
        postcardBytes: new Uint8Array([1, 2, 3]),
        expectedPubky: SELLER_PUBKY,
      };
    },
  };
  const approval = await signer.approveServiceAuthToken({
    serviceOrigin: "https://inventory.example",
    requiredGrant: "/pub/pubky.app/marketplace-service/v1/:rw",
  });
  assert.deepEqual(Object.keys(approval).sort(), ["expectedPubky", "postcardBytes"]);
});

test("runtime request validation rejects unknown fields before transport", async () => {
  let requests = 0;
  const client = new PubkyShopClient({
    session: "opaque-host-bearer",
    serviceUrl: "https://inventory.example/",
    fetch: async () => {
      requests += 1;
      return new Response();
    },
  });
  const result = await client.adjustInventory({
    schema_version: 1,
    kind: "inventory.adjust",
    aggregate_id: `listing:${SELLER_PUBKY}_boots_01`,
    listing_id: "boots_01",
    expected_revision: 1,
    delta: 1,
    idempotency_key: "00000000-0000-4000-8000-000000000001",
    attacker_field: "must-not-send",
  } as Parameters<PubkyShopClient["adjustInventory"]>[0]);
  assert.equal(result.ok, false);
  assert.equal(requests, 0);
});

test("bearer validation rejects empty, whitespace, control, and oversized header input", () => {
  for (const session of [
    "",
    "contains space",
    "line\r\ninjection",
    `nul\u0000byte`,
    "x".repeat(4097),
  ]) {
    assert.throws(
      () =>
        new PubkyShopClient({
          session,
          serviceUrl: "https://inventory.example/",
        }),
      (error: unknown) => error instanceof PubkyShopError && error.code === "invalid_session",
    );
  }
});

test("declared and streamed response byte limits fail with safe observed values", async () => {
  const declared = new PubkyShopClient({
    session: "opaque-host-bearer",
    serviceUrl: "https://inventory.example/",
    maxResponseBytes: 1024,
    fetch: async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": "1025" },
      }),
  });
  const declaredResult = await declared.getInventoryProjection("listing:test");
  assert.equal(declaredResult.ok, false);
  if (!declaredResult.ok) {
    assert.equal(declaredResult.error.code, "response_limit_exceeded");
    assert.deepEqual(declaredResult.error.details, {
      limit: 1024,
      observed: 1025,
    });
  }

  const streamed = new PubkyShopClient({
    session: "opaque-host-bearer",
    serviceUrl: "https://inventory.example/",
    maxResponseBytes: 1024,
    fetch: async () => new Response("x".repeat(1025), { status: 200 }),
  });
  const streamedResult = await streamed.getInventoryProjection("listing:test");
  assert.equal(streamedResult.ok, false);
  if (!streamedResult.ok) {
    assert.equal(streamedResult.error.code, "response_limit_exceeded");
  }
});
