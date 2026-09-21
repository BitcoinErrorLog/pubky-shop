#!/usr/bin/env node
import { runCli } from "./main.js";

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  fetch: globalThis.fetch,
  platform: process.platform,
});
process.exitCode = code;
