import { Keypair, PublicKey, Pubky, type Session } from "@synonymdev/pubky";

import { STAGING_HOMESERVER_Z32 } from "./config.js";
import { authError, remoteError } from "./exit.js";
import { listingPath, type HomeserverPath, type HomeserverSession } from "./proof.js";

export type ThrowawaySignup = {
  readonly session: HomeserverSession;
  readonly signerApprove: (authorizationUrl: string) => Promise<void>;
  readonly pubky: string;
  readonly clientFetch: (url: string, init?: RequestInit) => Promise<Response>;
  readonly stats: (path: HomeserverPath) => Promise<{ etag?: string } | undefined>;
  dispose(): void;
};

function wrapSession(session: Session): HomeserverSession {
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

export async function createThrowawayStagingSignup(signupToken: string): Promise<ThrowawaySignup> {
  const pubky = new Pubky();
  const keypair = Keypair.random();
  const signer = pubky.signer(keypair);
  const homeserver = PublicKey.from(STAGING_HOMESERVER_Z32);
  const session = await signer.signup(homeserver, signupToken);
  const wrapped = wrapSession(session);
  return {
    session: wrapped,
    pubky: wrapped.pubky,
    async signerApprove(authorizationUrl) {
      await signer.approveAuthRequest(authorizationUrl);
    },
    clientFetch: (url, init) => pubky.client.fetch(url, init ?? null),
    async stats(path) {
      const stats = await session.storage.stats(path);
      if (!stats || stats.etag === undefined) {
        return undefined;
      }
      return { etag: stats.etag };
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
  const url = `pubky://${throwaway.pubky}${listingPath(listingId)}`;
  return await throwaway.clientFetch(url, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(etag === undefined ? {} : { "if-match": etag }),
    },
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
