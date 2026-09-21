import { listingRecordText } from "./seller.js";
import { putListingRecord, type ThrowawaySignup } from "./homeserver.js";
import { listingPath } from "./proof.js";

export type CasSpikeResult = {
  readonly created: number;
  readonly mismatched: number;
  readonly matched: number;
  readonly path: string;
};

export async function runCasSpike(
  throwaway: ThrowawaySignup,
  listingId: string,
): Promise<CasSpikeResult> {
  const body = listingRecordText({
    recordType: "listing",
    schemaVersion: 1,
    title: "cas-spike",
    revision: 1,
    location: {},
    media: [],
    variants: [{ id: "default", enabled: true, quantity: 1, sku: "CAS-1" }],
    shippingOptions: [],
    sale: {
      acceptsOffers: false,
      format: "fixed_price",
      unitPrice: { amountMinor: 1, currency: "USD", exponent: 2 },
    },
  });
  const created = await putListingRecord(throwaway, listingId, body, undefined);
  const stats = await throwaway.stats(listingPath(listingId));
  const mismatched = await putListingRecord(throwaway, listingId, body, "deadbeef");
  const matched = await putListingRecord(throwaway, listingId, body, stats?.etag);
  return {
    created: created.status,
    mismatched: mismatched.status,
    matched: matched.status,
    path: listingPath(listingId),
  };
}
