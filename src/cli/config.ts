import { readFile } from "node:fs/promises";
import path from "node:path";

import { usage } from "./exit.js";

export const SHIPPED_BFF_ORIGIN = "https://shop.pubky.app";
export const SHIPPED_SERVICE_ORIGIN = "https://marketplace-service-production-ce23.up.railway.app";
export const STAGING_BFF_ORIGIN = "https://pubky-marketplace-staging.vercel.app";
export const STAGING_SERVICE_ORIGIN = "https://marketplace-service-production.up.railway.app";
export const STAGING_HOMESERVER_Z32 = "ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy";
export const KEYCHAIN_SERVICE = "pubky-shop";
export const POLL_INTERVAL_MS = 2000;
export const HOMESERVER_CAPABILITY = "/pub/pubky.app/marketplace/:rw";
export const PROOF_DOMAIN = "shop-bff/cli-grant-homeserver-pop/v1";
export const RESULT_POP_DOMAIN = "marketplace/grant-result-pop/v1";

export type CliConfig = {
  readonly bffUrl: string;
  readonly serviceUrl: string;
  readonly configDir: string;
};

export type FlagMap = {
  readonly json: boolean;
  readonly printUrl: boolean;
  readonly stopAfterQr: boolean;
  readonly complete: boolean;
  readonly forceLocal: boolean;
  readonly help: boolean;
  readonly version: boolean;
  readonly bffUrl?: string;
  readonly serviceUrl?: string;
  readonly qrPath?: string;
  readonly output?: string;
  readonly format?: string;
  readonly cursor?: string;
  readonly url?: string;
  readonly id?: string;
  readonly input?: string;
};

const ALLOWED_FILE_KEYS = new Set(["bff_url", "service_url"]);

export function configDir(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    return path.join(xdg, "pubky-shop");
  }
  const home = env.HOME?.trim();
  if (!home) {
    throw usage("HOME or XDG_CONFIG_HOME is required");
  }
  return path.join(home, ".config", "pubky-shop");
}

export function validateHttpsOrigin(input: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw usage(`${field} is not a URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    parsed.search !== "" ||
    parsed.pathname !== "/"
  ) {
    throw usage(`${field} must be an HTTPS origin`);
  }
  return parsed.origin;
}

export async function loadConfigFile(
  directory: string,
): Promise<{ readonly bff_url?: string; readonly service_url?: string }> {
  const file = path.join(directory, "config.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw usage("config.json is unreadable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw usage("config.json is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usage("config.json must be an object");
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_FILE_KEYS.has(key)) {
      throw usage("config.json has unknown keys");
    }
    if (typeof record[key] !== "string") {
      throw usage("config.json values must be strings");
    }
  }
  return {
    ...(typeof record.bff_url === "string" ? { bff_url: record.bff_url } : {}),
    ...(typeof record.service_url === "string" ? { service_url: record.service_url } : {}),
  };
}

export async function resolveConfig(flags: FlagMap, env: NodeJS.ProcessEnv): Promise<CliConfig> {
  const directory = configDir(env);
  const file = await loadConfigFile(directory);
  const bff = flags.bffUrl ?? env.PUBKY_SHOP_BFF_URL ?? file.bff_url ?? SHIPPED_BFF_ORIGIN;
  const service =
    flags.serviceUrl ?? env.PUBKY_SHOP_SERVICE_URL ?? file.service_url ?? SHIPPED_SERVICE_ORIGIN;
  return {
    bffUrl: validateHttpsOrigin(bff, "bff_url"),
    serviceUrl: validateHttpsOrigin(service, "service_url"),
    configDir: directory,
  };
}

export function parseArgs(argv: readonly string[]): {
  readonly command: string[];
  readonly flags: FlagMap;
} {
  const command: string[] = [];
  const flags: {
    json: boolean;
    printUrl: boolean;
    stopAfterQr: boolean;
    complete: boolean;
    forceLocal: boolean;
    help: boolean;
    version: boolean;
    bffUrl?: string;
    serviceUrl?: string;
    qrPath?: string;
    output?: string;
    format?: string;
    cursor?: string;
    url?: string;
    id?: string;
    input?: string;
  } = {
    json: false,
    printUrl: false,
    stopAfterQr: false,
    complete: false,
    forceLocal: false,
    help: false,
    version: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      command.push(arg);
      continue;
    }
    const [rawName, inline] = arg.slice(2).split("=", 2);
    const name = rawName ?? "";
    const next = (): string => {
      if (inline !== undefined) {
        return inline;
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw usage(`--${name} requires a value`);
      }
      index += 1;
      return value;
    };
    switch (name) {
      case "json":
        flags.json = true;
        break;
      case "print-url":
        flags.printUrl = true;
        break;
      case "stop-after-qr":
        flags.stopAfterQr = true;
        break;
      case "complete":
        flags.complete = true;
        break;
      case "force-local":
        flags.forceLocal = true;
        break;
      case "help":
        flags.help = true;
        break;
      case "version":
        flags.version = true;
        break;
      case "bff-url":
        flags.bffUrl = next();
        break;
      case "service-url":
        flags.serviceUrl = next();
        break;
      case "qr-path":
        flags.qrPath = next();
        break;
      case "output":
        flags.output = next();
        break;
      case "format":
        flags.format = next();
        break;
      case "cursor":
        flags.cursor = next();
        break;
      case "url":
        flags.url = next();
        break;
      case "id":
        flags.id = next();
        break;
      case "input":
        flags.input = next();
        break;
      default:
        throw usage(`unknown flag --${name}`);
    }
  }
  return { command, flags };
}
