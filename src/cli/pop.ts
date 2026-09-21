import { ed25519 } from "@noble/curves/ed25519.js";

import { canonicalJson } from "../json.js";
import { RESULT_POP_DOMAIN } from "./config.js";
import { encodeBase64Url } from "./encoding.js";
import type { ResultProof } from "./bff.js";

export function signResultProof(
  seed: Uint8Array,
  input: {
    readonly flowId: string;
    readonly path: string;
    readonly purpose: "ticket" | "claim";
    readonly resultDeliveryId: string;
    readonly nonce: string;
    readonly nonceId: string;
    readonly issuedAt: number;
  },
): ResultProof {
  const message = {
    domain: RESULT_POP_DOMAIN,
    flow_id: input.flowId,
    issued_at: input.issuedAt,
    method: "POST",
    nonce: input.nonce,
    nonce_id: input.nonceId,
    path: input.path,
    purpose: input.purpose,
    result_delivery_id: input.resultDeliveryId,
  };
  return {
    issued_at: input.issuedAt,
    nonce: input.nonce,
    nonce_id: input.nonceId,
    signature: encodeBase64Url(
      ed25519.sign(new TextEncoder().encode(canonicalJson(message)), seed),
    ),
  };
}
