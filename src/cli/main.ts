import { parseArgs, resolveConfig, type FlagMap } from "./config.js";
import {
  credentialStoreFor,
  homeserverSessionStoreFor,
  loadStoredHomeserverSession,
  type StoredHomeserverSession,
} from "./credentials.js";
import {
  CliError,
  EXIT_REMOTE,
  EXIT_USAGE,
  printResult,
  type CliWriter,
  type ExitCode,
  type JsonResult,
} from "./exit.js";
import { dispatch, type CommandContext } from "./commands.js";
import type { HomeserverSession } from "./proof.js";

export type CliIo = {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdout: CliWriter;
  readonly stderr: CliWriter;
  readonly fetch: typeof fetch;
  readonly platform: string;
  readonly homeserverSession?: HomeserverSession;
  readonly bindHomeserverSession?: (stored: StoredHomeserverSession) => Promise<HomeserverSession>;
  readonly signerApprove?: (authorizationUrl: string) => Promise<void>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly putListing?: (listingId: string, body: string) => Promise<void>;
};

async function resolveHomeserverSession(
  io: CliIo,
  serviceUrl: string,
  configDir: string,
  flags: FlagMap,
): Promise<HomeserverSession | undefined> {
  if (io.homeserverSession !== undefined) {
    return io.homeserverSession;
  }
  if (flags.complete) {
    return undefined;
  }
  const stored = await loadStoredHomeserverSession(
    homeserverSessionStoreFor(io.env, configDir),
    serviceUrl,
    io.env,
  );
  if (stored === undefined) {
    return undefined;
  }
  if (io.bindHomeserverSession !== undefined) {
    return await io.bindHomeserverSession(stored);
  }
  const { restoreHomeserverSession } = await import("./homeserver.js");
  return await restoreHomeserverSession(stored);
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  let flags: FlagMap | undefined;
  try {
    const parsed = parseArgs(argv);
    flags = parsed.flags;
    const config = await resolveConfig(parsed.flags, io.env);
    const homeserverSession = await resolveHomeserverSession(
      io,
      config.serviceUrl,
      config.configDir,
      parsed.flags,
    );
    const ctx: CommandContext = {
      config,
      flags: parsed.flags,
      env: io.env,
      fetch: io.fetch,
      platform: io.platform,
      store: credentialStoreFor(io.env, config.configDir),
      ...(homeserverSession === undefined ? {} : { homeserverSession }),
      ...(io.signerApprove === undefined ? {} : { signerApprove: io.signerApprove }),
      ...(io.now === undefined ? {} : { now: io.now }),
      ...(io.sleep === undefined ? {} : { sleep: io.sleep }),
      ...(io.putListing === undefined ? {} : { putListing: io.putListing }),
    };
    const result = await dispatch(parsed.command, ctx);
    printResult(parsed.flags.json, io.stdout, io.stderr, result);
    return 0;
  } catch (error) {
    const json = flags?.json === true;
    if (error instanceof CliError) {
      const result: JsonResult = { ok: false, error: { code: error.code, message: error.message } };
      printResult(json, io.stdout, io.stderr, result);
      return error.exitCode;
    }
    const result: JsonResult = { ok: false, error: { code: "internal", message: "internal" } };
    printResult(json, io.stdout, io.stderr, result);
    return json ? EXIT_REMOTE : EXIT_USAGE;
  }
}
