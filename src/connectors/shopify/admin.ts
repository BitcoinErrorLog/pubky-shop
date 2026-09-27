import { SHOPIFY_ADMIN_API_VERSION } from "./boundary.js";
import { ShopifyBridgeError } from "./errors.js";
import { shopifyGid } from "./ids.js";
import type { LocationLevel } from "./map.js";

export const INVENTORY_LEVELS_QUERY = `query inventoryLevels($id: ID!) {
  inventoryItem(id: $id) {
    id
    inventoryLevels(first: 50) {
      pageInfo { hasNextPage }
      nodes {
        location { id }
        quantities(names: ["available"]) { name quantity }
      }
    }
  }
}`;

export const VARIANT_BY_SKU_QUERY = `query variantBySku($query: String!) {
  productVariants(first: 2, query: $query) {
    nodes { id sku inventoryItem { id } }
  }
}`;

export const INVENTORY_SET_MUTATION = `mutation inventorySet($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) {
    inventoryAdjustmentGroup { id }
    userErrors { field message }
  }
}`;

export interface VariantLookup {
  readonly variantId: string;
  readonly inventoryItemId: string;
}

export interface InventorySetInput {
  readonly inventoryItemId: string;
  readonly locationId: string;
  readonly quantity: number;
  readonly referenceDocumentUri: string;
}

export interface ShopifyAdmin {
  inventoryLevels(inventoryItemId: string): Promise<readonly LocationLevel[]>;
  variantBySku(sku: string): Promise<VariantLookup | undefined>;
  inventorySet(input: InventorySetInput): Promise<{ readonly adjustmentGroupId: string }>;
}

export interface RecordedShopifyFixtures {
  readonly inventoryLevels: Readonly<Record<string, readonly LocationLevel[]>>;
  readonly variantBySku: Readonly<Record<string, VariantLookup | null>>;
  readonly inventorySet: Readonly<Record<string, { readonly adjustmentGroupId: string }>>;
}

function inventorySetKey(input: InventorySetInput): string {
  return `${input.inventoryItemId}|${input.locationId}|${input.quantity}|${input.referenceDocumentUri}`;
}

export function recordedShopifyAdmin(fixtures: RecordedShopifyFixtures): ShopifyAdmin {
  return {
    async inventoryLevels(inventoryItemId) {
      const found = fixtures.inventoryLevels[shopifyGid("InventoryItem", inventoryItemId)];
      if (found === undefined) {
        throw new ShopifyBridgeError("unrecorded_shopify_call", { operation: "inventoryLevels" });
      }
      return found;
    },
    async variantBySku(sku) {
      if (!Object.hasOwn(fixtures.variantBySku, sku)) {
        throw new ShopifyBridgeError("unrecorded_shopify_call", { operation: "variantBySku" });
      }
      return fixtures.variantBySku[sku] ?? undefined;
    },
    async inventorySet(input) {
      const found = fixtures.inventorySet[inventorySetKey(input)];
      if (found === undefined) {
        throw new ShopifyBridgeError("unrecorded_shopify_call", { operation: "inventorySet" });
      }
      return found;
    },
  };
}

export interface ShopifyAdminHttpConfig {
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly apiVersion?: string;
  readonly fetch?: typeof fetch;
}

function shopDomain(value: string): string {
  const domain = value.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
    throw new ShopifyBridgeError("invalid_shop_domain");
  }
  return domain;
}

interface GraphqlErrorBody {
  readonly errors?: unknown;
  readonly data?: unknown;
}

async function graphql(
  config: {
    readonly origin: string;
    readonly token: string;
    readonly apiVersion: string;
    readonly fetchImpl: typeof fetch;
  },
  query: string,
  variables: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const target = new URL(`/admin/api/${config.apiVersion}/graphql.json`, config.origin);
  if (target.hostname !== new URL(config.origin).hostname) {
    throw new ShopifyBridgeError("origin_violation");
  }
  let response: Response;
  try {
    response = await config.fetchImpl(target, {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-shopify-access-token": config.token,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new ShopifyBridgeError("shopify_transport");
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new ShopifyBridgeError("shopify_redirect_rejected");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ShopifyBridgeError("shopify_http", { status: response.status });
  }
  let body: GraphqlErrorBody;
  try {
    body = (await response.json()) as GraphqlErrorBody;
  } catch {
    throw new ShopifyBridgeError("shopify_response");
  }
  if (body.errors !== undefined) {
    throw new ShopifyBridgeError("shopify_graphql");
  }
  return body.data;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function shopifyAdminHttp(config: ShopifyAdminHttpConfig): ShopifyAdmin {
  const domain = shopDomain(config.shopDomain);
  const version = config.apiVersion ?? SHOPIFY_ADMIN_API_VERSION;
  if (!/^[0-9]{4}-[0-9]{2}$/.test(version)) {
    throw new ShopifyBridgeError("invalid_configuration");
  }
  if (config.accessToken.length < 16) {
    throw new ShopifyBridgeError("invalid_configuration");
  }
  const origin = `https://${domain}`;
  const fetchImpl = (config.fetch ?? globalThis.fetch).bind(globalThis);
  const client = { origin, token: config.accessToken, apiVersion: version, fetchImpl };
  return {
    async inventoryLevels(inventoryItemId) {
      const id = shopifyGid("InventoryItem", inventoryItemId);
      const data = asRecord(await graphql(client, INVENTORY_LEVELS_QUERY, { id }));
      const item = asRecord(data?.inventoryItem);
      const connection = asRecord(item?.inventoryLevels);
      const page = asRecord(connection?.pageInfo);
      const nodes = connection?.nodes;
      if (!Array.isArray(nodes)) {
        throw new ShopifyBridgeError("shopify_response");
      }
      const levels: LocationLevel[] = [];
      for (const node of nodes) {
        const record = asRecord(node);
        const location = asRecord(record?.location);
        const locationId = location?.id;
        const quantities = record?.quantities;
        if (typeof locationId !== "string" || !Array.isArray(quantities)) {
          throw new ShopifyBridgeError("shopify_response");
        }
        const available = quantities.find((entry) => asRecord(entry)?.name === "available");
        const quantity = asRecord(available)?.quantity;
        if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 0) {
          throw new ShopifyBridgeError("shopify_response");
        }
        levels.push({ inventoryItemId: id, locationId, available: quantity });
      }
      if (page?.hasNextPage === true) {
        throw new ShopifyBridgeError("location_page_incomplete");
      }
      return levels;
    },
    async variantBySku(sku) {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(sku)) {
        throw new ShopifyBridgeError("sku_not_searchable");
      }
      const data = asRecord(await graphql(client, VARIANT_BY_SKU_QUERY, { query: `sku:${sku}` }));
      const connection = asRecord(data?.productVariants);
      const nodes = connection?.nodes;
      if (!Array.isArray(nodes)) {
        throw new ShopifyBridgeError("shopify_response");
      }
      if (nodes.length === 0) {
        return undefined;
      }
      if (nodes.length !== 1) {
        throw new ShopifyBridgeError("ambiguous_sku");
      }
      const node = asRecord(nodes[0]);
      const inventoryItem = asRecord(node?.inventoryItem);
      if (typeof node?.id !== "string" || typeof inventoryItem?.id !== "string") {
        throw new ShopifyBridgeError("shopify_response");
      }
      return { variantId: node.id, inventoryItemId: inventoryItem.id };
    },
    async inventorySet(input) {
      const variables = {
        input: {
          name: "available",
          reason: "correction",
          referenceDocumentUri: input.referenceDocumentUri,
          ignoreCompareQuantity: true,
          quantities: [
            {
              inventoryItemId: shopifyGid("InventoryItem", input.inventoryItemId),
              locationId: shopifyGid("Location", input.locationId),
              quantity: input.quantity,
            },
          ],
        },
      };
      const data = asRecord(await graphql(client, INVENTORY_SET_MUTATION, variables));
      const payload = asRecord(data?.inventorySetQuantities);
      const userErrors = payload?.userErrors;
      if (!Array.isArray(userErrors) || userErrors.length > 0) {
        throw new ShopifyBridgeError("shopify_user_error", {
          count: Array.isArray(userErrors) ? userErrors.length : 0,
        });
      }
      const group = asRecord(payload?.inventoryAdjustmentGroup);
      if (typeof group?.id !== "string") {
        throw new ShopifyBridgeError("shopify_response");
      }
      return { adjustmentGroupId: group.id };
    },
  };
}

export function inventorySetFixtureKey(input: InventorySetInput): string {
  return inventorySetKey(input);
}
