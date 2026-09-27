import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { sha256Hex } from "../../hash.js";
import { ShopifyBridgeError } from "./errors.js";
import type { ShopifyLoss } from "./map.js";

export type ReceiptState =
  | "received"
  | "effect-planned"
  | "effect-complete"
  | "checkpointed"
  | "quarantined";

export interface StoredAdjust {
  readonly schema_version: 1;
  readonly kind: "inventory.adjust";
  readonly aggregate_id: string;
  readonly listing_id: string;
  readonly expected_revision: string;
  readonly delta: string;
  readonly idempotency_key: string;
  readonly external_ref: { readonly channel: "shopify"; readonly external_id: string };
}

export interface CatalogVariantPlan {
  readonly variantId: string;
  readonly sku: string;
  readonly inventoryItemId: string;
  readonly quantity: number;
}

export type PlannedEffect =
  | { readonly kind: "noop"; readonly losses: readonly ShopifyLoss[]; readonly reason: string }
  | {
      readonly kind: "catalog";
      readonly listingId: string;
      readonly aggregateId: string;
      readonly recordText: string;
      readonly media: readonly {
        readonly path: string;
        readonly base64: string;
        readonly contentType: string;
      }[];
      readonly sellerPubky: string;
      readonly catalogVariants: readonly CatalogVariantPlan[];
      readonly adjust: StoredAdjust | null;
      readonly losses: readonly ShopifyLoss[];
    }
  | {
      readonly kind: "stock";
      readonly listingId: string;
      readonly aggregateId: string;
      readonly catalogVariants: readonly CatalogVariantPlan[];
      readonly adjust: StoredAdjust | null;
      readonly losses: readonly ShopifyLoss[];
    }
  | {
      readonly kind: "inventory-set";
      readonly inventoryItemId: string;
      readonly locationId: string;
      readonly quantity: number;
      readonly referenceDocumentUri: string;
      readonly losses: readonly ShopifyLoss[];
    };

export interface Receipt {
  readonly channel: "shopify";
  readonly shopId: string;
  readonly externalEventId: string;
  readonly payloadHash: string;
  readonly state: ReceiptState;
  readonly plan?: PlannedEffect;
  readonly reason: string;
  readonly conflictingHash: string;
}

export interface CatalogEntry {
  readonly listingId: string;
  readonly aggregateId: string;
  readonly variantId: string;
  readonly sku: string;
  readonly inventoryItemId: string;
  readonly quantity: number;
}

function fileName(shopId: string, externalEventId: string): string {
  return sha256Hex(new TextEncoder().encode(`shopify\u0000${shopId}\u0000${externalEventId}`));
}

async function atomicWrite(file: string, body: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, body, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
  await chmod(file, 0o600);
}

export class FileReceiptLog {
  readonly #directory: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(directory: string) {
    this.#directory = directory;
  }

  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #read(shopId: string, externalEventId: string): Promise<Receipt | undefined> {
    try {
      const raw = await readFile(
        path.join(this.#directory, `${fileName(shopId, externalEventId)}.json`),
        "utf8",
      );
      return JSON.parse(raw) as Receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw new ShopifyBridgeError("receipt_unreadable");
    }
  }

  async #write(receipt: Receipt): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const file = path.join(
      this.#directory,
      `${fileName(receipt.shopId, receipt.externalEventId)}.json`,
    );
    await atomicWrite(file, `${JSON.stringify(receipt)}\n`);
  }

  async open(shopId: string, externalEventId: string, payloadHash: string): Promise<Receipt> {
    return this.#exclusive(async () => {
      const existing = await this.#read(shopId, externalEventId);
      if (existing === undefined) {
        const created: Receipt = {
          channel: "shopify",
          shopId,
          externalEventId,
          payloadHash,
          state: "received",
          reason: "received",
          conflictingHash: "",
        };
        await this.#write(created);
        return created;
      }
      if (existing.payloadHash === payloadHash) {
        return existing;
      }
      if (existing.state === "quarantined" && existing.conflictingHash === payloadHash) {
        return existing;
      }
      const quarantined: Receipt = {
        ...existing,
        state: "quarantined",
        reason: "changed_payload",
        conflictingHash: payloadHash,
      };
      await this.#write(quarantined);
      return quarantined;
    });
  }

  async savePlan(receipt: Receipt, plan: PlannedEffect): Promise<Receipt> {
    return this.#exclusive(async () => {
      const current = await this.#read(receipt.shopId, receipt.externalEventId);
      if (
        current === undefined ||
        current.payloadHash !== receipt.payloadHash ||
        current.state !== "received"
      ) {
        throw new ShopifyBridgeError("receipt_conflict");
      }
      const next: Receipt = { ...current, state: "effect-planned", plan, reason: "planned" };
      await this.#write(next);
      return next;
    });
  }

  async markComplete(receipt: Receipt): Promise<Receipt> {
    return this.#exclusive(async () => {
      const current = await this.#read(receipt.shopId, receipt.externalEventId);
      if (current === undefined || current.state !== "effect-planned") {
        throw new ShopifyBridgeError("receipt_conflict");
      }
      const next: Receipt = { ...current, state: "effect-complete", reason: "effect_complete" };
      await this.#write(next);
      return next;
    });
  }

  async checkpoint(receipt: Receipt): Promise<Receipt> {
    return this.#exclusive(async () => {
      const current = await this.#read(receipt.shopId, receipt.externalEventId);
      if (current === undefined || current.state !== "effect-complete") {
        throw new ShopifyBridgeError("receipt_conflict");
      }
      const next: Receipt = { ...current, state: "checkpointed", reason: "checkpointed" };
      await this.#write(next);
      return next;
    });
  }

  async quarantine(receipt: Receipt, reason: string): Promise<Receipt> {
    return this.#exclusive(async () => {
      const current = await this.#read(receipt.shopId, receipt.externalEventId);
      if (current === undefined) {
        throw new ShopifyBridgeError("receipt_conflict");
      }
      const next: Receipt = { ...current, state: "quarantined", reason };
      await this.#write(next);
      return next;
    });
  }

  async releaseQuarantine(shopId: string, externalEventId: string): Promise<void> {
    return this.#exclusive(async () => {
      const current = await this.#read(shopId, externalEventId);
      if (current === undefined || current.state !== "quarantined") {
        throw new ShopifyBridgeError("quarantine_missing");
      }
      await unlink(path.join(this.#directory, `${fileName(shopId, externalEventId)}.json`));
    });
  }
}

export class FileCatalog {
  readonly #file: string;
  #entries = new Map<string, CatalogEntry>();
  #loaded = false;

  constructor(directory: string) {
    this.#file = path.join(directory, "catalog.json");
  }

  async #load(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8")) as { entries?: CatalogEntry[] };
      for (const entry of parsed.entries ?? []) {
        this.#entries.set(entry.inventoryItemId, entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ShopifyBridgeError("catalog_unreadable");
      }
    }
    this.#loaded = true;
  }

  async getByInventoryItem(inventoryItemId: string): Promise<CatalogEntry | undefined> {
    await this.#load();
    return this.#entries.get(inventoryItemId);
  }

  async listByAggregate(aggregateId: string): Promise<readonly CatalogEntry[]> {
    await this.#load();
    return [...this.#entries.values()].filter((entry) => entry.aggregateId === aggregateId);
  }

  async replaceListing(aggregateId: string, entries: readonly CatalogEntry[]): Promise<void> {
    await this.#load();
    for (const [key, entry] of this.#entries) {
      if (entry.aggregateId === aggregateId) {
        this.#entries.delete(key);
      }
    }
    for (const entry of entries) {
      if (entry.inventoryItemId !== "") {
        this.#entries.set(entry.inventoryItemId, entry);
      }
    }
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    await atomicWrite(this.#file, `${JSON.stringify({ entries: [...this.#entries.values()] })}\n`);
  }
}
