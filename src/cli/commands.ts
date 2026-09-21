import { readFile } from "node:fs/promises";

import type { CliConfig, FlagMap } from "./config.js";
import type { CredentialStore } from "./credentials.js";
import { loadDefaultCredential } from "./credentials.js";
import { authError, usage, type JsonResult } from "./exit.js";
import {
  completeMarketplaceLogin,
  emitLoginQr,
  readPendingLogin,
  startMarketplaceLogin,
  writePendingLogin,
} from "./login.js";
import { listingPath, type HomeserverSession } from "./proof.js";
import {
  createSellerClient,
  exportListings,
  listingRecordText,
  parseImportRecords,
  requireCredentialNotExpired,
} from "./seller.js";

export type CommandContext = {
  readonly config: CliConfig;
  readonly flags: FlagMap;
  readonly env: NodeJS.ProcessEnv;
  readonly fetch: typeof fetch;
  readonly platform: string;
  readonly store: CredentialStore;
  readonly homeserverSession?: HomeserverSession;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly putListing?: (listingId: string, body: string) => Promise<void>;
};

async function withSeller(ctx: CommandContext) {
  const credential = await loadDefaultCredential(ctx.store, ctx.config.serviceUrl, ctx.env);
  requireCredentialNotExpired(credential, ctx.now?.() ?? Date.now());
  return {
    credential,
    client: createSellerClient(ctx.config.serviceUrl, credential.token, ctx.fetch),
  };
}

export async function dispatch(
  command: readonly string[],
  ctx: CommandContext,
): Promise<JsonResult> {
  const [group, action, ...rest] = command;
  if (group === "auth" && action === "login") {
    return await authLogin(ctx);
  }
  if (group === "auth" && action === "status") {
    const credential = await loadDefaultCredential(ctx.store, ctx.config.serviceUrl, ctx.env);
    return {
      ok: true,
      data: {
        pubky: credential.pubky,
        expires_at: credential.expires_at,
        capabilities: credential.capabilities,
      },
    };
  }
  if (group === "auth" && action === "logout") {
    const credential = await loadDefaultCredential(ctx.store, ctx.config.serviceUrl, ctx.env);
    const client = createSellerClient(ctx.config.serviceUrl, credential.token, ctx.fetch);
    if (!ctx.flags.forceLocal) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          credential.session_id,
        )
      ) {
        throw authError(
          "session_id_missing",
          "no session id; pass --force-local to drop the local bearer",
        );
      }
      await client.revokeSession(credential.session_id);
    }
    await ctx.store.delete(ctx.config.serviceUrl, credential.pubky);
    return { ok: true, data: { pubky: credential.pubky } };
  }
  if (group === "listings" && action === "export") {
    const { credential, client } = await withSeller(ctx);
    const data = await exportListings(
      client,
      credential,
      ctx.flags.format ?? "json",
      ctx.flags.output,
    );
    return { ok: true, data };
  }
  if (group === "listings" && action === "import") {
    const inputPath = ctx.flags.input ?? rest[0];
    if (!inputPath) {
      throw usage("listings import requires --input");
    }
    const { credential, client } = await withSeller(ctx);
    const format = ctx.flags.format ?? (inputPath.endsWith(".csv") ? "csv" : "json");
    const records = parseImportRecords(await readFile(inputPath), format);
    const homeserverSession = ctx.homeserverSession;
    const putListing =
      ctx.putListing ??
      (homeserverSession === undefined
        ? undefined
        : (listingId: string, body: string) =>
            homeserverSession.putText(listingPath(listingId), body));
    if (putListing === undefined) {
      throw usage("listings import requires a homeserver session");
    }
    for (const record of records) {
      await putListing(record.listing_id, listingRecordText(record.record));
    }
    const synced = await client.syncMany(
      records.map((record) => ({ seller_pubky: credential.pubky, listing_id: record.listing_id })),
    );
    return { ok: true, data: synced };
  }
  if (group === "orders" && action === "export") {
    const { credential, client } = await withSeller(ctx);
    const data = await client.orders(credential.pubky, ctx.flags.cursor);
    return { ok: true, data };
  }
  if (group === "events" && action === "tail") {
    const { credential, client } = await withSeller(ctx);
    const data = await client.events(credential.pubky, ctx.flags.cursor);
    return { ok: true, data };
  }
  if (group === "webhook" && action === "add") {
    const url = ctx.flags.url ?? rest[0];
    if (!url) {
      throw usage("webhook add requires --url");
    }
    const { client } = await withSeller(ctx);
    return { ok: true, data: await client.addWebhook(url) };
  }
  if (group === "webhook" && action === "rotate") {
    const id = ctx.flags.id ?? rest[0];
    if (!id) {
      throw usage("webhook rotate requires --id");
    }
    const { client } = await withSeller(ctx);
    return { ok: true, data: await client.rotateWebhook(id) };
  }
  if (group === "webhook" && action === "delete") {
    const id = ctx.flags.id ?? rest[0];
    if (!id) {
      throw usage("webhook delete requires --id");
    }
    const { client } = await withSeller(ctx);
    await client.deleteWebhook(id);
    return { ok: true, data: { id } };
  }
  throw usage("unknown command");
}

async function authLogin(ctx: CommandContext): Promise<JsonResult> {
  if (ctx.flags.complete) {
    const pending = await readPendingLogin(ctx.config.configDir);
    const credential = await completeMarketplaceLogin({
      config: ctx.config,
      pending,
      store: ctx.store,
      fetch: ctx.fetch,
      ...(ctx.sleep === undefined ? {} : { sleep: ctx.sleep }),
      ...(ctx.now === undefined ? {} : { now: ctx.now }),
    });
    return {
      ok: true,
      data: {
        pubky: credential.pubky,
        expires_at: credential.expires_at,
        capabilities: credential.capabilities,
      },
    };
  }
  if (!ctx.homeserverSession) {
    throw authError(
      "homeserver_session_missing",
      "homeserver session covering marketplace write is required",
    );
  }
  const started = await startMarketplaceLogin({
    config: ctx.config,
    session: ctx.homeserverSession,
    fetch: ctx.fetch,
    ...(ctx.now === undefined ? {} : { now: ctx.now }),
  });
  await writePendingLogin(ctx.config.configDir, started.pending);
  await emitLoginQr({
    authorizationUrl: started.authorizationUrl,
    printUrl: ctx.flags.printUrl,
    platform: ctx.platform,
    ...(ctx.flags.qrPath === undefined ? {} : { qrPath: ctx.flags.qrPath }),
  });
  if (ctx.flags.stopAfterQr) {
    return {
      ok: true,
      data: {
        status: "awaiting_scan",
        pubky: started.pubky,
        authorization_url: started.authorizationUrl,
        expires_at: started.pending.expires_at,
        qr_path: ctx.flags.qrPath ?? null,
      },
    };
  }
  const credential = await completeMarketplaceLogin({
    config: ctx.config,
    pending: started.pending,
    store: ctx.store,
    fetch: ctx.fetch,
    ...(ctx.sleep === undefined ? {} : { sleep: ctx.sleep }),
    ...(ctx.now === undefined ? {} : { now: ctx.now }),
  });
  return {
    ok: true,
    data: {
      pubky: credential.pubky,
      expires_at: credential.expires_at,
      capabilities: credential.capabilities,
    },
  };
}
