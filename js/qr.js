/**
 * qr.js — a QR Code encoder, written from the ISO/IEC 18004 spec.
 *
 * Dependency-free on purpose: the whole site must run from a static host with
 * no CDN and no build step, and a pairing code that needs the network to be
 * drawn would defeat the point of pairing offline in the first place.
 *
 * Byte mode only — everything we encode is a compact binary ticket, so the
 * alphanumeric and kanji modes would never fire. Supports all 40 versions and
 * all four error-correction levels, picks the smallest version that fits, and
 * runs the full eight-mask penalty evaluation rather than guessing a mask.
 */

/* --------------------------------------------------------------------------
   Spec tables
   -------------------------------------------------------------------------- */

const ECL = {
  L: { bits: 0b01, index: 0 },
  M: { bits: 0b00, index: 1 },
  Q: { bits: 0b11, index: 2 },
  H: { bits: 0b10, index: 3 },
};

// Indexed [eclIndex][version]; version 0 is unused padding.
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

/** Total modules available to data + ECC, before any codeword accounting. */
function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version, eclIndex) {
  return (
    Math.floor(rawDataModules(version) / 8) -
    ECC_PER_BLOCK[eclIndex][version] * NUM_BLOCKS[eclIndex][version]
  );
}

function alignmentPositions(version) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step =
    version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 10; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

/* --------------------------------------------------------------------------
   GF(256) and Reed–Solomon
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

/** Generator polynomial of the given degree. */
function rsGenerator(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const remainder = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[degree - 1] = 0;
    for (let i = 0; i < degree; i += 1) {
      remainder[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return remainder;
}

/* --------------------------------------------------------------------------
   Bit buffer
   -------------------------------------------------------------------------- */

class BitBuffer {
  constructor() {
    this.bits = [];
  }
  push(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }
  get length() {
    return this.bits.length;
  }
  toBytes() {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, i) => {
      if (bit) bytes[i >>> 3] |= 0x80 >>> (i & 7);
    });
    return bytes;
  }
}

/* --------------------------------------------------------------------------
   Encoding
   -------------------------------------------------------------------------- */

/** Byte-mode character-count field width depends on the version band. */
const countBits = (version) => (version <= 9 ? 8 : 16);

function buildCodewords(bytes, version, eclIndex) {
  const capacityBits = dataCodewords(version, eclIndex) * 8;
  const buffer = new BitBuffer();
  buffer.push(0b0100, 4); // byte mode
  buffer.push(bytes.length, countBits(version));
  for (const byte of bytes) buffer.push(byte, 8);

  if (buffer.length > capacityBits) return null;

  // Terminator, then pad to a byte boundary, then alternating pad bytes.
  buffer.push(0, Math.min(4, capacityBits - buffer.length));
  buffer.push(0, (8 - (buffer.length % 8)) % 8);
  for (let pad = 0xec; buffer.length < capacityBits; pad ^= 0xec ^ 0x11) {
    buffer.push(pad, 8);
  }

  return interleave(buffer.toBytes(), version, eclIndex);
}

/**
 * Split into blocks, compute ECC per block, then interleave — the spread is
 * what lets a burst of damage be spread thinly across many blocks.
 */
function interleave(data, version, eclIndex) {
  const numBlocks = NUM_BLOCKS[eclIndex][version];
  const eccLen = ECC_PER_BLOCK[eclIndex][version];
  const totalCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlockLen = Math.floor(totalCodewords / numBlocks) - eccLen;
  const numShortBlocks = numBlocks - (totalCodewords % numBlocks);

  const blocks = [];
  for (let i = 0, offset = 0; i < numBlocks; i += 1) {
    const len = shortBlockLen + (i < numShortBlocks ? 0 : 1);
    const chunk = data.subarray(offset, offset + len);
    offset += len;
    blocks.push({ data: chunk, ecc: rsRemainder(chunk, eccLen) });
  }

  const result = [];
  for (let i = 0; i < shortBlockLen + 1; i += 1) {
    blocks.forEach((block, b) => {
      // The final data column only exists in the long blocks.
      if (i < shortBlockLen || b >= numShortBlocks) result.push(block.data[i]);
    });
  }
  for (let i = 0; i < eccLen; i += 1) {
    for (const block of blocks) result.push(block.ecc[i]);
  }
  return Uint8Array.from(result);
}

/* --------------------------------------------------------------------------
   Matrix
   -------------------------------------------------------------------------- */

class Matrix {
  constructor(size) {
    this.size = size;
    this.modules = Array.from({ length: size }, () => new Uint8Array(size));
    this.reserved = Array.from({ length: size }, () => new Uint8Array(size));
  }
  set(x, y, dark, reserve = true) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.modules[y][x] = dark ? 1 : 0;
    if (reserve) this.reserved[y][x] = 1;
  }
  get(x, y) {
    return this.modules[y][x];
  }
}

function placeFunctionPatterns(m, version) {
  const size = m.size;

  // Timing lines run the full span first; the finder patterns that follow
  // deliberately overwrite their ends. Drawing these in the other order
  // punches holes in the finders and no decoder will lock on.
  for (let i = 0; i < size; i += 1) {
    m.set(6, i, i % 2 === 0);
    m.set(i, 6, i % 2 === 0);
  }

  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        m.set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);

  // Alignment patterns, skipping the three finder corners.
  const positions = alignmentPositions(version);
  positions.forEach((cy, i) => {
    positions.forEach((cx, j) => {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === positions.length - 1) ||
        (i === positions.length - 1 && j === 0);
      if (corner) return;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          m.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    });
  });

  // Reserve the format areas. Index 6 is skipped in both runs: the format
  // bits step over the timing lines, and blanking those modules here would
  // silently break the timing pattern that decoders lock onto.
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      m.set(i, 8, false);
      m.set(8, i, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    m.set(size - 1 - i, 8, false);
    m.set(8, size - 1 - i, false);
  }
  m.set(8, size - 8, true);

  if (version >= 7) {
    const rem = bch(version, 0x1f25, 12);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const bit = ((bits >> i) & 1) === 1;
      m.set(i % 3 + size - 11, Math.floor(i / 3), bit);
      m.set(Math.floor(i / 3), i % 3 + size - 11, bit);
    }
  }
}

/** Generic BCH remainder used by both format and version information. */
function bch(value, generator, degree) {
  let rem = value << degree;
  const genBits = 32 - Math.clz32(generator);
  for (let i = 32 - Math.clz32(rem); i >= genBits; i -= 1) {
    if ((rem >> (i - 1)) & 1) rem ^= generator << (i - genBits);
  }
  return rem & ((1 << degree) - 1);
}

function placeFormatInfo(m, eclBits, mask) {
  const data = (eclBits << 3) | mask;
  const bits = ((data << 10) | bch(data, 0x537, 10)) ^ 0x5412;
  const size = m.size;

  for (let i = 0; i <= 5; i += 1) m.set(8, i, (bits >> i) & 1);
  m.set(8, 7, (bits >> 6) & 1);
  m.set(8, 8, (bits >> 7) & 1);
  m.set(7, 8, (bits >> 8) & 1);
  for (let i = 9; i < 15; i += 1) m.set(14 - i, 8, (bits >> i) & 1);

  for (let i = 0; i < 8; i += 1) m.set(size - 1 - i, 8, (bits >> i) & 1);
  for (let i = 8; i < 15; i += 1) m.set(8, size - 15 + i, (bits >> i) & 1);
  m.set(8, size - 8, 1);
}

/** Zigzag placement, skipping the vertical timing column. */
function placeData(m, codewords) {
  const size = m.size;
  let index = 0;
  let bit = 0;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (m.reserved[y][x]) continue;
        let dark = false;
        if (index < codewords.length * 8) {
          dark = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) === 1;
          index += 1;
        }
        m.modules[y][x] = dark ? 1 : 0;
        bit += 1;
      }
    }
  }
  return bit;
}

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

function applyMask(m, mask) {
  for (let y = 0; y < m.size; y += 1) {
    for (let x = 0; x < m.size; x += 1) {
      if (!m.reserved[y][x] && MASKS[mask](x, y)) m.modules[y][x] ^= 1;
    }
  }
}

/** The four penalty rules from the spec — lower is more scannable. */
function penalty(m) {
  const size = m.size;
  let score = 0;

  const runScore = (line) => {
    let total = 0;
    let run = 1;
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] === line[i - 1]) {
        run += 1;
        if (run === 5) total += 3;
        else if (run > 5) total += 1;
      } else run = 1;
    }
    return total;
  };

  const FINDER = [1, 0, 1, 1, 1, 0, 1];
  const hasFinderLike = (line, i) => {
    for (let k = 0; k < 7; k += 1) if (line[i + k] !== FINDER[k]) return false;
    const before = line.slice(Math.max(0, i - 4), i);
    const after = line.slice(i + 7, i + 11);
    const quietBefore = before.length === 0 || before.every((v) => v === 0);
    const quietAfter = after.length === 0 || after.every((v) => v === 0);
    return (before.length >= 4 && quietBefore) || (after.length >= 4 && quietAfter);
  };

  for (let y = 0; y < size; y += 1) {
    const row = [...m.modules[y]];
    score += runScore(row);
    for (let x = 0; x + 7 <= size; x += 1) if (hasFinderLike(row, x)) score += 40;
  }
  for (let x = 0; x < size; x += 1) {
    const col = [];
    for (let y = 0; y < size; y += 1) col.push(m.modules[y][x]);
    score += runScore(col);
    for (let y = 0; y + 7 <= size; y += 1) if (hasFinderLike(col, y)) score += 40;
  }

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const v = m.modules[y][x];
      if (v === m.modules[y][x + 1] && v === m.modules[y + 1][x] && v === m.modules[y + 1][x + 1]) {
        score += 3;
      }
    }
  }

  let dark = 0;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) dark += m.modules[y][x];
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

/* --------------------------------------------------------------------------
   Public API
   -------------------------------------------------------------------------- */

/**
 * Encode bytes (or a string, encoded UTF-8) into a QR matrix.
 * @returns {{size:number, modules:number[][], version:number, ecl:string}}
 * @throws if the payload exceeds version 40 at the requested EC level.
 */
export function encodeQR(input, { ecl = "M", minVersion = 1, maxVersion = 40 } = {}) {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : Uint8Array.from(input);
  const level = ECL[ecl] || ECL.M;

  let version = -1;
  let codewords = null;
  for (let v = Math.max(1, minVersion); v <= Math.min(40, maxVersion); v += 1) {
    codewords = buildCodewords(bytes, v, level.index);
    if (codewords) {
      version = v;
      break;
    }
  }
  if (version < 0) {
    throw new Error(
      `${bytes.length} bytes will not fit in a QR code at error-correction level ${ecl}.`
    );
  }

  const size = version * 4 + 17;
  const matrix = new Matrix(size);
  placeFunctionPatterns(matrix, version);
  placeData(matrix, codewords);

  // Evaluate all eight masks and keep the most scannable.
  let best = { score: Infinity, mask: 0, modules: null };
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(matrix, mask);
    placeFormatInfo(matrix, level.bits, mask);
    const score = penalty(matrix);
    if (score < best.score) {
      best = { score, mask, modules: matrix.modules.map((row) => [...row]) };
    }
    applyMask(matrix, mask); // XOR is its own inverse — restore for the next trial.
  }

  return { size, modules: best.modules, version, ecl, mask: best.mask };
}

/** Render a matrix as a crisp, scalable SVG string. */
export function qrToSvg(qr, { margin = 3, dark = "#0b1c4a", light = "#ffffff", title = "" } = {}) {
  const dim = qr.size + margin * 2;
  let path = "";
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (qr.modules[y][x]) path += `M${x + margin} ${y + margin}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges" role="img"${title ? ` aria-label="${title}"` : ' aria-hidden="true"'}>` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/>` +
    `</svg>`
  );
}

export default encodeQR;
