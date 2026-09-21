const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX = "0123456789abcdef";

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function hexFromBytes(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += HEX[(byte >> 4) & 0xf];
    text += HEX[byte & 0xf];
  }
  return text;
}

/**
 * Incremental SHA-256 with no Node builtin crypto import. Digest bytes match
 * `crypto.subtle.digest("SHA-256", …)` so codecs stay sync while the browser
 * smoke can pin the same function against Web Crypto.
 */
export class Sha256 {
  #state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  readonly #block = new Uint8Array(64);
  #blockOffset = 0;
  #bytes = 0n;
  #finalized = false;

  update(data: Uint8Array): this {
    if (this.#finalized) {
      throw new Error("sha256 already digested");
    }
    this.#bytes += BigInt(data.byteLength);
    let offset = 0;
    while (offset < data.byteLength) {
      const take = Math.min(64 - this.#blockOffset, data.byteLength - offset);
      this.#block.set(data.subarray(offset, offset + take), this.#blockOffset);
      this.#blockOffset += take;
      offset += take;
      if (this.#blockOffset === 64) {
        this.#compress(this.#block);
        this.#blockOffset = 0;
      }
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.#finalized) {
      throw new Error("sha256 already digested");
    }
    this.#finalized = true;
    this.#block[this.#blockOffset] = 0x80;
    this.#blockOffset += 1;
    if (this.#blockOffset > 56) {
      this.#block.fill(0, this.#blockOffset);
      this.#compress(this.#block);
      this.#block.fill(0);
    } else {
      this.#block.fill(0, this.#blockOffset, 56);
    }
    const bitLength = this.#bytes << 3n;
    const view = new DataView(this.#block.buffer, this.#block.byteOffset, 64);
    view.setUint32(56, Number((bitLength >> 32n) & 0xffffffffn), false);
    view.setUint32(60, Number(bitLength & 0xffffffffn), false);
    this.#compress(this.#block);
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let index = 0; index < 8; index += 1) {
      outView.setUint32(index * 4, this.#state[index] ?? 0, false);
    }
    return out;
  }

  digestHex(): string {
    return hexFromBytes(this.digest());
  }

  #compress(block: Uint8Array): void {
    const w = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, 64);
    for (let index = 0; index < 16; index += 1) {
      w[index] = view.getUint32(index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rotr(w[index - 15] ?? 0, 7) ^ rotr(w[index - 15] ?? 0, 18) ^ ((w[index - 15] ?? 0) >>> 3);
      const s1 =
        rotr(w[index - 2] ?? 0, 17) ^ rotr(w[index - 2] ?? 0, 19) ^ ((w[index - 2] ?? 0) >>> 10);
      w[index] = (((w[index - 16] ?? 0) + s0 + (w[index - 7] ?? 0) + s1) | 0) >>> 0;
    }
    let a = this.#state[0] ?? 0;
    let b = this.#state[1] ?? 0;
    let c = this.#state[2] ?? 0;
    let d = this.#state[3] ?? 0;
    let e = this.#state[4] ?? 0;
    let f = this.#state[5] ?? 0;
    let g = this.#state[6] ?? 0;
    let h = this.#state[7] ?? 0;
    for (let index = 0; index < 64; index += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + (K[index] ?? 0) + (w[index] ?? 0)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    this.#state[0] = ((this.#state[0] ?? 0) + a) >>> 0;
    this.#state[1] = ((this.#state[1] ?? 0) + b) >>> 0;
    this.#state[2] = ((this.#state[2] ?? 0) + c) >>> 0;
    this.#state[3] = ((this.#state[3] ?? 0) + d) >>> 0;
    this.#state[4] = ((this.#state[4] ?? 0) + e) >>> 0;
    this.#state[5] = ((this.#state[5] ?? 0) + f) >>> 0;
    this.#state[6] = ((this.#state[6] ?? 0) + g) >>> 0;
    this.#state[7] = ((this.#state[7] ?? 0) + h) >>> 0;
  }
}

export function createSha256(): Sha256 {
  return new Sha256();
}

export function sha256Hex(bytes: Uint8Array): string {
  return createSha256().update(bytes).digestHex();
}

export async function sha256HexSubtle(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
  return hexFromBytes(new Uint8Array(digest));
}
