/**
 * qr-decode.js — a QR Code decoder, for reading a pairing code out of a picture.
 *
 * The pairing flow lets a cousin hand a code over as an image: a screenshot, a
 * saved photo, something forwarded through the family chat. The obvious answer
 * would be the platform's BarcodeDetector, but it does not exist on Linux
 * Chromium and it does not exist on iOS Safari, so on a good share of the
 * family's devices there is simply nothing to call. This is the fallback, and
 * because it is the fallback it has to cope with real pictures — uneven light,
 * a bit of blur, a phone held slightly off square — rather than only with the
 * clean renders our own encoder produces.
 *
 * The spec tables here are a second copy of the ones in qr.js. That module is
 * verified against an independent decoder and is deliberately left untouched;
 * it exports the encoder, not its tables. Two copies of a fixed table from a
 * published standard is a cheaper problem than editing verified code.
 *
 * Failure is expressed internally by throwing Unreadable. The pipeline is a
 * dozen stages deep and threading a null back up through every one of them
 * buries the actual logic; the two exported functions catch everything and
 * return null, so nothing escapes.
 */

/* --------------------------------------------------------------------------
   Spec tables
   -------------------------------------------------------------------------- */

// Indexed [eclIndex][version]; version 0 is unused padding. Order is L, M, Q, H.
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

// The two-bit format field is not in L/M/Q/H order; this maps it back.
const ECL_INDEX_FROM_BITS = { 0b01: 0, 0b00: 1, 0b11: 2, 0b10: 3 };

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function alignmentPositions(version) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 10; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

class Unreadable extends Error {}

const bail = (why) => {
  throw new Unreadable(why);
};

/* --------------------------------------------------------------------------
   GF(256) and Reed–Solomon decoding
   -------------------------------------------------------------------------- */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    // 0x11d is the QR field's primitive polynomial.
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);
const gfDiv = (a, b) => (a === 0 ? 0 : GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255]);

/** Horner evaluation of a polynomial given highest degree first. */
function polyEval(poly, x) {
  let y = poly[0];
  for (let i = 1; i < poly.length; i += 1) y = gfMul(y, x) ^ poly[i];
  return y;
}

/**
 * Berlekamp–Massey over the syndromes, in ascending-degree form: lambda[0] is
 * always 1 and lambda[j] is the coefficient of x^j. Returns the locator
 * trimmed to its actual degree.
 */
function errorLocator(syndromes) {
  const nsym = syndromes.length;
  let lambda = new Uint8Array(nsym + 1);
  let previous = new Uint8Array(nsym + 1);
  lambda[0] = 1;
  previous[0] = 1;
  let degree = 0;
  let shift = 1;
  let lastDiscrepancy = 1;

  for (let n = 0; n < nsym; n += 1) {
    let discrepancy = syndromes[n];
    for (let i = 1; i <= degree; i += 1) {
      discrepancy ^= gfMul(lambda[i], syndromes[n - i]);
    }
    if (discrepancy === 0) {
      shift += 1;
      continue;
    }
    const scale = gfDiv(discrepancy, lastDiscrepancy);
    const updated = Uint8Array.from(lambda);
    for (let i = 0; i + shift < updated.length; i += 1) {
      updated[i + shift] ^= gfMul(scale, previous[i]);
    }
    if (2 * degree <= n) {
      previous = lambda;
      lastDiscrepancy = discrepancy;
      degree = n + 1 - degree;
      shift = 1;
    } else {
      shift += 1;
    }
    lambda = updated;
  }

  let top = lambda.length - 1;
  while (top > 0 && lambda[top] === 0) top -= 1;
  if (top !== degree) bail("error locator degree disagrees with error count");
  return lambda.subarray(0, degree + 1);
}

/**
 * Correct a received block in place. `nsym` is the number of parity codewords;
 * up to nsym/2 wrong codewords are recoverable. Anything beyond that has to be
 * refused rather than guessed at, so the syndromes are recomputed at the end
 * and a block that is still inconsistent is rejected.
 */
function rsCorrect(block, nsym) {
  const syndromes = new Uint8Array(nsym);
  let clean = true;
  for (let i = 0; i < nsym; i += 1) {
    syndromes[i] = polyEval(block, GF_EXP[i]);
    if (syndromes[i] !== 0) clean = false;
  }
  if (clean) return 0;

  const lambda = errorLocator(syndromes);
  const count = lambda.length - 1;
  if (count === 0 || count * 2 > nsym) bail("too many errors to correct");

  // Chien search: position p is in error when lambda(alpha^-p) is zero.
  const positions = [];
  for (let p = 0; p < block.length; p += 1) {
    let sum = 0;
    const root = GF_EXP[(255 - p) % 255];
    let power = 1;
    for (let i = 0; i < lambda.length; i += 1) {
      sum ^= gfMul(lambda[i], power);
      power = gfMul(power, root);
    }
    if (sum === 0) positions.push(p);
  }
  if (positions.length !== count) bail("error locator roots do not match its degree");

  // Forney: omega = syndromes * lambda truncated at x^nsym, then each
  // magnitude is X * omega(X^-1) / lambda'(X^-1).
  const omega = new Uint8Array(nsym);
  for (let i = 0; i < nsym; i += 1) {
    let sum = 0;
    for (let j = 0; j <= i && j < lambda.length; j += 1) {
      sum ^= gfMul(syndromes[i - j], lambda[j]);
    }
    omega[i] = sum;
  }

  for (const p of positions) {
    const locator = GF_EXP[p % 255];
    const inverse = GF_EXP[(255 - (p % 255)) % 255];

    let numerator = 0;
    let power = 1;
    for (let i = 0; i < omega.length; i += 1) {
      numerator ^= gfMul(omega[i], power);
      power = gfMul(power, inverse);
    }

    // Formal derivative in characteristic 2: only the odd-degree terms survive.
    let denominator = 0;
    power = 1;
    for (let i = 1; i < lambda.length; i += 2) {
      denominator ^= gfMul(lambda[i], power);
      power = gfMul(power, gfMul(inverse, inverse));
    }
    if (denominator === 0) bail("Forney denominator vanished");

    const magnitude = gfMul(locator, gfDiv(numerator, denominator));
    const index = block.length - 1 - p;
    if (index < 0) bail("error located outside the block");
    block[index] ^= magnitude;
  }

  for (let i = 0; i < nsym; i += 1) {
    if (polyEval(block, GF_EXP[i]) !== 0) bail("block still inconsistent after correction");
  }
  return count;
}

/* --------------------------------------------------------------------------
   Reading the codeword stream out of a matrix
   -------------------------------------------------------------------------- */

/**
 * Mark every module the data stream must skip: finders and their separators,
 * timing lines, alignment patterns, the format areas, the dark module and, from
 * version 7, the version blocks. This has to agree exactly with what the
 * encoder reserved, or the zigzag walks off by one and nothing decodes.
 */
function functionMap(version) {
  const size = version * 4 + 17;
  const map = Array.from({ length: size }, () => new Uint8Array(size));
  const mark = (x, y) => {
    if (x >= 0 && y >= 0 && x < size && y < size) map[y][x] = 1;
  };

  for (let i = 0; i < size; i += 1) {
    mark(6, i);
    mark(i, 6);
  }

  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) mark(cx + dx, cy + dy);
    }
  }

  const positions = alignmentPositions(version);
  positions.forEach((cy, i) => {
    positions.forEach((cx, j) => {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === positions.length - 1) ||
        (i === positions.length - 1 && j === 0);
      if (corner) return;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) mark(cx + dx, cy + dy);
      }
    });
  });

  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      mark(i, 8);
      mark(8, i);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    mark(size - 1 - i, 8);
    mark(8, size - 1 - i);
  }
  mark(8, size - 8);

  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      mark((i % 3) + size - 11, Math.floor(i / 3));
      mark(Math.floor(i / 3), (i % 3) + size - 11);
    }
  }

  return map;
}

/** BCH remainder, shared by the format and version fields. */
function bch(value, generator, degree) {
  let rem = value << degree;
  const genBits = 32 - Math.clz32(generator);
  for (let i = 32 - Math.clz32(rem); i >= genBits; i -= 1) {
    if ((rem >> (i - 1)) & 1) rem ^= generator << (i - genBits);
  }
  return rem & ((1 << degree) - 1);
}

const FORMAT_CODES = Array.from({ length: 32 }, (_, d) => (d << 10) | bch(d, 0x537, 10));

const popcount = (v) => {
  let n = v;
  let bits = 0;
  while (n) {
    bits += n & 1;
    n >>>= 1;
  }
  return bits;
};

/**
 * Both copies of the format field are read and BCH-corrected independently; the
 * one that needed fewer bits flipped is trusted first. Keeping the runner-up
 * matters because a damaged copy can still correct to something plausible, and
 * the caller can fall back to it when the first reading fails to decode.
 */
function readFormatCandidates(modules) {
  const size = modules.length;
  const copyA = [];
  for (let i = 0; i <= 5; i += 1) copyA.push([8, i]);
  copyA.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i += 1) copyA.push([14 - i, 8]);

  const copyB = [];
  for (let i = 0; i < 8; i += 1) copyB.push([size - 1 - i, 8]);
  for (let i = 8; i < 15; i += 1) copyB.push([8, size - 15 + i]);

  const gather = (cells) => {
    let bits = 0;
    cells.forEach(([x, y], i) => {
      if (modules[y][x]) bits |= 1 << i;
    });
    return bits ^ 0x5412;
  };

  const results = [];
  for (const raw of [gather(copyA), gather(copyB)]) {
    let best = -1;
    let bestDistance = 32;
    for (let d = 0; d < 32; d += 1) {
      const distance = popcount(raw ^ FORMAT_CODES[d]);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = d;
      }
    }
    // Three flipped bits is the guaranteed-correctable limit for this BCH code.
    if (bestDistance <= 3) {
      results.push({ eclIndex: ECL_INDEX_FROM_BITS[best >> 3], mask: best & 7, distance: bestDistance });
    }
  }

  results.sort((a, b) => a.distance - b.distance);
  return results.filter(
    (candidate, i) =>
      results.findIndex((o) => o.eclIndex === candidate.eclIndex && o.mask === candidate.mask) === i
  );
}

/** Zigzag walk, skipping function modules and undoing the mask as it goes. */
function readCodewords(modules, version, mask) {
  const size = modules.length;
  const skip = functionMap(version);
  const maskFn = MASKS[mask];
  const total = Math.floor(rawDataModules(version) / 8);
  const codewords = new Uint8Array(total);
  let index = 0;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (skip[y][x]) continue;
        if (index < total * 8) {
          const bit = modules[y][x] ^ (maskFn(x, y) ? 1 : 0);
          if (bit) codewords[index >>> 3] |= 0x80 >>> (index & 7);
        }
        index += 1;
      }
    }
  }

  return codewords;
}

/**
 * Undo the interleaving, correct each block, and return the data codewords
 * back-to-back. The interleave exists so that a scratch across the symbol
 * becomes one or two bad codewords in many blocks rather than a burst that
 * destroys a single one; de-interleaving is simply that mapping read backwards.
 */
function deinterleaveAndCorrect(stream, version, eclIndex) {
  const numBlocks = NUM_BLOCKS[eclIndex][version];
  const eccLen = ECC_PER_BLOCK[eclIndex][version];
  const totalCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlockLen = Math.floor(totalCodewords / numBlocks) - eccLen;
  const numShortBlocks = numBlocks - (totalCodewords % numBlocks);

  const blocks = [];
  for (let b = 0; b < numBlocks; b += 1) {
    const dataLen = shortBlockLen + (b < numShortBlocks ? 0 : 1);
    blocks.push(new Uint8Array(dataLen + eccLen));
  }

  let index = 0;
  for (let i = 0; i < shortBlockLen + 1; i += 1) {
    for (let b = 0; b < numBlocks; b += 1) {
      if (i < shortBlockLen || b >= numShortBlocks) blocks[b][i] = stream[index++];
    }
  }
  for (let i = 0; i < eccLen; i += 1) {
    for (let b = 0; b < numBlocks; b += 1) {
      blocks[b][blocks[b].length - eccLen + i] = stream[index++];
    }
  }

  const out = [];
  for (const block of blocks) {
    rsCorrect(block, eccLen);
    for (let i = 0; i < block.length - eccLen; i += 1) out.push(block[i]);
  }
  return Uint8Array.from(out);
}

/* --------------------------------------------------------------------------
   Segments
   -------------------------------------------------------------------------- */

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.position = 0;
  }
  get remaining() {
    return this.bytes.length * 8 - this.position;
  }
  read(count) {
    if (count > this.remaining) bail("ran out of data bits");
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const at = this.position + i;
      value = (value << 1) | ((this.bytes[at >>> 3] >>> (7 - (at & 7))) & 1);
    }
    this.position += count;
    return value;
  }
}

/** Character-count field widths, by mode and version band. */
function countBits(mode, version) {
  const band = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  if (mode === 1) return [10, 12, 14][band];
  if (mode === 2) return [9, 11, 13][band];
  if (mode === 4) return [8, 16, 16][band];
  if (mode === 8) return [8, 10, 12][band];
  return bail(`unsupported mode ${mode}`);
}

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });
const LATIN1 = new TextDecoder("iso-8859-1");

/**
 * Byte segments are decoded as UTF-8, which is what everything we generate uses
 * and what most other apps emit in practice. The spec's nominal default is
 * ISO-8859-1 though, so an invalid UTF-8 sequence falls back to that rather
 * than producing a string full of replacement characters.
 */
function bytesToText(bytes) {
  const array = Uint8Array.from(bytes);
  try {
    return UTF8_STRICT.decode(array);
  } catch {
    return LATIN1.decode(array);
  }
}

function parseSegments(data, version) {
  const reader = new BitReader(data);
  let text = "";
  let pending = [];
  const flush = () => {
    if (pending.length) {
      text += bytesToText(pending);
      pending = [];
    }
  };

  while (reader.remaining >= 4) {
    const mode = reader.read(4);
    if (mode === 0) break; // terminator

    if (mode === 7) {
      // ECI. The assignment number is a 1-, 2- or 3-byte designator; we do not
      // switch character set on it, we only need to step over it cleanly.
      const first = reader.read(8);
      if ((first & 0x80) === 0) {
        // one byte, nothing further
      } else if ((first & 0xc0) === 0x80) reader.read(8);
      else if ((first & 0xe0) === 0xc0) reader.read(16);
      else bail("malformed ECI designator");
      continue;
    }

    const count = reader.read(countBits(mode, version));

    if (mode === 4) {
      if (count * 8 > reader.remaining) bail("byte segment longer than the data");
      for (let i = 0; i < count; i += 1) pending.push(reader.read(8));
    } else if (mode === 1) {
      flush();
      let left = count;
      while (left >= 3) {
        const value = reader.read(10);
        if (value > 999) bail("numeric triple out of range");
        text += String(value).padStart(3, "0");
        left -= 3;
      }
      if (left === 2) {
        const value = reader.read(7);
        if (value > 99) bail("numeric pair out of range");
        text += String(value).padStart(2, "0");
      } else if (left === 1) {
        const value = reader.read(4);
        if (value > 9) bail("numeric digit out of range");
        text += String(value);
      }
    } else if (mode === 2) {
      flush();
      let left = count;
      while (left >= 2) {
        const value = reader.read(11);
        if (value > 44 * 45 + 44) bail("alphanumeric pair out of range");
        text += ALNUM[Math.floor(value / 45)] + ALNUM[value % 45];
        left -= 2;
      }
      if (left === 1) {
        const value = reader.read(6);
        if (value > 44) bail("alphanumeric character out of range");
        text += ALNUM[value];
      }
    } else {
      // Kanji and structured append are not something the family app emits and
      // guessing at them would risk returning plausible nonsense.
      bail(`unhandled mode ${mode}`);
    }
  }

  flush();
  // Detection tries a good many grids before it gives up, and the empty string
  // is the one result a caller cannot tell apart from a failure. A symbol that
  // carries nothing is refused rather than reported as a successful read of
  // nothing, so a stray grid that happens to survive the checks cannot pass.
  if (text.length === 0) bail("no content");
  return text;
}

/* --------------------------------------------------------------------------
   Matrix decoding
   -------------------------------------------------------------------------- */

function rotateMatrix(modules) {
  const size = modules.length;
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => modules[size - 1 - x][y])
  );
}

function readSymbol(modules) {
  const size = modules.length;
  if (size < 21 || size > 177 || size % 4 !== 1) bail("implausible symbol size");
  const version = (size - 17) / 4;

  const candidates = readFormatCandidates(modules);
  if (candidates.length === 0) bail("format information unreadable");

  let lastError = null;
  for (const { eclIndex, mask } of candidates) {
    try {
      const stream = readCodewords(modules, version, mask);
      const data = deinterleaveAndCorrect(stream, version, eclIndex);
      return parseSegments(data, version);
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Try the grid as sampled, then the three rotations. A photo taken sideways is
 * ordinary, and rotating the grid is far cheaper than re-running detection.
 */
function decodeMatrix(modules) {
  let grid = modules;
  for (let turn = 0; turn < 4; turn += 1) {
    try {
      return readSymbol(grid);
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
    }
    grid = rotateMatrix(grid);
  }
  return null;
}

/* --------------------------------------------------------------------------
   Image preparation
   -------------------------------------------------------------------------- */

/**
 * Luma, composited over white where the source is not opaque.
 *
 * The compositing is not fussiness about alpha blending: plenty of QR
 * generators save a PNG with a transparent background rather than a white one,
 * and drawing that onto a fresh canvas leaves the light modules at RGB 0,0,0
 * with only the alpha channel telling them from the dark ones. Ignore alpha and
 * the whole symbol reads as one solid black square. White is the right
 * background to assume — a code meant to sit on a dark one still comes out
 * dark-on-light, which is the pass we try first anyway.
 *
 * The blend runs unconditionally rather than behind an "opaque?" test. It is
 * exact for alpha 255, and skipping the branch measures faster than taking it:
 * the two arms make the store polymorphic, which costs more than the multiply.
 */
function toGreyscale(data, width, height) {
  const grey = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < grey.length; i += 1, p += 4) {
    // Integer luma, the usual Rec. 601 weights.
    const luma = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    const alpha = data[p + 3];
    grey[i] = (luma * alpha + 255 * (255 - alpha)) / 255;
  }
  return grey;
}

/** Otsu's threshold, used only when the image is too small to block up. */
function globalThreshold(grey) {
  const histogram = new Int32Array(256);
  for (const value of grey) histogram[value] += 1;
  const total = grey.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i];

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let bestVariance = -1;
  for (let t = 0; t < 256; t += 1) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = t;
    }
  }
  return best;
}

const BLOCK = 8;
const BLOCK_SHIFT = 3;
// Below this spread a block is treated as a single flat colour rather than as
// something with both light and dark modules in it.
const MIN_DYNAMIC_RANGE = 24;

/**
 * Local, block-based binarisation. A single global threshold falls apart on a
 * photo: a shadow across one corner drags that corner below the threshold and
 * the whole side of the symbol reads as dark. Instead each 8x8 block gets its
 * own average, those averages are smoothed over a 5x5 neighbourhood of blocks
 * so a block that happens to be all-dark inherits a sane level from its
 * surroundings, and pixels are compared against that.
 *
 * Returns 1 for dark. `invert` flips the source first, which is how a
 * light-on-dark picture is handled without a second code path.
 */
function binarise(grey, width, height, invert) {
  const source = invert ? Uint8ClampedArray.from(grey, (v) => 255 - v) : grey;
  const bits = new Uint8Array(width * height);

  if (width < BLOCK * 5 || height < BLOCK * 5) {
    const threshold = globalThreshold(source);
    for (let i = 0; i < bits.length; i += 1) bits[i] = source[i] <= threshold ? 1 : 0;
    return bits;
  }

  const blocksX = Math.ceil(width / BLOCK);
  const blocksY = Math.ceil(height / BLOCK);
  const levels = new Int32Array(blocksX * blocksY);

  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      const x0 = Math.min(bx << BLOCK_SHIFT, width - BLOCK);
      const y0 = Math.min(by << BLOCK_SHIFT, height - BLOCK);
      let sum = 0;
      let min = 255;
      let max = 0;
      for (let y = 0; y < BLOCK; y += 1) {
        const row = (y0 + y) * width + x0;
        for (let x = 0; x < BLOCK; x += 1) {
          const value = source[row + x];
          sum += value;
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
      let level;
      if (max - min > MIN_DYNAMIC_RANGE) {
        level = sum >> (BLOCK_SHIFT * 2);
      } else {
        // Flat block: assume it is all background, but let a dark neighbour
        // pull the level up so the inside of a big dark area stays dark.
        level = max >> 1;
        if (by > 0 && bx > 0) {
          const neighbour =
            (levels[(by - 1) * blocksX + bx] +
              2 * levels[by * blocksX + bx - 1] +
              levels[(by - 1) * blocksX + bx - 1]) /
            4;
          if (min < neighbour) level = neighbour;
        }
      }
      levels[by * blocksX + bx] = level;
    }
  }

  for (let by = 0; by < blocksY; by += 1) {
    const top = Math.max(0, Math.min(by, blocksY - 3) - 2);
    for (let bx = 0; bx < blocksX; bx += 1) {
      const left = Math.max(0, Math.min(bx, blocksX - 3) - 2);
      let sum = 0;
      let count = 0;
      for (let y = top; y < Math.min(blocksY, top + 5); y += 1) {
        for (let x = left; x < Math.min(blocksX, left + 5); x += 1) {
          sum += levels[y * blocksX + x];
          count += 1;
        }
      }
      const threshold = sum / count;
      const x0 = Math.min(bx << BLOCK_SHIFT, width - BLOCK);
      const y0 = Math.min(by << BLOCK_SHIFT, height - BLOCK);
      for (let y = 0; y < BLOCK; y += 1) {
        const row = (y0 + y) * width + x0;
        for (let x = 0; x < BLOCK; x += 1) {
          bits[row + x] = source[row + x] <= threshold ? 1 : 0;
        }
      }
    }
  }

  return bits;
}

/* --------------------------------------------------------------------------
   Finding the finder patterns
   -------------------------------------------------------------------------- */

/** The 1:1:3:1:1 test, with half a module of slack on each run. */
function isFinderRatio(counts) {
  let total = 0;
  for (let i = 0; i < 5; i += 1) {
    if (counts[i] === 0) return false;
    total += counts[i];
  }
  if (total < 7) return false;
  const moduleSize = total / 7;
  const slack = moduleSize / 2;
  return (
    Math.abs(moduleSize - counts[0]) < slack &&
    Math.abs(moduleSize - counts[1]) < slack &&
    Math.abs(3 * moduleSize - counts[2]) < 3 * slack &&
    Math.abs(moduleSize - counts[3]) < slack &&
    Math.abs(moduleSize - counts[4]) < slack
  );
}

const centreFromEnd = (counts, end) => end - counts[4] - counts[3] - counts[2] / 2;

/**
 * A horizontal 1:1:3:1:1 hit is cheap and common — text and borders produce
 * them constantly. Confirming the same ratio vertically through the candidate
 * centre is what separates a finder pattern from a coincidence.
 */
function findFinders(bits, width, height) {
  const at = (x, y) => bits[y * width + x];
  const centres = [];

  const crossCheckVertical = (startY, centreX, maxCount, originalTotal) => {
    const counts = [0, 0, 0, 0, 0];
    let y = startY;
    while (y >= 0 && at(centreX, y)) {
      counts[2] += 1;
      y -= 1;
    }
    if (y < 0) return NaN;
    while (y >= 0 && !at(centreX, y) && counts[1] <= maxCount) {
      counts[1] += 1;
      y -= 1;
    }
    if (y < 0 || counts[1] > maxCount) return NaN;
    while (y >= 0 && at(centreX, y) && counts[0] <= maxCount) {
      counts[0] += 1;
      y -= 1;
    }
    if (counts[0] > maxCount) return NaN;

    y = startY + 1;
    while (y < height && at(centreX, y)) {
      counts[2] += 1;
      y += 1;
    }
    if (y === height) return NaN;
    while (y < height && !at(centreX, y) && counts[3] < maxCount) {
      counts[3] += 1;
      y += 1;
    }
    if (y === height || counts[3] >= maxCount) return NaN;
    while (y < height && at(centreX, y) && counts[4] < maxCount) {
      counts[4] += 1;
      y += 1;
    }
    if (counts[4] >= maxCount) return NaN;

    const total = counts.reduce((a, b) => a + b, 0);
    if (5 * Math.abs(total - originalTotal) >= 2 * originalTotal) return NaN;
    return isFinderRatio(counts) ? centreFromEnd(counts, y) : NaN;
  };

  const crossCheckHorizontal = (startX, centreY, maxCount, originalTotal) => {
    const counts = [0, 0, 0, 0, 0];
    let x = startX;
    while (x >= 0 && at(x, centreY)) {
      counts[2] += 1;
      x -= 1;
    }
    if (x < 0) return NaN;
    while (x >= 0 && !at(x, centreY) && counts[1] <= maxCount) {
      counts[1] += 1;
      x -= 1;
    }
    if (x < 0 || counts[1] > maxCount) return NaN;
    while (x >= 0 && at(x, centreY) && counts[0] <= maxCount) {
      counts[0] += 1;
      x -= 1;
    }
    if (counts[0] > maxCount) return NaN;

    x = startX + 1;
    while (x < width && at(x, centreY)) {
      counts[2] += 1;
      x += 1;
    }
    if (x === width) return NaN;
    while (x < width && !at(x, centreY) && counts[3] < maxCount) {
      counts[3] += 1;
      x += 1;
    }
    if (x === width || counts[3] >= maxCount) return NaN;
    while (x < width && at(x, centreY) && counts[4] < maxCount) {
      counts[4] += 1;
      x += 1;
    }
    if (counts[4] >= maxCount) return NaN;

    const total = counts.reduce((a, b) => a + b, 0);
    if (5 * Math.abs(total - originalTotal) >= originalTotal) return NaN;
    return isFinderRatio(counts) ? centreFromEnd(counts, x) : NaN;
  };

  const record = (counts, row, end) => {
    const total = counts.reduce((a, b) => a + b, 0);
    let x = centreFromEnd(counts, end);
    const y = crossCheckVertical(row, Math.floor(x), counts[2], total);
    if (Number.isNaN(y)) return;
    x = crossCheckHorizontal(Math.floor(x), Math.floor(y), counts[2], total);
    if (Number.isNaN(x)) return;

    const moduleSize = total / 7;
    for (const centre of centres) {
      const near =
        Math.abs(y - centre.y) <= moduleSize &&
        Math.abs(x - centre.x) <= moduleSize &&
        (Math.abs(moduleSize - centre.size) <= 1 || Math.abs(moduleSize - centre.size) <= centre.size);
      if (near) {
        const n = centre.count + 1;
        centre.x = (centre.x * centre.count + x) / n;
        centre.y = (centre.y * centre.count + y) / n;
        centre.size = (centre.size * centre.count + moduleSize) / n;
        centre.count = n;
        return;
      }
    }
    centres.push({ x, y, size: moduleSize, count: 1 });
  };

  for (let y = 0; y < height; y += 1) {
    let counts = [0, 0, 0, 0, 0];
    let state = 0;
    for (let x = 0; x < width; x += 1) {
      if (at(x, y)) {
        if (state & 1) state += 1;
        counts[state] += 1;
      } else if ((state & 1) === 0) {
        if (state === 4) {
          if (isFinderRatio(counts)) record(counts, y, x);
          // Slide the window: the trailing light run may start the next hit.
          counts = [counts[2], counts[3], counts[4], 1, 0];
          state = 3;
        } else {
          state += 1;
          counts[state] += 1;
        }
      } else {
        counts[state] += 1;
      }
    }
    if (state === 4 && isFinderRatio(counts)) record(counts, y, width);
  }

  return centres;
}

/**
 * Pick plausible triples of finders. The three real ones sit on a right angle
 * with two equal legs and share a module size, so score every combination on
 * exactly that and hand back the best few — the runner-up matters when a busy
 * photo throws up a fourth candidate.
 */
function bestTriples(centres, limit) {
  const pool = [...centres].sort((a, b) => b.count - a.count).slice(0, 12);
  const scored = [];

  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      for (let k = j + 1; k < pool.length; k += 1) {
        const trio = [pool[i], pool[j], pool[k]];
        const sizes = trio.map((p) => p.size);
        const spread = (Math.max(...sizes) - Math.min(...sizes)) / Math.max(...sizes);

        let best = null;
        for (let corner = 0; corner < 3; corner += 1) {
          const tl = trio[corner];
          const rest = trio.filter((_, index) => index !== corner);
          const legA = distance(tl, rest[0]);
          const legB = distance(tl, rest[1]);
          const hyp = distance(rest[0], rest[1]);
          if (legA < 3 * tl.size || legB < 3 * tl.size) continue;
          const error =
            Math.abs(legA - legB) / Math.max(legA, legB) +
            Math.abs(hyp - Math.hypot(legA, legB)) / hyp;
          if (best === null || error < best.error) best = { error, tl, rest };
        }
        if (best === null) continue;

        // Image y runs downwards, so a positive cross product puts the first
        // arm on the top edge. A QR symbol is never mirrored.
        const [p, q] = best.rest;
        const cross =
          (p.x - best.tl.x) * (q.y - best.tl.y) - (p.y - best.tl.y) * (q.x - best.tl.x);
        const topRight = cross > 0 ? p : q;
        const bottomLeft = cross > 0 ? q : p;

        scored.push({
          score: best.error + spread,
          topLeft: best.tl,
          topRight,
          bottomLeft,
        });
      }
    }
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit);
}

/* --------------------------------------------------------------------------
   Alignment pattern
   -------------------------------------------------------------------------- */

/**
 * Look for the 1:1:1 light/dark/light run that marks the centre of an alignment
 * pattern, inside a window around where the geometry says it should be.
 *
 * Unlike a finder this is only one module wide at the middle, so ordinary data
 * throws up look-alikes constantly, and the guess it is searched around is
 * itself only a parallelogram estimate — under a real perspective it can sit
 * several modules out. Between those two facts the nearest hit is often not the
 * right one, so every hit is returned, ranked by distance from the guess, and
 * the caller works down the list.
 */
function findAlignments(bits, width, height, moduleSize, estimateX, estimateY, allowance) {
  const at = (x, y) => bits[y * width + x];
  const slack = allowance * moduleSize;
  const left = Math.max(0, Math.floor(estimateX - slack));
  const right = Math.min(width - 1, Math.ceil(estimateX + slack));
  const top = Math.max(0, Math.floor(estimateY - slack));
  const bottom = Math.min(height - 1, Math.ceil(estimateY + slack));
  if (right - left < moduleSize * 3 || bottom - top < moduleSize * 3) return [];

  const fits = (counts) => {
    const maxVariance = moduleSize / 2;
    return (
      Math.abs(counts[0] - moduleSize) < maxVariance &&
      Math.abs(counts[1] - moduleSize) < maxVariance &&
      Math.abs(counts[2] - moduleSize) < maxVariance
    );
  };

  const crossCheckVertical = (startY, centreX, maxCount, originalTotal) => {
    const counts = [0, 0, 0];
    let y = startY;
    while (y >= top && at(centreX, y) && counts[1] <= maxCount) {
      counts[1] += 1;
      y -= 1;
    }
    if (y < top || counts[1] > maxCount) return NaN;
    while (y >= top && !at(centreX, y) && counts[0] <= maxCount) {
      counts[0] += 1;
      y -= 1;
    }
    if (counts[0] > maxCount) return NaN;

    y = startY + 1;
    while (y <= bottom && at(centreX, y) && counts[1] <= maxCount) {
      counts[1] += 1;
      y += 1;
    }
    if (y > bottom || counts[1] > maxCount) return NaN;
    while (y <= bottom && !at(centreX, y) && counts[2] <= maxCount) {
      counts[2] += 1;
      y += 1;
    }
    if (counts[2] > maxCount) return NaN;

    const total = counts[0] + counts[1] + counts[2];
    if (5 * Math.abs(total - originalTotal) >= 2 * originalTotal) return NaN;
    return fits(counts) ? y - counts[2] - counts[1] / 2 : NaN;
  };

  const found = [];
  for (let y = top; y <= bottom; y += 1) {
    const counts = [0, 0, 0];
    // Runs are tracked as light, dark, light: the pattern's middle row reads
    // light ring, dark centre, light ring, and the run that closes it is the
    // dark ring beyond. Leading light is burnt off so the first run is real.
    let x = left;
    while (x <= right && !at(x, y)) x += 1;
    let state = 0;
    for (; x <= right; x += 1) {
      if (at(x, y)) {
        if (state === 1) {
          counts[1] += 1;
        } else if (state === 2) {
          if (fits(counts)) {
            const total = counts[0] + counts[1] + counts[2];
            const centreX = x - counts[2] - counts[1] / 2;
            const centreY = crossCheckVertical(y, Math.round(centreX), 2 * counts[1], total);
            if (!Number.isNaN(centreY)) found.push({ x: centreX, y: centreY });
          }
          counts[0] = counts[2];
          counts[1] = 1;
          counts[2] = 0;
          state = 1;
        } else {
          state = 1;
          counts[1] += 1;
        }
      } else if (state === 1) {
        state = 2;
        counts[2] += 1;
      } else {
        counts[state] += 1;
      }
    }
  }

  found.sort(
    (a, b) =>
      Math.hypot(a.x - estimateX, a.y - estimateY) - Math.hypot(b.x - estimateX, b.y - estimateY)
  );
  // Hits within a module of each other are the same pattern seen from two rows.
  return found.filter(
    (candidate, i) =>
      found.findIndex(
        (other) =>
          Math.abs(other.x - candidate.x) < moduleSize && Math.abs(other.y - candidate.y) < moduleSize
      ) === i
  );
}

/* --------------------------------------------------------------------------
   Perspective transform and grid sampling
   -------------------------------------------------------------------------- */

/**
 * Homography taking the unit square to the given quadrilateral, corners in the
 * order (0,0) (1,0) (1,1) (0,1). When the quad is a parallelogram the
 * projective terms vanish and this degenerates to a plain affine map, which is
 * exactly what we want when there is no alignment pattern to pin the far corner.
 */
function squareToQuad(p) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
  const dx3 = x0 - x1 + x2 - x3;
  const dy3 = y0 - y1 + y2 - y3;
  if (dx3 === 0 && dy3 === 0) {
    return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
  }
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const denominator = dx1 * dy2 - dx2 * dy1;
  if (denominator === 0) bail("degenerate quadrilateral");
  const g = (dx3 * dy2 - dx2 * dy3) / denominator;
  const h = (dx1 * dy3 - dx3 * dy1) / denominator;
  return [
    x1 - x0 + g * x1,
    x3 - x0 + h * x3,
    x0,
    y1 - y0 + g * y1,
    y3 - y0 + h * y3,
    y0,
    g,
    h,
    1,
  ];
}

/** Adjugate — the inverse up to a scale factor, which a homography ignores. */
function adjugate(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  return [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ];
}

function multiply(m, n) {
  const out = new Array(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[r * 3 + c] = m[r * 3] * n[c] + m[r * 3 + 1] * n[3 + c] + m[r * 3 + 2] * n[6 + c];
    }
  }
  return out;
}

const quadToQuad = (from, to) => multiply(squareToQuad(to), adjugate(squareToQuad(from)));

function project(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  if (w === 0) bail("point projected to infinity");
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

// Five taps per module: the centre plus the four quarter-points. A single tap
// is enough on a clean render but loses to salt-and-pepper noise on a photo.
const TAPS = [
  [0, 0],
  [-0.25, -0.25],
  [0.25, -0.25],
  [-0.25, 0.25],
  [0.25, 0.25],
];

function sampleGrid(bits, width, height, transform, dimension) {
  const modules = Array.from({ length: dimension }, () => new Array(dimension).fill(0));
  for (let y = 0; y < dimension; y += 1) {
    for (let x = 0; x < dimension; x += 1) {
      let dark = 0;
      for (const [dx, dy] of TAPS) {
        const [px, py] = project(transform, x + 0.5 + dx, y + 0.5 + dy);
        const sx = Math.min(width - 1, Math.max(0, Math.round(px)));
        const sy = Math.min(height - 1, Math.max(0, Math.round(py)));
        dark += bits[sy * width + sx];
      }
      modules[y][x] = dark >= 3 ? 1 : 0;
    }
  }
  return modules;
}

/* --------------------------------------------------------------------------
   Detection
   -------------------------------------------------------------------------- */

// How many alignment-pattern candidates are worth sampling a whole grid for
// before falling back to the affine fit.
const MAX_ALIGNMENT_TRIES = 4;

/**
 * Turn one candidate finder triple into a payload, if it is one.
 *
 * The module size measured from the finders is good to a few percent, which
 * over ninety modules is enough to land a version either side of the truth. So
 * rather than trusting the arithmetic, the nearest few legal sizes are each
 * sampled and decoded; the format field and the Reed–Solomon check throw out
 * the wrong ones for free.
 */
function decodeCandidate(bits, width, height, trio) {
  const { topLeft, topRight, bottomLeft } = trio;
  const moduleSize = (topLeft.size + topRight.size + bottomLeft.size) / 3;
  if (!(moduleSize > 0)) return null;

  const acrossTop = Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y);
  const downLeft = Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y);
  const estimate = (acrossTop / moduleSize + downLeft / moduleSize) / 2 + 7;

  const nearest = Math.round((estimate - 21) / 4) * 4 + 21;
  const dimensions = [nearest, nearest - 4, nearest + 4, nearest - 8, nearest + 8]
    .filter((d) => d >= 21 && d <= 177)
    .sort((a, b) => Math.abs(a - estimate) - Math.abs(b - estimate));

  const parallelogram = [
    topRight.x - topLeft.x + bottomLeft.x,
    topRight.y - topLeft.y + bottomLeft.y,
  ];
  // Three corners are fixed by the finders; only the fourth is in question,
  // which is the whole difference between the affine and projective fits.
  const attempt = (dimension, sourceCorner, imageCorner) => {
    try {
      const source = [
        [3.5, 3.5],
        [dimension - 3.5, 3.5],
        sourceCorner,
        [3.5, dimension - 3.5],
      ];
      const destination = [
        [topLeft.x, topLeft.y],
        [topRight.x, topRight.y],
        imageCorner,
        [bottomLeft.x, bottomLeft.y],
      ];
      const transform = quadToQuad(source, destination);
      return decodeMatrix(sampleGrid(bits, width, height, transform, dimension));
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      return null;
    }
  };

  for (const dimension of dimensions) {
    const version = (dimension - 17) / 4;

    if (version >= 2) {
      // The bottom-right alignment centre sits three modules in from the
      // notional corner, hence the shortened ratio along the diagonal.
      const pull = 1 - 3 / (dimension - 7);
      const estimateX = topLeft.x + pull * (parallelogram[0] - topLeft.x);
      const estimateY = topLeft.y + pull * (parallelogram[1] - topLeft.y);
      const anchor = [dimension - 6.5, dimension - 6.5];
      const tried = [];
      for (const allowance of [4, 8, 16]) {
        const found = findAlignments(bits, width, height, moduleSize, estimateX, estimateY, allowance);
        for (const point of found.slice(0, MAX_ALIGNMENT_TRIES)) {
          if (tried.some((p) => Math.abs(p.x - point.x) < 1 && Math.abs(p.y - point.y) < 1)) continue;
          tried.push(point);
          const result = attempt(dimension, anchor, [point.x, point.y]);
          if (result !== null) return result;
          if (tried.length >= MAX_ALIGNMENT_TRIES) break;
        }
        if (tried.length >= MAX_ALIGNMENT_TRIES) break;
      }
    }

    // No alignment pattern, or none of them held up: fall back to the plain
    // affine fit through the three finders, which is all version 1 ever has.
    const result = attempt(dimension, [dimension - 3.5, dimension - 3.5], parallelogram);
    if (result !== null) return result;
  }

  return null;
}

/* --------------------------------------------------------------------------
   Public API
   -------------------------------------------------------------------------- */

/**
 * Read a QR code out of an RGBA image.
 * @param {{data: Uint8ClampedArray, width: number, height: number}} imageData
 * @returns {string|null} the payload, or null if nothing readable is there.
 */
export function decodeQRFromImageData(imageData) {
  try {
    if (!imageData) return null;
    const { data, width, height } = imageData;
    if (!data || !width || !height || data.length < width * height * 4) return null;

    const grey = toGreyscale(data, width, height);
    // Dark-on-light first because that is overwhelmingly the common case; a
    // light-on-dark picture costs one extra pass rather than a second decoder.
    for (const invert of [false, true]) {
      const bits = binarise(grey, width, height, invert);
      const centres = findFinders(bits, width, height);
      if (centres.length < 3) continue;
      for (const trio of bestTriples(centres, 4)) {
        const result = decodeCandidate(bits, width, height, trio);
        if (result !== null) return result;
      }
    }
    return null;
  } catch (error) {
    if (error instanceof Unreadable) return null;
    // A genuine bug should not take the pairing screen down with it.
    console.error("[cousin-congress] qr decode failed", error);
    return null;
  }
}

/**
 * Read a payload out of an already-sampled module grid, 1 for dark. Useful when
 * a grid has been recovered some other way, and it is the seam the tests pull
 * on to exercise the bit-level half of the decoder without an image in the way.
 * @param {number[][]} modules
 * @returns {string|null}
 */
export function decodeQRFromMatrix(modules) {
  try {
    if (!Array.isArray(modules) || modules.length === 0) return null;
    const size = modules.length;
    const grid = [];
    for (const row of modules) {
      if (!row || row.length !== size) return null;
      grid.push(Array.from(row, (v) => (v ? 1 : 0)));
    }
    return decodeMatrix(grid);
  } catch (error) {
    if (error instanceof Unreadable) return null;
    console.error("[cousin-congress] qr decode failed", error);
    return null;
  }
}

export default decodeQRFromImageData;
