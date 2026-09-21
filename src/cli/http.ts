import { mapHttpStatus, remoteError, usage } from "./exit.js";

export type HttpJson = {
  readonly status: number;
  readonly body: unknown;
};

export async function readBoundedJson(response: Response, maximum = 16 * 1024): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maximum) {
      throw remoteError("response_limit_exceeded", "response_limit_exceeded");
    }
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maximum) {
    throw remoteError("response_limit_exceeded", "response_limit_exceeded");
  }
  if (buffer.byteLength === 0) {
    return null;
  }
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw remoteError("invalid_response", "invalid_response");
  }
}

export async function jsonRequest(
  fetchImpl: typeof fetch,
  origin: string,
  path: string,
  init: {
    readonly method: string;
    readonly body?: unknown;
    readonly authorization?: string;
    readonly extraHeaders?: Record<string, string>;
  },
): Promise<HttpJson> {
  const target = new URL(path, `${origin}/`);
  if (target.origin !== origin) {
    throw usage("origin_violation");
  }
  let response: Response;
  try {
    response = await fetchImpl(target, {
      method: init.method,
      headers: {
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.authorization === undefined ? {} : { authorization: init.authorization }),
        ...init.extraHeaders,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      credentials: "omit",
      redirect: "manual",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw remoteError("transport_error", "transport_error");
  }
  if (response.status === 204) {
    await response.body?.cancel().catch(() => undefined);
    return { status: 204, body: null };
  }
  const body = await readBoundedJson(response, 16 * 1024 * 1024);
  return { status: response.status, body };
}

function errorCode(body: unknown): string {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.length > 0) {
      return record.error;
    }
    if (record.error !== null && typeof record.error === "object" && !Array.isArray(record.error)) {
      const nested = record.error as Record<string, unknown>;
      if (typeof nested.code === "string" && nested.code.length > 0) {
        return nested.code;
      }
    }
    if (typeof record.code === "string" && record.code.length > 0) {
      return record.code;
    }
  }
  return "invalid_response";
}

export function requireOk(response: HttpJson, allowed: readonly number[]): unknown {
  if (!allowed.includes(response.status)) {
    throw mapHttpStatus(response.status, errorCode(response.body));
  }
  return response.body;
}
