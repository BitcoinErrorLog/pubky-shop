import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { KEYCHAIN_SERVICE } from "./config.js";
import { authError, remoteError } from "./exit.js";

export type StoredCredential = {
  readonly capabilities: string;
  readonly expires_at: string;
  readonly pubky: string;
  readonly session_id: string;
  readonly token: string;
};

export type CredentialStore = {
  get(origin: string, pubky: string): Promise<StoredCredential | undefined>;
  list(origin: string): Promise<StoredCredential[]>;
  put(origin: string, credential: StoredCredential): Promise<void>;
  delete(origin: string, pubky: string): Promise<void>;
};

function accountName(origin: string, pubky: string): string {
  return `${origin}|${pubky}`;
}

function indexFile(directory: string, origin: string): string {
  return path.join(directory, `active-${Buffer.from(origin).toString("hex")}.json`);
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
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = indexFile(directory, origin);
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

async function readIndex(directory: string, origin: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(indexFile(directory, origin), "utf8")) as {
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
