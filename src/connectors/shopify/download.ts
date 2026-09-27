import { ShopifyBridgeError } from "./errors.js";

const DEFAULT_MAX_IMAGE_BYTES = 5_000_000;

export async function downloadHttpsBytes(
  url: string,
  fetchImpl: typeof fetch,
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
): Promise<{ readonly bytes: Uint8Array; readonly contentType: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ShopifyBridgeError("image_url_rejected");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new ShopifyBridgeError("image_url_rejected");
  }
  const response = await fetchImpl(parsed, {
    method: "GET",
    redirect: "manual",
    headers: { accept: "image/*" },
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new ShopifyBridgeError("image_redirect_rejected");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ShopifyBridgeError("image_download_failed");
  }
  const type =
    (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!type.startsWith("image/")) {
    await response.body?.cancel().catch(() => undefined);
    throw new ShopifyBridgeError("image_type_rejected");
  }
  if (response.body === null) {
    return { bytes: new Uint8Array(), contentType: type };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ShopifyBridgeError("image_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: body, contentType: type };
}
