import { Keypair, PublicKey, Pubky, resolvePubky, type Session } from "@synonymdev/pubky";

import { STAGING_HOMESERVER_Z32 } from "./config.js";
import type { StoredHomeserverSession } from "./credentials.js";
import { authError, remoteError } from "./exit.js";
import {
  canonicalPubky,
  listingPath,
  type HomeserverPath,
  type HomeserverSession,
} from "./proof.js";

export type ThrowawaySignup = {
  readonly session: HomeserverSession;
  readonly signerApprove: (authorizationUrl: string) => Promise<void>;
  readonly pubky: string;
  readonly clientFetch: (url: string, init?: RequestInit) => Promise<Response>;
  readonly stats: (path: HomeserverPath) => Promise<{ etag?: string } | undefined>;
  exportSessionSecret(): Promise<string>;
  dispose(): void;
};

export function wrapSession(session: Session): HomeserverSession {
  return {
    pubky: session.info.publicKey.z32(),
    capabilities: [...session.info.capabilities],
    async putText(path, body) {
      await session.storage.putText(path, body);
    },
    async delete(path) {
      await session.storage.delete(path);
    },
  };
}

export async function restoreHomeserverSession(
  stored: StoredHomeserverSession,
): Promise<HomeserverSession> {
  let session: Session;
  try {
    session = await new Pubky().restoreSession(stored.secret);
  } catch {
    throw authError("homeserver_session_invalid", "stored homeserver session cannot be restored");
  }
  const wrapped = wrapSession(session);
  if (canonicalPubky(wrapped.pubky) !== canonicalPubky(stored.pubky)) {
    session.free();
    throw authError("homeserver_session_invalid", "stored homeserver session pubky mismatch");
  }
  return wrapped;
}

export async function createThrowawayStagingSignup(signupToken: string): Promise<ThrowawaySignup> {
  const pubky = new Pubky();
  const keypair = Keypair.random();
  const signer = pubky.signer(keypair);
  const homeserver = PublicKey.from(STAGING_HOMESERVER_Z32);
  const session = await signer.signupCookie(homeserver, signupToken);
  const wrapped = wrapSession(session);
  return {
    session: wrapped,
    pubky: wrapped.pubky,
    async signerApprove(authorizationUrl) {
      await signer.approveAuthRequest(authorizationUrl);
    },
    clientFetch: (url, init) =>
      pubky.client.fetch(url.startsWith("pubky://") ? resolvePubky(url) : url, init ?? null),
    async stats(path) {
      const stats = await session.storage.stats(path);
      if (!stats || stats.etag === undefined) {
        return undefined;
      }
      return { etag: stats.etag };
    },
    async exportSessionSecret() {
      return await session.exportLocalSecret();
    },
    dispose() {
      session.free();
      signer.free();
      keypair.free();
    },
  };
}

export async function putListingRecord(
  throwaway: ThrowawaySignup,
  listingId: string,
  body: string,
  etag: string | undefined,
): Promise<Response> {
  const url = resolvePubky(`pubky://${throwaway.pubky}${listingPath(listingId)}`);
  return await throwaway.clientFetch(url, {
    method: "PUT",
    headers: new Headers({
      "content-type": "application/json",
      ...(etag === undefined ? {} : { "If-Match": etag }),
    }),
    body,
    credentials: "include",
  });
}

export async function mintStagingInvite(): Promise<string> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      [`${process.env.HOME}/.cursor/skills/pubky-staging-invite/scripts/generate.sh`],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(remoteError("signup_token", "staging invite failed"));
        return;
      }
      const token = Buffer.concat(stdout).toString("utf8").trim();
      if (!token) {
        reject(authError("signup_token", "staging invite was empty"));
        return;
      }
      resolve(token);
    });
  });
}
