import { Keypair } from "@synonymdev/pubky";

import { canonicalJson, type JsonObject } from "../json.js";
import { HOMESERVER_CAPABILITY, PROOF_DOMAIN } from "./config.js";
import { encodeBase64Url, sha256Bytes } from "./encoding.js";
import { authError } from "./exit.js";

export type HomeserverPath = `/pub/${string}`;

export type HomeserverSession = {
  readonly pubky: string;
  readonly capabilities: readonly string[];
  putText(path: HomeserverPath, body: string): Promise<void>;
  delete(path: HomeserverPath): Promise<void>;
};

export function resultPublicKey(seed: Uint8Array): string {
  const keypair = Keypair.fromSecret(seed);
  try {
    return keypair.publicKey.z32();
  } finally {
    keypair.free();
  }
}

export function canonicalPubky(value: string): string {
  return value.replace(/^pubky/, "");
}

export function proofPath(challengeId: string): HomeserverPath {
  return `/pub/pubky.app/marketplace/v1/cli-grant-proofs/${challengeId}`;
}

export function listingPath(listingId: string): HomeserverPath {
  return `/pub/pubky.app/marketplace/v1/listings/${listingId}`;
}

export function requireMarketplaceCapability(session: HomeserverSession): void {
  const covers = session.capabilities.some(
    (entry) =>
      entry === "/:rw" ||
      entry === "/pub/pubky.app/:rw" ||
      entry === HOMESERVER_CAPABILITY ||
      entry.startsWith("/pub/pubky.app/marketplace"),
  );
  if (!covers) {
    throw authError("homeserver_session_missing", "homeserver session lacks marketplace write");
  }
}

export function proofDocument(input: {
  readonly aud: string;
  readonly challengeId: string;
  readonly exp: number;
  readonly iat: number;
  readonly nonce: Uint8Array;
  readonly pubky: string;
  readonly resultCpk: string;
  readonly resultDeliveryId: string;
}): JsonObject {
  return {
    aud: input.aud,
    challenge_id: input.challengeId,
    domain: PROOF_DOMAIN,
    exp: input.exp,
    iat: input.iat,
    nonce_hash: encodeBase64Url(sha256Bytes(input.nonce)),
    pubky: input.pubky,
    result_cpk: input.resultCpk,
    result_delivery_id: input.resultDeliveryId,
  };
}

export function proofDocumentText(input: Parameters<typeof proofDocument>[0]): string {
  return canonicalJson(proofDocument(input));
}
