import type { StoredHomeserverSession } from "../../cli/credentials.js";
import { restoreHomeserverSession } from "../../cli/homeserver.js";
import type { HomeserverSession } from "../../cli/proof.js";
import { type HomeserverPath, requireMarketplaceCapability } from "../../cli/proof.js";
import type { HomeserverWriter } from "./effects.js";
import { ShopifyBridgeError } from "./errors.js";

const RECOVERY_KEYS = new Set([
  "mnemonic",
  "seed",
  "recovery",
  "recoveryphrase",
  "recovery_phrase",
  "rootkey",
  "root_key",
]);

/**
 * Accepts the CLI's stored homeserver session and rejects recovery-file fields.
 * The bridge never reads a seller recovery file.
 */
export function assertNotRecoveryMaterial(value: unknown): StoredHomeserverSession {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ShopifyBridgeError("homeserver_session_invalid");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (RECOVERY_KEYS.has(key.toLowerCase())) {
      throw new ShopifyBridgeError("recovery_material_rejected");
    }
  }
  if (typeof record.pubky !== "string" || typeof record.secret !== "string") {
    throw new ShopifyBridgeError("homeserver_session_invalid");
  }
  if (
    !Array.isArray(record.capabilities) ||
    !record.capabilities.every((entry) => typeof entry === "string")
  ) {
    throw new ShopifyBridgeError("homeserver_session_invalid");
  }
  return {
    pubky: record.pubky,
    secret: record.secret,
    capabilities: record.capabilities,
  };
}

/** Writes listing text and media through the restored homeserver session. */
export function writerFromHomeserverSession(session: HomeserverSession): HomeserverWriter {
  try {
    requireMarketplaceCapability(session);
  } catch {
    throw new ShopifyBridgeError("homeserver_session_missing");
  }
  return {
    putText(filePath, body) {
      return session.putText(filePath as HomeserverPath, body);
    },
    putBytes(filePath, body) {
      return session.putBytes(filePath as HomeserverPath, body);
    },
  };
}

export async function writerFromStoredHomeserverSession(value: unknown): Promise<HomeserverWriter> {
  const stored = assertNotRecoveryMaterial(value);
  try {
    const session = await restoreHomeserverSession(stored);
    return writerFromHomeserverSession(session);
  } catch (error) {
    if (error instanceof ShopifyBridgeError) {
      throw error;
    }
    throw new ShopifyBridgeError("homeserver_session_invalid");
  }
}
