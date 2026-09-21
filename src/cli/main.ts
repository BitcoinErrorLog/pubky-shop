import { parseArgs, resolveConfig, type FlagMap } from "./config.js";
import { credentialStoreFor } from "./credentials.js";
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
  readonly signerApprove?: (authorizationUrl: string) => Promise<void>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly putListing?: (listingId: string, body: string) => Promise<void>;
};

export async function runCli(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  let flags: FlagMap | undefined;
  try {
    const parsed = parseArgs(argv);
    flags = parsed.flags;
    const config = await resolveConfig(parsed.flags, io.env);
    const ctx: CommandContext = {
      config,
      flags: parsed.flags,
      env: io.env,
      fetch: io.fetch,
      platform: io.platform,
      store: credentialStoreFor(io.env, config.configDir),
      ...(io.homeserverSession === undefined ? {} : { homeserverSession: io.homeserverSession }),
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
