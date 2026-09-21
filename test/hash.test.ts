import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex, sha256HexSubtle } from "../src/index.js";

test("sha256Hex matches Web Crypto for empty, abc, and a 300-byte buffer", async () => {
  const cases = [new Uint8Array(), new TextEncoder().encode("abc"), new Uint8Array(300).fill(7)];
  for (const bytes of cases) {
    assert.equal(sha256Hex(bytes), await sha256HexSubtle(bytes));
  }
  assert.equal(
    sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
