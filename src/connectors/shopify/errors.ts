export class ShopifyBridgeError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(code: string, details: Record<string, string | number> = {}) {
    super(code);
    this.name = "ShopifyBridgeError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
