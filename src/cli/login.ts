import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { createBffClient, type BffClient } from "./bff.js";
import type { CliConfig } from "./config.js";
import { POLL_INTERVAL_MS } from "./config.js";
import type { CredentialStore, StoredCredential } from "./credentials.js";
import { decodeBase64Url32, encodeBase64Url } from "./encoding.js";
import { authError, remoteError, CliError } from "./exit.js";
import { signResultProof } from "./pop.js";
import {
  proofDocumentText,
  proofPath,
  requireMarketplaceCapability,
  resultPublicKey,
  type HomeserverSession,
} from "./proof.js";
import { openUrl, writeQrPng } from "./qr.js";

export type PendingLogin = {
  readonly version: 1;
  readonly bff_url: string;
  readonly service_url: string;
  readonly pubky: string;
  readonly state_id: string;
  readonly cli_token: string;
  readonly flow_id: string;
  readonly result_seed: string;
  readonly result_delivery_id: string;
  readonly expires_at: string;
  readonly authorization_url: string;
  readonly proof_path: string;
};

export type LoginStartResult = {
  readonly pending: PendingLogin;
  readonly authorizationUrl: string;
  readonly pubky: string;
};

export type AuthorizationUrlDescription = {
  readonly scheme: string;
  readonly host: string;
  readonly caps: string | null;
  readonly relayHost: string | null;
  readonly cid: string | null;
  readonly cpkLen: number | null;
  readonly hasSecret: boolean;
};

export type PendingLoginDescription = {
  readonly version: 1;
  readonly bff_url: string;
  readonly service_url: string;
  readonly pubky: string;
  readonly state_id: string;
  readonly flow_id: string;
  readonly expires_at: string;
  readonly proof_path: string;
  readonly has_cli_token: boolean;
  readonly has_result_seed: boolean;
  readonly has_result_delivery_id: boolean;
  readonly auth_url: AuthorizationUrlDescription;
};

export function describeAuthorizationUrl(url: string): AuthorizationUrlDescription {
  try {
    const parsed = new URL(url);
    const relay = parsed.searchParams.get("relay");
    let relayHost: string | null = null;
    if (relay !== null) {
      try {
        relayHost = new URL(relay).host;
      } catch {
        relayHost = "invalid";
      }
    }
    const cpk = parsed.searchParams.get("cpk");
    return {
      scheme: parsed.protocol.replace(/:$/, ""),
      host: parsed.hostname,
      caps: parsed.searchParams.get("caps"),
      relayHost,
      cid: parsed.searchParams.get("cid"),
      cpkLen: cpk === null ? null : cpk.length,
      hasSecret: parsed.searchParams.has("secret"),
    };
  } catch {
    return {
      scheme: "invalid",
      host: "",
      caps: null,
      relayHost: null,
      cid: null,
      cpkLen: null,
      hasSecret: false,
    };
  }
}

export function describePendingLogin(pending: PendingLogin): PendingLoginDescription {
  return {
    version: pending.version,
    bff_url: pending.bff_url,
    service_url: pending.service_url,
    pubky: pending.pubky,
    state_id: pending.state_id,
    flow_id: pending.flow_id,
    expires_at: pending.expires_at,
    proof_path: pending.proof_path,
    has_cli_token: pending.cli_token.length > 0,
    has_result_seed: pending.result_seed.length > 0,
    has_result_delivery_id: pending.result_delivery_id.length > 0,
    auth_url: describeAuthorizationUrl(pending.authorization_url),
  };
}

function pendingFile(configDir: string): string {
  return path.join(configDir, "pending-login.json");
}

export async function writePendingLogin(configDir: string, pending: PendingLogin): Promise<void> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const file = pendingFile(configDir);
  await writeFile(file, JSON.stringify(pending), { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function readPendingLogin(configDir: string): Promise<PendingLogin> {
  try {
    const raw = await readFile(pendingFile(configDir), "utf8");
    return JSON.parse(raw) as PendingLogin;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw authError("pending_login_missing", "no pending login");
    }
    throw authError("pending_login_missing", "pending login is unreadable");
  }
}

export async function deletePendingLogin(configDir: string): Promise<void> {
  try {
    await unlink(pendingFile(configDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw remoteError("pending_login", "failed to delete pending login");
    }
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startMarketplaceLogin(input: {
  readonly config: CliConfig;
  readonly session: HomeserverSession;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
}): Promise<LoginStartResult> {
  requireMarketplaceCapability(input.session);
  const seed = Uint8Array.from(randomBytes(32));
  const delivery = Uint8Array.from(randomBytes(32));
  const resultCpk = resultPublicKey(seed);
  const deliveryId = encodeBase64Url(delivery);
  const bff = createBffClient(input.config.bffUrl, input.fetch);
  const challenge = await bff.createChallenge({
    pubky: input.session.pubky,
    result_cpk: resultCpk,
    result_delivery_id: deliveryId,
  });
  const now = Math.floor((input.now?.() ?? Date.now()) / 1000);
  const challengeExp = Math.floor(Date.parse(challenge.expires_at) / 1000);
  const iat = now;
  const exp = Math.min(challengeExp, iat + 60);
  if (!(exp > iat)) {
    throw authError("challenge_expired", "challenge expired before proof");
  }
  const document = proofDocumentText({
    aud: input.config.bffUrl,
    challengeId: challenge.challenge_id,
    exp,
    iat,
    nonce: decodeBase64Url32(challenge.nonce),
    pubky: input.session.pubky,
    resultCpk,
    resultDeliveryId: deliveryId,
  });
  const hsPath = proofPath(challenge.challenge_id);
  await input.session.putText(hsPath, document);
  try {
    const verified = await bff.verify(challenge.challenge_id, challenge.nonce);
    return {
      pending: {
        version: 1,
        bff_url: input.config.bffUrl,
        service_url: input.config.serviceUrl,
        pubky: input.session.pubky,
        state_id: verified.state_id,
        cli_token: verified.cli_token,
        flow_id: verified.flow_id,
        result_seed: encodeBase64Url(seed),
        result_delivery_id: deliveryId,
        expires_at: verified.expires_at,
        authorization_url: verified.authorization_url,
        proof_path: hsPath,
      },
      authorizationUrl: verified.authorization_url,
      pubky: input.session.pubky,
    };
  } finally {
    await input.session.delete(hsPath).catch(() => undefined);
  }
}

export async function emitLoginQr(input: {
  readonly authorizationUrl: string;
  readonly qrPath?: string;
  readonly printUrl: boolean;
  readonly platform: string;
}): Promise<void> {
  if (input.qrPath) {
    await writeQrPng(input.qrPath, input.authorizationUrl);
  }
  if (!input.printUrl) {
    await openUrl(input.authorizationUrl, input.platform);
  }
}

async function signedProof(
  bff: BffClient,
  pending: PendingLogin,
  purpose: "ticket" | "claim",
  path: string,
): Promise<ReturnType<typeof signResultProof>> {
  const nonce = await bff.resultNonce(pending.state_id, pending.cli_token, purpose);
  return signResultProof(decodeBase64Url32(pending.result_seed), {
    flowId: pending.flow_id,
    path,
    purpose,
    resultDeliveryId: pending.result_delivery_id,
    nonce: nonce.nonce,
    nonceId: nonce.nonce_id,
    issuedAt: Math.floor(Date.now() / 1000),
  });
}

export async function completeMarketplaceLogin(input: {
  readonly config: CliConfig;
  readonly pending: PendingLogin;
  readonly store: CredentialStore;
  readonly fetch: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}): Promise<StoredCredential> {
  const bff = createBffClient(input.config.bffUrl, input.fetch);
  const wait = input.sleep ?? sleep;
  const deadline = Date.parse(input.pending.expires_at);
  while ((input.now?.() ?? Date.now()) < deadline) {
    const status = await bff.status(input.pending.state_id, input.pending.cli_token);
    if (status.status === "complete") {
      const ticketPath = `/v1/auth/grant-flows/${input.pending.flow_id}/result-ticket`;
      const claimPath = `/v1/auth/grant-flows/${input.pending.flow_id}/claim`;
      try {
        await bff.ticket(
          input.pending.state_id,
          input.pending.cli_token,
          await signedProof(bff, input.pending, "ticket", ticketPath),
        );
      } catch (error) {
        if (!(error instanceof CliError) || error.code !== "result_denied") {
          throw error;
        }
      }
      const claimed = await bff.claim(
        input.pending.state_id,
        input.pending.cli_token,
        await signedProof(bff, input.pending, "claim", claimPath),
      );
      const credential: StoredCredential = {
        capabilities: claimed.capabilities,
        expires_at: claimed.expires_at,
        pubky: claimed.pubky,
        session_id: "",
        token: claimed.token,
      };
      await input.store.put(input.config.serviceUrl, credential);
      await deletePendingLogin(input.config.configDir);
      return credential;
    }
    if (
      status.status === "mismatch" ||
      status.status === "expired" ||
      status.status === "cancelled" ||
      status.status === "invalid" ||
      status.status === "failed"
    ) {
      await deletePendingLogin(input.config.configDir);
      throw authError(status.status, status.terminal_code ?? status.status);
    }
    await wait(POLL_INTERVAL_MS);
  }
  throw authError("flow_expired", "flow_expired");
}
