import { writeFile } from "node:fs/promises";

import type { CanonicalCsvRow } from "../csv.js";
import { exportCanonicalCsv, listingIdentity, parseCanonicalCsv } from "../csv.js";
import { canonicalJson, type JsonObject, type JsonValue } from "../json.js";
import type { StoredCredential } from "./credentials.js";
import { authError, usage } from "./exit.js";
import { jsonRequest, requireOk } from "./http.js";
import { listingPath } from "./proof.js";

export type SellerClient = {
  listings(pubky: string, cursor?: string): Promise<JsonObject>;
  orders(pubky: string, cursor?: string): Promise<JsonObject>;
  events(pubky: string, cursor?: string): Promise<JsonObject>;
  syncMany(listings: readonly { seller_pubky: string; listing_id: string }[]): Promise<JsonObject>;
  addWebhook(url: string): Promise<JsonObject>;
  rotateWebhook(id: string): Promise<JsonObject>;
  deleteWebhook(id: string): Promise<void>;
  revokeSession(id: string): Promise<void>;
};

export function createSellerClient(
  origin: string,
  token: string,
  fetchImpl: typeof fetch,
): SellerClient {
  const auth = `Bearer ${token}`;
  return {
    async listings(pubky, cursor) {
      const suffix = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const response = await jsonRequest(
        fetchImpl,
        origin,
        `/v1/sellers/${encodeURIComponent(pubky)}/listings?limit=100${suffix}`,
        { method: "GET", authorization: auth },
      );
      return requireOk(response, [200]) as JsonObject;
    },
    async orders(pubky, cursor) {
      const suffix = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const response = await jsonRequest(
        fetchImpl,
        origin,
        `/v1/sellers/${encodeURIComponent(pubky)}/orders?limit=100${suffix}`,
        { method: "GET", authorization: auth },
      );
      return requireOk(response, [200]) as JsonObject;
    },
    async events(pubky, cursor) {
      const suffix = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const response = await jsonRequest(
        fetchImpl,
        origin,
        `/v1/sellers/${encodeURIComponent(pubky)}/events?limit=100${suffix}`,
        { method: "GET", authorization: auth },
      );
      return requireOk(response, [200]) as JsonObject;
    },
    async syncMany(listings) {
      const response = await jsonRequest(fetchImpl, origin, "/v1/listings/sync-many", {
        method: "POST",
        authorization: auth,
        body: { listings },
      });
      return requireOk(response, [200, 207]) as JsonObject;
    },
    async addWebhook(url) {
      const response = await jsonRequest(fetchImpl, origin, "/v1/webhooks", {
        method: "POST",
        authorization: auth,
        body: { url },
      });
      return requireOk(response, [201, 200]) as JsonObject;
    },
    async rotateWebhook(id) {
      const response = await jsonRequest(
        fetchImpl,
        origin,
        `/v1/webhooks/${encodeURIComponent(id)}/rotate`,
        {
          method: "POST",
          authorization: auth,
          body: {},
        },
      );
      return requireOk(response, [200]) as JsonObject;
    },
    async deleteWebhook(id) {
      const response = await jsonRequest(
        fetchImpl,
        origin,
        `/v1/webhooks/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          authorization: auth,
        },
      );
      requireOk(response, [204]);
    },
    async revokeSession(id) {
      const response = await jsonRequest(
        fetchImpl,
        origin,
        `/v1/auth/sessions/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          authorization: auth,
        },
      );
      requireOk(response, [204]);
    },
  };
}

export function listingRecordFromRows(rows: readonly CanonicalCsvRow[]): JsonObject {
  const first = rows[0];
  if (!first) {
    throw usage("listing has no rows");
  }
  return {
    recordType: "listing",
    schemaVersion: 1,
    title: first.title,
    revision: first.recordRevision,
    location: {},
    media: first.media as unknown as JsonValue,
    variants: rows.map((row) => ({
      id: row.variantId,
      enabled: row.variantEnabled,
      quantity: row.variantQuantity,
      sku: row.sku,
    })),
    shippingOptions: first.shippingOptions as unknown as JsonValue,
    sale: {
      acceptsOffers: false,
      format:
        first.sale !== null &&
        typeof first.sale === "object" &&
        !Array.isArray(first.sale) &&
        typeof first.sale.format === "string"
          ? first.sale.format
          : "fixed_price",
      unitPrice: {
        amountMinor: first.amountMinor,
        currency: first.currency,
        exponent: first.exponent,
      },
    },
  };
}

export async function exportListings(
  client: SellerClient,
  credential: StoredCredential,
  format: string,
  output: string | undefined,
): Promise<unknown> {
  const body = await client.listings(credential.pubky);
  if (format === "json" || format === undefined) {
    const text = `${JSON.stringify(body, null, 2)}\n`;
    if (output) {
      await writeFile(output, text);
    }
    return body;
  }
  if (format !== "csv") {
    throw usage("--format must be csv or json");
  }
  const listings = Array.isArray(body.listings) ? body.listings : [];
  const rows: CanonicalCsvRow[] = [];
  for (const listing of listings) {
    if (listing === null || typeof listing !== "object") {
      continue;
    }
    const record = (listing as { record?: CanonicalCsvRow }).record;
    if (record) {
      rows.push(record);
    }
  }
  if (rows.length === 0) {
    throw usage("listing export has no canonical rows; use --format json");
  }
  const csv = exportCanonicalCsv(rows);
  if (output) {
    await writeFile(output, csv);
  }
  return Buffer.from(csv).toString("utf8");
}

export function parseImportRecords(
  bytes: Uint8Array,
  format: string,
): { listing_id: string; record: JsonObject }[] {
  if (format === "json") {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as JsonValue;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records.map((entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw usage("import JSON must be listing objects");
      }
      const record = entry as JsonObject;
      const listingId =
        typeof record.listing_id === "string"
          ? record.listing_id
          : typeof record.listingId === "string"
            ? record.listingId
            : `listing_${index + 1}`;
      return { listing_id: listingId, record };
    });
  }
  const parsed = parseCanonicalCsv(bytes);
  const groups = new Map<string, CanonicalCsvRow[]>();
  for (const row of parsed.rows) {
    const identity = listingIdentity(row);
    const current = groups.get(identity) ?? [];
    current.push(row);
    groups.set(identity, current);
  }
  return [...groups.values()].map((rows) => {
    const first = rows[0];
    if (!first) {
      throw usage("empty listing group");
    }
    return { listing_id: first.listingId, record: listingRecordFromRows(rows) };
  });
}

export { listingPath };

export function requireCredentialNotExpired(credential: StoredCredential, now = Date.now()): void {
  if (Date.parse(credential.expires_at) <= now) {
    throw authError("session_expired", "stored bearer is expired");
  }
}

export function listingRecordText(record: JsonObject): string {
  return canonicalJson(record);
}
