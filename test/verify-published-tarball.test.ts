import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = join(process.cwd(), "scripts/verify-published-tarball.sh");
const spec = "@bitcoinerrorlog/pubky-shop@0.0.0-test";

async function fakeNpm(dir: string, succeedOn: number): Promise<void> {
  const bin = join(dir, "npm");
  const count = join(dir, "count");
  await writeFile(
    bin,
    `#!/bin/sh
n=0
if [ -f "${count}" ]; then
  n=$(cat "${count}")
fi
n=$((n + 1))
echo "$n" > "${count}"
if [ "$n" -ge ${succeedOn} ]; then
  echo "https://registry.npmjs.org/@bitcoinerrorlog/pubky-shop/-/pubky-shop-0.0.0-test.tgz"
  exit 0
fi
echo "npm ERR! not found" >&2
exit 1
`,
    "utf8",
  );
  await chmod(bin, 0o755);
}

function runVerify(dir: string, timeoutSeconds: string, intervalSeconds: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("bash", [script, spec], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        VERIFY_TIMEOUT_SECONDS: timeoutSeconds,
        VERIFY_INTERVAL_SECONDS: intervalSeconds,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test("verify exits 1 when npm never returns a tarball before the deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verify-tarball-miss-"));
  try {
    await fakeNpm(dir, 99);
    const result = await runVerify(dir, "2", "1");
    assert.equal(result.code, 1);
    assert.match(result.stdout, /npm view missed/);
    assert.match(result.stdout, /within 2s/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify retries until npm returns dist.tarball", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verify-tarball-hit-"));
  try {
    await fakeNpm(dir, 3);
    const result = await runVerify(dir, "8", "1");
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /npm view missed/);
    assert.match(
      result.stdout,
      /Published tarball: https:\/\/registry\.npmjs\.org\/@bitcoinerrorlog\/pubky-shop\/-\/pubky-shop-0\.0\.0-test\.tgz \(attempt 3\)/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
