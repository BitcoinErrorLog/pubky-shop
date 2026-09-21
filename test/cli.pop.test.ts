import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import test from "node:test";

import { signResultProof } from "../src/cli/pop.js";
import { canonicalJson } from "../src/json.js";

test("result PoP signs the §10.4 JCS object", () => {
  const seed = Uint8Array.from({ length: 32 }, () => 3);
  const proof = signResultProof(seed, {
    flowId: "018f4f36-8d4c-7a7b-a2dd-d5ef304068ec",
    path: "/v1/auth/grant-flows/018f4f36-8d4c-7a7b-a2dd-d5ef304068ec/result-ticket",
    purpose: "ticket",
    resultDeliveryId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    nonceId: "018f4f36-8d4c-7a7b-a2dd-d5ef304068ed",
    issuedAt: 1760000000,
  });
  const message = {
    domain: "marketplace/grant-result-pop/v1",
    flow_id: "018f4f36-8d4c-7a7b-a2dd-d5ef304068ec",
    issued_at: 1760000000,
    method: "POST",
    nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    nonce_id: "018f4f36-8d4c-7a7b-a2dd-d5ef304068ed",
    path: "/v1/auth/grant-flows/018f4f36-8d4c-7a7b-a2dd-d5ef304068ec/result-ticket",
    purpose: "ticket",
    result_delivery_id: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  };
  const signature = Buffer.from(proof.signature, "base64url");
  assert.equal(
    ed25519.verify(
      signature,
      new TextEncoder().encode(canonicalJson(message)),
      ed25519.getPublicKey(seed),
    ),
    true,
  );
});
