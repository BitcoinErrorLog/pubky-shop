import { jsonRequest, requireOk } from "./http.js";

export type ChallengeResponse = {
  readonly challenge_id: string;
  readonly expires_at: string;
  readonly nonce: string;
  readonly proof_uri: string;
};

export type VerifyResponse = {
  readonly authorization_url: string;
  readonly cli_token: string;
  readonly expires_at: string;
  readonly flow_id: string;
  readonly state_id: string;
  readonly status: string;
};

export type StatusResponse = {
  readonly expires_at: string;
  readonly flow_id: string | null;
  readonly state_id: string;
  readonly status: string;
  readonly terminal_code: string | null;
};

export type NonceResponse = {
  readonly expires_at: string;
  readonly nonce: string;
  readonly nonce_id: string;
};

export type ClaimResponse = {
  readonly capabilities: string;
  readonly expires_at: string;
  readonly pubky: string;
  readonly token: string;
};

export type ResultProof = {
  readonly issued_at: number;
  readonly nonce: string;
  readonly nonce_id: string;
  readonly signature: string;
};

function cliAuth(token: string): string {
  return `PubkyShopCli ${token}`;
}

export type BffClient = {
  createChallenge(body: {
    readonly pubky: string;
    readonly result_cpk: string;
    readonly result_delivery_id: string;
  }): Promise<ChallengeResponse>;
  verify(challengeId: string, nonce: string): Promise<VerifyResponse>;
  status(stateId: string, token: string): Promise<StatusResponse>;
  resultNonce(stateId: string, token: string, purpose: "ticket" | "claim"): Promise<NonceResponse>;
  ticket(
    stateId: string,
    token: string,
    proof: ResultProof,
  ): Promise<{ readonly expires_at: string }>;
  claim(stateId: string, token: string, proof: ResultProof): Promise<ClaimResponse>;
  cancel(stateId: string, token: string): Promise<void>;
};

export function createBffClient(origin: string, fetchImpl: typeof fetch): BffClient {
  return {
    async createChallenge(body) {
      const response = await jsonRequest(fetchImpl, origin, "/api/cli/grant-challenges", {
        method: "POST",
        body,
      });
      return requireOk(response, [201]) as ChallengeResponse;
    },
    async verify(challengeId, nonce) {
      const response = await jsonRequest(
        fetchImpl,
        origin,
        `/api/cli/grant-challenges/${challengeId}/verify`,
        { method: "POST", body: { nonce } },
      );
      return requireOk(response, [201]) as VerifyResponse;
    },
    async status(stateId, token) {
      const response = await jsonRequest(
        fetchImpl,
        origin,
        `/api/cli/grant-flows/${stateId}/status`,
        { method: "POST", body: {}, authorization: cliAuth(token) },
      );
      return requireOk(response, [200]) as StatusResponse;
    },
    async resultNonce(stateId, token, purpose) {
      const response = await jsonRequest(
        fetchImpl,
        origin,
        `/api/cli/grant-flows/${stateId}/result-nonces`,
        { method: "POST", body: { purpose }, authorization: cliAuth(token) },
      );
      return requireOk(response, [201, 200]) as NonceResponse;
    },
    async ticket(stateId, token, proof) {
      const response = await jsonRequest(
        fetchImpl,
        origin,
        `/api/cli/grant-flows/${stateId}/result-ticket`,
        { method: "POST", body: { proof }, authorization: cliAuth(token) },
      );
      return requireOk(response, [200]) as { readonly expires_at: string };
    },
    async claim(stateId, token, proof) {
      const response = await jsonRequest(
        fetchImpl,
        origin,
        `/api/cli/grant-flows/${stateId}/claim`,
        { method: "POST", body: { proof }, authorization: cliAuth(token) },
      );
      return requireOk(response, [200]) as ClaimResponse;
    },
    async cancel(stateId, token) {
      const response = await jsonRequest(
        fetchImpl,
        origin,
        `/api/cli/grant-flows/${stateId}/cancel`,
        { method: "POST", body: {}, authorization: cliAuth(token) },
      );
      requireOk(response, [204]);
    },
  };
}
