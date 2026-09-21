import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../src/cli/config.js";
import { COMMANDS, packageVersion } from "../src/cli/help.js";
import { runCli, type CliIo } from "../src/cli/main.js";

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      env: {},
      cwd: "/",
      stdout: {
        write(chunk) {
          stdout.push(String(chunk));
          return true;
        },
      },
      stderr: {
        write(chunk) {
          stderr.push(String(chunk));
          return true;
        },
      },
      fetch: async () => new Response("unused"),
      platform: "linux",
    },
  };
}

test("parseArgs accepts --help, -h, and --version", () => {
  assert.equal(parseArgs(["--help"]).flags.help, true);
  assert.equal(parseArgs(["-h"]).flags.help, true);
  assert.equal(parseArgs(["auth", "login", "-h"]).flags.help, true);
  assert.deepEqual(parseArgs(["auth", "login", "-h"]).command, ["auth", "login"]);
  assert.equal(parseArgs(["--version"]).flags.version, true);
});

test("top-level --help exits 0 and lists every registered command", async () => {
  const { io, stdout, stderr } = captureIo();
  const code = await runCli(["--help"], io);
  assert.equal(code, 0);
  assert.equal(stderr.join(""), "");
  const text = stdout.join("");
  assert.match(text, /^Usage: pubky-shop <command> \[flags\]/m);
  assert.equal(COMMANDS.length > 0, true);
  for (const spec of COMMANDS) {
    assert.equal(text.includes(spec.name), true, `help missing command ${spec.name}`);
    for (const flag of spec.flags) {
      assert.equal(text.includes(flag), true, `help missing flag ${flag} for ${spec.name}`);
    }
  }
});

test("top-level -h matches --help", async () => {
  const help = captureIo();
  const short = captureIo();
  assert.equal(await runCli(["--help"], help.io), 0);
  assert.equal(await runCli(["-h"], short.io), 0);
  assert.equal(short.stdout.join(""), help.stdout.join(""));
});

test("subcommand -h exits 0 and lists every registered command", async () => {
  const { io, stdout } = captureIo();
  const code = await runCli(["listings", "import", "-h"], io);
  assert.equal(code, 0);
  const text = stdout.join("");
  assert.match(text, /Usage: pubky-shop listings import \[flags\]/);
  for (const spec of COMMANDS) {
    assert.equal(text.includes(spec.name), true, `subcommand help missing ${spec.name}`);
  }
});

test("subcommand --help exits 0 and still lists every registered command", async () => {
  const { io, stdout } = captureIo();
  const code = await runCli(["auth", "login", "--help"], io);
  assert.equal(code, 0);
  const text = stdout.join("");
  assert.match(text, /Usage: pubky-shop auth login \[flags\]/);
  for (const spec of COMMANDS) {
    assert.equal(text.includes(spec.name), true, `subcommand help missing ${spec.name}`);
  }
});

test("--version exits 0 and prints the package version", async () => {
  const { io, stdout, stderr } = captureIo();
  const code = await runCli(["--version"], io);
  assert.equal(code, 0);
  assert.equal(stderr.join(""), "");
  assert.equal(stdout.join(""), `${packageVersion()}\n`);
});
