import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PubkyShopClient,
  PubkyShopError,
  SYNC_MANY_LIMIT,
  type ServiceAuthTokenSigner,
} from "../src/index.js";
import { SELLER_PUBKY } from "./helpers.js";

const fixtureUrl = new URL("../../test/fixtures/service/inventory.json", import.meta.url);
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
  const capturedRequest = capture.request.body as Record<string, unknown>;
  const request = {
    ...capturedRequest,
    expected_revision: BigInt(capturedRequest.expected_revision as number),
    delta: BigInt(capturedRequest.delta as number),
  } as Parameters<PubkyShopClient["adjustInventory"]>[0];
  const result = await client.adjustInventory(request);

  assert.equal(result.ok, true);
  assert.deepEqual(posted, capturedRequest);
  if (result.ok) {
    assert.equal(result.value.result.stock.total, 5n);
    assert.equal(result.value.result.server_revision, 2n);
  }
});

test("service int64 boundaries decode losslessly for projections and adjustments", async () => {
  for (const token of ["9007199254740991", "9007199254740992", "9223372036854775807"]) {
    const projection = new PubkyShopClient({
      session: "opaque-host-bearer",
      serviceUrl: "https://inventory.example/",
      fetch: async () =>
        new Response(
          `{"aggregate_id":"listing:test","future_counter":${token},"kind":"inventory_projection","listing_id":"test","schema_version":1,"seller_pubky":"${SELLER_PUBKY}","server_revision":${token},"stock":{"authority":"listing_total","available":${token},"reserved":0,"sold":0,"total":${token}}}`,
          { status: 200 },
        ),
    });
    const projected = await projection.getInventoryProjection("listing:test");
    assert.equal(projected.ok, true);
    if (projected.ok) {
      assert.equal(projected.value.server_revision, BigInt(token));
      assert.equal(projected.value.stock.total, BigInt(token));
      assert.equal(projected.value.future_counter, BigInt(token));
    }

    const adjustment = new PubkyShopClient({
      session: "opaque-host-bearer",
      serviceUrl: "https://inventory.example/",
      fetch: async () =>
        new Response(
          `{"ok":true,"result":{"aggregate_id":"listing:test","event_id":"00000000-0000-4000-8000-000000000002","listing_id":"test","server_revision":${token},"stock":{"authority":"listing_total","available":${token},"reserved":0,"sold":0,"total":${token}}},"schema_version":1}`,
          { status: 200 },
        ),
    });
    const adjusted = await adjustment.adjustInventory({
      schema_version: 1,
      kind: "inventory.adjust",
      aggregate_id: "listing:test",
      listing_id: "test",
      expected_revision: 1n,
      delta: 1n,
      idempotency_key: "00000000-0000-4000-8000-000000000001",
    });
    assert.equal(adjusted.ok, true);
    if (adjusted.ok) {
      assert.equal(adjusted.value.result.server_revision, BigInt(token));
      assert.equal(adjusted.value.result.stock.total, BigInt(token));
    }
  }
});

test("service int64 overflow and non-integer tokens fail closed", async () => {
  for (const token of ["9223372036854775808", "1.5"]) {
    const client = new PubkyShopClient({
      session: "opaque-host-bearer",
      serviceUrl: "https://inventory.example/",
      fetch: async () =>
        new Response(
          `{"aggregate_id":"listing:test","kind":"inventory_projection","listing_id":"test","schema_version":1,"seller_pubky":"${SELLER_PUBKY}","server_revision":${token},"stock":{"authority":"listing_total","available":1,"reserved":0,"sold":0,"total":1}}`,
          { status: 200 },
        ),
    });
    const result = await client.getInventoryProjection("listing:test");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "invalid_response");
    }
  }
});

test("int64 request fields serialize as exact JSON number tokens", async () => {
  let posted = "";
  const client = new PubkyShopClient({
    session: "opaque-host-bearer",
    serviceUrl: "https://inventory.example/",
    fetch: async (_input, init) => {
      posted = String(init?.body);
      return new Response(
        '{"ok":true,"result":{"aggregate_id":"listing:test","event_id":"00000000-0000-4000-8000-000000000002","listing_id":"test","server_revision":1,"stock":{"authority":"listing_total","available":1,"reserved":0,"sold":0,"total":1}},"schema_version":1}',
        { status: 200 },
      );
    },
  });
  const result = await client.adjustInventory({
    schema_version: 1,
    kind: "inventory.adjust",
    aggregate_id: "listing:test",
    listing_id: "test",
    expected_revision: 9_223_372_036_854_775_807n,
    delta: -1n,
    idempotency_key: "00000000-0000-4000-8000-000000000001",
  });
  assert.equal(result.ok, true);
  assert.match(posted, /"expected_revision":9223372036854775807/);
  assert.doesNotMatch(posted, /"expected_revision":"9223372036854775807"/);
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
    expected_revision: 1n,
    delta: 1n,
    idempotency_key: "00000000-0000-4000-8000-000000000001",
    attacker_field: "must-not-send",
  } as unknown as Parameters<PubkyShopClient["adjustInventory"]>[0]);
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

test("Wave 3a listings pages attach bearer and preserve unknown fields", async () => {
  const observed: { url?: string; authorization?: string | undefined } = {};
  const client = new PubkyShopClient({
    session: "opaque-host-bearer",
    serviceUrl: "https://inventory.example/",
    fetch: async (input, init) => {
      observed.url = String(input);
      observed.authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      return new Response(
        JSON.stringify({
          listings: [{ listing_id: "boots_01", future_field: true }],
          cursor: "next",
        }),
        { status: 200 },
      );
    },
  });
  const result = await client.listings(SELLER_PUBKY, { cursor: "abc", limit: 100 });
  assert.equal(result.ok, true);
  assert.equal(
    observed.url,
    `https://inventory.example/v1/sellers/${SELLER_PUBKY}/listings?limit=100&cursor=abc`,
  );
  assert.equal(observed.authorization, "Bearer opaque-host-bearer");
  if (result.ok) {
    assert.equal(result.value.cursor, "next");
  }
});

test("syncMany chunks 101 ids into 100+1 MULTI_STATUS envelopes", async () => {
  const bodies: unknown[] = [];
  const client = new PubkyShopClient({
    session: "opaque-host-bearer",
    serviceUrl: "https://inventory.example/",
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const posted = bodies[bodies.length - 1] as { listings: { listing_id: string }[] };
      return new Response(
        JSON.stringify({
          schema_version: 1,
          kind: "listing.sync_many",
          results: posted.listings.map((item) => ({
            listing_id: item.listing_id,
            status: 200,
          })),
        }),
        { status: 207 },
      );
    },
  });
  const listings = Array.from({ length: 101 }, (_, index) => ({
    seller_pubky: SELLER_PUBKY,
    listing_id: `item_${index + 1}`,
  }));
  const result = await client.syncMany(listings);
  assert.equal(result.ok, true);
  assert.equal(bodies.length, 2);
  assert.equal((bodies[0] as { listings: unknown[] }).listings.length, SYNC_MANY_LIMIT);
  assert.equal((bodies[1] as { listings: unknown[] }).listings.length, 1);
  if (result.ok) {
    assert.equal(result.value.results.length, 101);
    assert.equal(result.value.kind, "listing.sync_many");
  }
});

test("inventory 403 capability_required and 409 revision_conflict stay typed service errors", async () => {
  const forbidden = new PubkyShopClient({
    session: "opaque-host-bearer",
    serviceUrl: "https://inventory.example/",
    fetch: async () =>
      new Response(JSON.stringify({ error: { code: "capability_required" } }), { status: 403 }),
  });
  const missing = await forbidden.getInventoryProjection("listing:test");
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.error.code, "service_error");
    assert.equal(missing.error.details.serviceCode, "capability_required");
    assert.equal(missing.error.details.status, 403);
  }

  const conflict = new PubkyShopClient({
    session: "opaque-host-bearer",
    serviceUrl: "https://inventory.example/",
    fetch: async () =>
      new Response(JSON.stringify({ error: { code: "revision_conflict" } }), { status: 409 }),
  });
  const stale = await conflict.adjustInventory({
    schema_version: 1,
    kind: "inventory.adjust",
    aggregate_id: "listing:test",
    listing_id: "test",
    expected_revision: 1n,
    delta: 1n,
    idempotency_key: "00000000-0000-4000-8000-000000000001",
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.error.details.serviceCode, "revision_conflict");
    assert.equal(stale.error.details.status, 409);
  }
});

test("createSession posts octet-stream without the existing bearer", async () => {
  const observed: { contentType?: string | null; authorization?: string | null } = {};
  const client = new PubkyShopClient({
    session: "opaque-host-bearer",
    serviceUrl: "https://inventory.example/",
    fetch: async (_input, init) => {
      const headers = new Headers(init?.headers);
      observed.contentType = headers.get("content-type");
      observed.authorization = headers.get("authorization");
      return new Response(
        JSON.stringify({
          token: "a".repeat(43),
          session_id: "00000000-0000-4000-8000-000000000003",
          pubky: SELLER_PUBKY,
          capabilities: "/pub/pubky.app/marketplace-service/v1/:rw",
          expires_at: "2026-09-21T00:00:00Z",
        }),
        { status: 201 },
      );
    },
  });
  const result = await client.createSession(new Uint8Array([1, 2, 3, 4]));
  assert.equal(result.ok, true);
  assert.equal(observed.contentType, "application/octet-stream");
  assert.equal(observed.authorization, null);
});

test("default fetch is bound so Chromium Window.fetch is not illegally invoked", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = function windowFetch(this: unknown, input: RequestInfo | URL) {
    if (this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    calls += 1;
    assert.match(String(input), new RegExp(`/v1/sellers/${SELLER_PUBKY}/listings`));
    return Promise.resolve(
      new Response(JSON.stringify({ listings: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  } as typeof fetch;
  try {
    const client = new PubkyShopClient({
      session: "opaque-host-bearer",
      serviceUrl: "https://inventory.example/",
    });
    const result = await client.listings(SELLER_PUBKY);
    assert.equal(result.ok, true);
    assert.equal(calls, 1);
    if (result.ok) {
      assert.deepEqual(result.value.listings, []);
    }
  } finally {
    globalThis.fetch = previous;
  }
});

test("events since alias is sent as the service cursor query", async () => {
  let url = "";
  const client = new PubkyShopClient({
    session: "opaque-host-bearer",
    serviceUrl: "https://inventory.example/",
    fetch: async (input) => {
      url = String(input);
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    },
  });
  const result = await client.events(SELLER_PUBKY, { since: "c1" });
  assert.equal(result.ok, true);
  assert.equal(
    url,
    `https://inventory.example/v1/sellers/${SELLER_PUBKY}/events?limit=100&cursor=c1`,
  );
});
