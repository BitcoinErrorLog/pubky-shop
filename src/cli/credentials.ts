import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { KEYCHAIN_SERVICE } from "./config.js";
import { CliError, authError, remoteError } from "./exit.js";
import { canonicalPubky } from "./proof.js";

export const HOMESERVER_SESSION_ACCOUNT_SUFFIX = "homeserver-session";

export type StoredCredential = {
  readonly capabilities: string;
  readonly expires_at: string;
  readonly pubky: string;
  readonly session_id: string;
  readonly token: string;
};

export type StoredHomeserverSession = {
  readonly capabilities: readonly string[];
  readonly pubky: string;
  readonly secret: string;
};

export type CredentialStore = {
  get(origin: string, pubky: string): Promise<StoredCredential | undefined>;
  list(origin: string): Promise<StoredCredential[]>;
  put(origin: string, credential: StoredCredential): Promise<void>;
  delete(origin: string, pubky: string): Promise<void>;
};

export type HomeserverSessionStore = {
  get(origin: string, pubky: string): Promise<StoredHomeserverSession | undefined>;
  list(origin: string): Promise<StoredHomeserverSession[]>;
  put(origin: string, session: StoredHomeserverSession): Promise<void>;
  delete(origin: string, pubky: string): Promise<void>;
};

function accountName(origin: string, pubky: string): string {
  return `${origin}|${pubky}`;
}

export function homeserverSessionAccount(origin: string, pubky: string): string {
  return `${origin}|${canonicalPubky(pubky)}|${HOMESERVER_SESSION_ACCOUNT_SUFFIX}`;
}

function indexFile(directory: string, origin: string, prefix = "active"): string {
  return path.join(directory, `${prefix}-${Buffer.from(origin).toString("hex")}.json`);
}

async function security(
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("security", [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function writeIndex(
  directory: string,
  origin: string,
  pubky: string | undefined,
  prefix = "active",
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = indexFile(directory, origin, prefix);
  if (pubky === undefined) {
    try {
      await unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw remoteError("credential_store", "credential index delete failed");
      }
    }
    return;
  }
  await writeFile(file, JSON.stringify({ origin, pubky }), { mode: 0o600 });
  await chmod(file, 0o600);
}

async function readIndex(
  directory: string,
  origin: string,
  prefix = "active",
): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(indexFile(directory, origin, prefix), "utf8")) as {
      pubky?: string;
    };
    return typeof parsed.pubky === "string" ? parsed.pubky : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw authError("credential_store", "credential index is unreadable");
  }
}

export function filesystemStore(directory: string): CredentialStore {
  const fileFor = (origin: string, pubky: string) =>
    path.join(directory, `${Buffer.from(accountName(origin, pubky)).toString("hex")}.json`);

  return {
    async get(origin, pubky) {
      try {
        const raw = await readFile(fileFor(origin, pubky), "utf8");
        return JSON.parse(raw) as StoredCredential;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw authError("credential_store", "credential store is unreadable");
      }
    },
    async list(origin) {
      const pubky = await readIndex(directory, origin);
      if (!pubky) {
        return [];
      }
      const found = await this.get(origin, pubky);
      return found ? [found] : [];
    },
    async put(origin, credential) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = fileFor(origin, credential.pubky);
      await writeFile(file, JSON.stringify(credential), { mode: 0o600 });
      await chmod(file, 0o600);
      await writeIndex(directory, origin, credential.pubky);
    },
    async delete(origin, pubky) {
      try {
        await unlink(fileFor(origin, pubky));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw remoteError("credential_store", "credential store delete failed");
        }
      }
      await writeIndex(directory, origin, undefined);
    },
  };
}

export function keychainStore(indexDirectory: string): CredentialStore {
  const inner: CredentialStore = {
    async get(origin, pubky) {
      const result = await security([
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        accountName(origin, pubky),
        "-w",
      ]);
      if (result.code !== 0) {
        return undefined;
      }
      return JSON.parse(result.stdout.trim()) as StoredCredential;
    },
    async list(origin) {
      const pubky = await readIndex(indexDirectory, origin);
      if (!pubky) {
        return [];
      }
      const found = await inner.get(origin, pubky);
      return found ? [found] : [];
    },
    async put(origin, credential) {
      const payload = JSON.stringify(credential);
      const result = await security([
        "add-generic-password",
        "-U",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        accountName(origin, credential.pubky),
        "-w",
        payload,
      ]);
      if (result.code !== 0) {
        throw remoteError("credential_store", "keychain write failed");
      }
      await writeIndex(indexDirectory, origin, credential.pubky);
    },
    async delete(origin, pubky) {
      const result = await security([
        "delete-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        accountName(origin, pubky),
      ]);
      if (result.code !== 0 && !result.stderr.includes("could not be found")) {
        throw remoteError("credential_store", "keychain delete failed");
      }
      await writeIndex(indexDirectory, origin, undefined);
    },
  };
  return inner;
}

export function credentialStoreFor(env: NodeJS.ProcessEnv, configDir: string): CredentialStore {
  const override = env.PUBKY_SHOP_CREDENTIAL_DIR?.trim();
  if (override) {
    return filesystemStore(override);
  }
  if (process.platform === "darwin") {
    return keychainStore(configDir);
  }
  return filesystemStore(path.join(configDir, "credentials"));
}

export async function loadDefaultCredential(
  store: CredentialStore,
  origin: string,
  env: NodeJS.ProcessEnv,
): Promise<StoredCredential> {
  const pubky = env.PUBKY_SHOP_PUBKY?.trim();
  if (pubky) {
    const found = await store.get(origin, pubky);
    if (!found) {
      throw authError("not_logged_in", "no stored marketplace bearer");
    }
    return found;
  }
  const listed = await store.list(origin);
  if (listed.length === 1 && listed[0]) {
    return listed[0];
  }
  if (listed.length === 0) {
    throw authError("not_logged_in", "no stored marketplace bearer");
  }
  throw authError("not_logged_in", "multiple stored bearers; set PUBKY_SHOP_PUBKY");
}

function parseStoredHomeserverSession(raw: unknown): StoredHomeserverSession {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw authError("homeserver_session_invalid", "homeserver session is unreadable");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.pubky !== "string" || record.pubky.length === 0) {
    throw authError("homeserver_session_invalid", "homeserver session is unreadable");
  }
  if (typeof record.secret !== "string" || record.secret.length === 0) {
    throw authError("homeserver_session_invalid", "homeserver session is unreadable");
  }
  if (
    !Array.isArray(record.capabilities) ||
    !record.capabilities.every((entry) => typeof entry === "string")
  ) {
    throw authError("homeserver_session_invalid", "homeserver session is unreadable");
  }
  return {
    capabilities: record.capabilities,
    pubky: canonicalPubky(record.pubky),
    secret: record.secret,
  };
}

const HS_INDEX_PREFIX = HOMESERVER_SESSION_ACCOUNT_SUFFIX;

export function filesystemHomeserverSessionStore(directory: string): HomeserverSessionStore {
  const fileFor = (origin: string, pubky: string) =>
    path.join(
      directory,
      `${Buffer.from(homeserverSessionAccount(origin, pubky)).toString("hex")}.json`,
    );

  return {
    async get(origin, pubky) {
      try {
        const raw = await readFile(fileFor(origin, pubky), "utf8");
        return parseStoredHomeserverSession(JSON.parse(raw));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        if (error instanceof CliError) {
          throw error;
        }
        throw authError("homeserver_session_invalid", "homeserver session is unreadable");
      }
    },
    async list(origin) {
      const pubky = await readIndex(directory, origin, HS_INDEX_PREFIX);
      if (!pubky) {
        return [];
      }
      const found = await this.get(origin, pubky);
      return found ? [found] : [];
    },
    async put(origin, session) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stored = parseStoredHomeserverSession(session);
      const file = fileFor(origin, stored.pubky);
      await writeFile(file, JSON.stringify(stored), { mode: 0o600 });
      await chmod(file, 0o600);
      await writeIndex(directory, origin, stored.pubky, HS_INDEX_PREFIX);
    },
    async delete(origin, pubky) {
      try {
        await unlink(fileFor(origin, pubky));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw remoteError("homeserver_session_store", "homeserver session delete failed");
        }
      }
      await writeIndex(directory, origin, undefined, HS_INDEX_PREFIX);
    },
  };
}

export function keychainHomeserverSessionStore(indexDirectory: string): HomeserverSessionStore {
  const inner: HomeserverSessionStore = {
    async get(origin, pubky) {
      const result = await security([
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        homeserverSessionAccount(origin, pubky),
        "-w",
      ]);
      if (result.code !== 0) {
        return undefined;
      }
      try {
        return parseStoredHomeserverSession(JSON.parse(result.stdout.trim()));
      } catch (error) {
        if (error instanceof CliError) {
          throw error;
        }
        throw authError("homeserver_session_invalid", "homeserver session is unreadable");
      }
    },
    async list(origin) {
      const pubky = await readIndex(indexDirectory, origin, HS_INDEX_PREFIX);
      if (!pubky) {
        return [];
      }
      const found = await inner.get(origin, pubky);
      return found ? [found] : [];
    },
    async put(origin, session) {
      const stored = parseStoredHomeserverSession(session);
      const payload = JSON.stringify(stored);
      const result = await security([
        "add-generic-password",
        "-U",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        homeserverSessionAccount(origin, stored.pubky),
        "-w",
        payload,
      ]);
      if (result.code !== 0) {
        throw remoteError("homeserver_session_store", "keychain write failed");
      }
      await writeIndex(indexDirectory, origin, stored.pubky, HS_INDEX_PREFIX);
    },
    async delete(origin, pubky) {
      const result = await security([
        "delete-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        homeserverSessionAccount(origin, pubky),
      ]);
      if (result.code !== 0 && !result.stderr.includes("could not be found")) {
        throw remoteError("homeserver_session_store", "keychain delete failed");
      }
      await writeIndex(indexDirectory, origin, undefined, HS_INDEX_PREFIX);
    },
  };
  return inner;
}

export function homeserverSessionStoreFor(
  env: NodeJS.ProcessEnv,
  configDir: string,
): HomeserverSessionStore {
  const override = env.PUBKY_SHOP_CREDENTIAL_DIR?.trim();
  if (override) {
    return filesystemHomeserverSessionStore(override);
  }
  if (process.platform === "darwin") {
    return keychainHomeserverSessionStore(configDir);
  }
  return filesystemHomeserverSessionStore(path.join(configDir, "credentials"));
}

export async function loadStoredHomeserverSession(
  store: HomeserverSessionStore,
  origin: string,
  env: NodeJS.ProcessEnv,
): Promise<StoredHomeserverSession | undefined> {
  const pubky = env.PUBKY_SHOP_PUBKY?.trim();
  if (pubky) {
    return await store.get(origin, canonicalPubky(pubky));
  }
  const listed = await store.list(origin);
  if (listed.length === 1 && listed[0]) {
    return listed[0];
  }
  if (listed.length === 0) {
    return undefined;
  }
  throw authError(
    "homeserver_session_missing",
    "multiple stored homeserver sessions; set PUBKY_SHOP_PUBKY",
  );
}
