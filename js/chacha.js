/**
 * chacha.js — ChaCha20-Poly1305 and XChaCha20-Poly1305 (RFC 8439 / draft-irtf-cfrg-xchacha).
 *
 * Why this exists at all, given WebCrypto is right there: WebCrypto ships
 * AES-GCM but no ChaCha20. We want both, because the channel is encrypted
 * twice with ciphers from *different design families* — an inner AES-256-GCM
 * layer (hardware-accelerated, NIST) wrapped in an outer ChaCha20-Poly1305
 * layer (ARX, software, IETF), each under an independently derived key.
 *
 * The honest justification for a cascade: it buys nothing against key
 * compromise or a protocol flaw, and it is not a substitute for getting the
 * key agreement right. What it does buy is survival of a *cipher* break — if
 * some future result cracks AES-GCM, the traffic is still behind ChaCha20,
 * and vice versa. Since AES-GCM is hardware-accelerated and ChaCha20 is
 * designed to be fast in pure software, the pair costs little on any device a
 * cousin actually owns.
 *
 * Poly1305 uses 13-bit limbs. That is not stylistic: with larger limbs the
 * intermediate products exceed 2^53 and silently lose precision in JavaScript
 * doubles, which would produce tags that verify inconsistently. The limb
 * schedule below follows the well-known poly1305-donna 16-bit variant.
 *
 * Verified against the RFC 8439 test vectors in tests/chacha.test.mjs.
 */

const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

const rotl = (v, n) => ((v << n) | (v >>> (32 - n))) >>> 0;

/* --------------------------------------------------------------------------
   ChaCha20
   -------------------------------------------------------------------------- */

function chachaCore(out, key32, counter, nonce32, rounds = 20) {
  const x = new Uint32Array(16);
  x[0] = SIGMA[0]; x[1] = SIGMA[1]; x[2] = SIGMA[2]; x[3] = SIGMA[3];
  for (let i = 0; i < 8; i += 1) x[4 + i] = key32[i];
  x[12] = counter >>> 0;
  x[13] = nonce32[0]; x[14] = nonce32[1]; x[15] = nonce32[2];

  const s = x.slice();

  for (let i = 0; i < rounds; i += 2) {
    // Column round.
    qr(x, 0, 4, 8, 12); qr(x, 1, 5, 9, 13); qr(x, 2, 6, 10, 14); qr(x, 3, 7, 11, 15);
    // Diagonal round.
    qr(x, 0, 5, 10, 15); qr(x, 1, 6, 11, 12); qr(x, 2, 7, 8, 13); qr(x, 3, 4, 9, 14);
  }

  for (let i = 0; i < 16; i += 1) {
    const v = (x[i] + s[i]) >>> 0;
    out[i * 4] = v & 0xff;
    out[i * 4 + 1] = (v >>> 8) & 0xff;
    out[i * 4 + 2] = (v >>> 16) & 0xff;
    out[i * 4 + 3] = (v >>> 24) & 0xff;
  }
}

function qr(x, a, b, c, d) {
  x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 16);
  x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 12);
  x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 8);
  x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 7);
}

const le32 = (bytes, offset) =>
  (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;

function words(bytes, count) {
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) out[i] = le32(bytes, i * 4);
  return out;
}

/** One 64-byte keystream block. Exposed for the RFC's block-function vectors. */
export function chacha20Block(key, counter, nonce) {
  const out = new Uint8Array(64);
  chachaCore(out, words(key, 8), counter, words(nonce, 3));
  return out;
}

/** XOR `data` with the ChaCha20 keystream. Encryption and decryption are identical. */
export function chacha20(key, nonce, data, counter = 1) {
  const out = new Uint8Array(data.length);
  const block = new Uint8Array(64);
  const key32 = words(key, 8);
  const nonce32 = words(nonce, 3);

  for (let offset = 0; offset < data.length; offset += 64) {
    chachaCore(block, key32, counter + (offset >>> 6), nonce32);
    const end = Math.min(64, data.length - offset);
    for (let i = 0; i < end; i += 1) out[offset + i] = data[offset + i] ^ block[i];
  }
  return out;
}

/**
 * HChaCha20 — the key-derivation step that turns a 24-byte nonce into a
 * subkey plus a 12-byte nonce, giving XChaCha20 a nonce large enough to pick
 * at random without ever worrying about collisions.
 */
export function hchacha20(key, nonce16) {
  const x = new Uint32Array(16);
  const key32 = words(key, 8);
  x[0] = SIGMA[0]; x[1] = SIGMA[1]; x[2] = SIGMA[2]; x[3] = SIGMA[3];
  for (let i = 0; i < 8; i += 1) x[4 + i] = key32[i];
  for (let i = 0; i < 4; i += 1) x[12 + i] = le32(nonce16, i * 4);

  for (let i = 0; i < 20; i += 2) {
    qr(x, 0, 4, 8, 12); qr(x, 1, 5, 9, 13); qr(x, 2, 6, 10, 14); qr(x, 3, 7, 11, 15);
    qr(x, 0, 5, 10, 15); qr(x, 1, 6, 11, 12); qr(x, 2, 7, 8, 13); qr(x, 3, 4, 9, 14);
  }

  const out = new Uint8Array(32);
  const take = [x[0], x[1], x[2], x[3], x[12], x[13], x[14], x[15]];
  take.forEach((v, i) => {
    out[i * 4] = v & 0xff;
    out[i * 4 + 1] = (v >>> 8) & 0xff;
    out[i * 4 + 2] = (v >>> 16) & 0xff;
    out[i * 4 + 3] = (v >>> 24) & 0xff;
  });
  return out;
}

/* --------------------------------------------------------------------------
   Poly1305
   -------------------------------------------------------------------------- */

class Poly1305 {
  constructor(key) {
    this.buffer = new Uint8Array(16);
    this.leftover = 0;
    this.h = new Uint16Array(10);
    this.r = new Uint16Array(10);
    this.pad = new Uint16Array(8);
    this.finished = false;

    const t = new Uint16Array(8);
    for (let i = 0; i < 8; i += 1) t[i] = key[i * 2] | (key[i * 2 + 1] << 8);

    // Clamp r as the spec requires, spread across 13-bit limbs.
    this.r[0] = t[0] & 0x1fff;
    this.r[1] = ((t[0] >>> 13) | (t[1] << 3)) & 0x1fff;
    this.r[2] = ((t[1] >>> 10) | (t[2] << 6)) & 0x1f03;
    this.r[3] = ((t[2] >>> 7) | (t[3] << 9)) & 0x1fff;
    this.r[4] = ((t[3] >>> 4) | (t[4] << 12)) & 0x00ff;
    this.r[5] = (t[4] >>> 1) & 0x1ffe;
    this.r[6] = ((t[4] >>> 14) | (t[5] << 2)) & 0x1fff;
    this.r[7] = ((t[5] >>> 11) | (t[6] << 5)) & 0x1f81;
    this.r[8] = ((t[6] >>> 8) | (t[7] << 8)) & 0x1fff;
    this.r[9] = (t[7] >>> 5) & 0x007f;

    for (let i = 0; i < 8; i += 1) this.pad[i] = key[16 + i * 2] | (key[17 + i * 2] << 8);
  }

  blocks(m, mpos, bytes) {
    const hibit = this.finished ? 0 : 1 << 11;
    const h = this.h;
    const r = this.r;
    const d = new Uint32Array(10);

    while (bytes >= 16) {
      const t = new Uint16Array(8);
      for (let i = 0; i < 8; i += 1) t[i] = m[mpos + i * 2] | (m[mpos + i * 2 + 1] << 8);

      h[0] += t[0] & 0x1fff;
      h[1] += ((t[0] >>> 13) | (t[1] << 3)) & 0x1fff;
      h[2] += ((t[1] >>> 10) | (t[2] << 6)) & 0x1fff;
      h[3] += ((t[2] >>> 7) | (t[3] << 9)) & 0x1fff;
      h[4] += ((t[3] >>> 4) | (t[4] << 12)) & 0x1fff;
      h[5] += (t[4] >>> 1) & 0x1fff;
      h[6] += ((t[4] >>> 14) | (t[5] << 2)) & 0x1fff;
      h[7] += ((t[5] >>> 11) | (t[6] << 5)) & 0x1fff;
      h[8] += ((t[6] >>> 8) | (t[7] << 8)) & 0x1fff;
      h[9] += (t[7] >>> 5) | hibit;

      let c = 0;
      for (let i = 0; i < 10; i += 1) {
        d[i] = c;
        for (let j = 0; j < 10; j += 1) {
          // Limbs past our own index wrap with the field's 5x reduction.
          d[i] += h[j] * (j <= i ? r[i - j] : 5 * r[i + 10 - j]);
          // Fold partway through to keep every product inside 2^53.
          if (j === 4) {
            c = d[i] >>> 13;
            d[i] &= 0x1fff;
          }
        }
        c += d[i] >>> 13;
        d[i] &= 0x1fff;
      }
      c = (c << 2) + c;
      c += d[0];
      d[0] = c & 0x1fff;
      c >>>= 13;
      d[1] += c;

      for (let i = 0; i < 10; i += 1) h[i] = d[i];

      mpos += 16;
      bytes -= 16;
    }
  }

  update(m) {
    let mpos = 0;
    let bytes = m.length;

    if (this.leftover) {
      let want = Math.min(16 - this.leftover, bytes);
      for (let i = 0; i < want; i += 1) this.buffer[this.leftover + i] = m[mpos + i];
      bytes -= want;
      mpos += want;
      this.leftover += want;
      if (this.leftover < 16) return this;
      this.blocks(this.buffer, 0, 16);
      this.leftover = 0;
    }

    if (bytes >= 16) {
      const want = bytes - (bytes % 16);
      this.blocks(m, mpos, want);
      mpos += want;
      bytes -= want;
    }

    for (let i = 0; i < bytes; i += 1) this.buffer[this.leftover + i] = m[mpos + i];
    this.leftover += bytes;
    return this;
  }

  digest() {
    const h = this.h;
    const g = new Uint16Array(10);

    if (this.leftover) {
      let i = this.leftover;
      this.buffer[i++] = 1;
      for (; i < 16; i += 1) this.buffer[i] = 0;
      this.finished = true;
      this.blocks(this.buffer, 0, 16);
    }

    let c = h[1] >>> 13;
    h[1] &= 0x1fff;
    for (let i = 2; i < 10; i += 1) {
      h[i] += c;
      c = h[i] >>> 13;
      h[i] &= 0x1fff;
    }
    h[0] += c * 5;
    c = h[0] >>> 13;
    h[0] &= 0x1fff;
    h[1] += c;
    c = h[1] >>> 13;
    h[1] &= 0x1fff;
    h[2] += c;

    // g = h + 5; if g overflowed 2^130 then g is the reduced value.
    g[0] = h[0] + 5;
    c = g[0] >>> 13;
    g[0] &= 0x1fff;
    for (let i = 1; i < 10; i += 1) {
      g[i] = h[i] + c;
      c = g[i] >>> 13;
      g[i] &= 0x1fff;
    }
    g[9] -= 1 << 13;

    // Constant-time select between h and g.
    let mask = (c ^ 1) - 1;
    for (let i = 0; i < 10; i += 1) g[i] &= mask;
    mask = ~mask;
    for (let i = 0; i < 10; i += 1) h[i] = (h[i] & mask) | g[i];

    h[0] = (h[0] | (h[1] << 13)) & 0xffff;
    h[1] = ((h[1] >>> 3) | (h[2] << 10)) & 0xffff;
    h[2] = ((h[2] >>> 6) | (h[3] << 7)) & 0xffff;
    h[3] = ((h[3] >>> 9) | (h[4] << 4)) & 0xffff;
    h[4] = ((h[4] >>> 12) | (h[5] << 1) | (h[6] << 14)) & 0xffff;
    h[5] = ((h[6] >>> 2) | (h[7] << 11)) & 0xffff;
    h[6] = ((h[7] >>> 5) | (h[8] << 8)) & 0xffff;
    h[7] = ((h[8] >>> 8) | (h[9] << 5)) & 0xffff;

    let f = h[0] + this.pad[0];
    h[0] = f & 0xffff;
    for (let i = 1; i < 8; i += 1) {
      f = (((h[i] + this.pad[i]) | 0) + (f >>> 16)) | 0;
      h[i] = f & 0xffff;
    }

    const mac = new Uint8Array(16);
    for (let i = 0; i < 8; i += 1) {
      mac[i * 2] = h[i] & 0xff;
      mac[i * 2 + 1] = (h[i] >>> 8) & 0xff;
    }
    return mac;
  }
}

export function poly1305(key, message) {
  return new Poly1305(key).update(message).digest();
}

/* --------------------------------------------------------------------------
   AEAD
   -------------------------------------------------------------------------- */

const PAD16 = new Uint8Array(16);

/** Length-prefixed MAC input exactly as RFC 8439 §2.8 specifies. */
function macData(aad, ciphertext) {
  const aadPad = (16 - (aad.length % 16)) % 16;
  const ctPad = (16 - (ciphertext.length % 16)) % 16;
  const out = new Uint8Array(aad.length + aadPad + ciphertext.length + ctPad + 16);
  let o = 0;
  out.set(aad, o); o += aad.length + aadPad;
  out.set(ciphertext, o); o += ciphertext.length + ctPad;

  const view = new DataView(out.buffer, out.byteOffset + o, 16);
  view.setUint32(0, aad.length >>> 0, true);
  view.setUint32(4, Math.floor(aad.length / 2 ** 32), true);
  view.setUint32(8, ciphertext.length >>> 0, true);
  view.setUint32(12, Math.floor(ciphertext.length / 2 ** 32), true);
  return out;
}

/** Variable-time compare is a real vulnerability here — always use this one. */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * @param key 32 bytes, nonce 12 bytes.
 * @returns ciphertext with the 16-byte tag appended.
 */
export function aeadEncrypt(key, nonce, plaintext, aad = PAD16.subarray(0, 0)) {
  const polyKey = chacha20Block(key, 0, nonce).subarray(0, 32);
  const ciphertext = chacha20(key, nonce, plaintext, 1);
  const tag = poly1305(polyKey, macData(aad, ciphertext));

  const out = new Uint8Array(ciphertext.length + 16);
  out.set(ciphertext);
  out.set(tag, ciphertext.length);
  return out;
}

/** @returns the plaintext, or null if the tag does not verify. Never throws. */
export function aeadDecrypt(key, nonce, sealed, aad = PAD16.subarray(0, 0)) {
  if (!sealed || sealed.length < 16) return null;
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);

  const polyKey = chacha20Block(key, 0, nonce).subarray(0, 32);
  const expected = poly1305(polyKey, macData(aad, ciphertext));
  if (!timingSafeEqual(tag, expected)) return null;

  return chacha20(key, nonce, ciphertext, 1);
}

/* --- XChaCha20-Poly1305 (24-byte nonce) ----------------------------------- */

function xSplit(key, nonce24) {
  const subkey = hchacha20(key, nonce24.subarray(0, 16));
  const nonce12 = new Uint8Array(12);
  nonce12.set(nonce24.subarray(16, 24), 4);
  return { subkey, nonce12 };
}

/**
 * The 24-byte nonce means a randomly generated nonce is safe: at 2^-96
 * collision probability we never have to maintain a per-peer counter, which
 * removes an entire family of nonce-reuse bugs from the protocol above.
 */
export function xaeadEncrypt(key, nonce24, plaintext, aad) {
  const { subkey, nonce12 } = xSplit(key, nonce24);
  return aeadEncrypt(subkey, nonce12, plaintext, aad);
}

export function xaeadDecrypt(key, nonce24, sealed, aad) {
  const { subkey, nonce12 } = xSplit(key, nonce24);
  return aeadDecrypt(subkey, nonce12, sealed, aad);
}

export default { aeadEncrypt, aeadDecrypt, xaeadEncrypt, xaeadDecrypt, chacha20, poly1305 };
