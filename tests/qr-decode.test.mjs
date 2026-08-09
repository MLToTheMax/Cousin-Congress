/**
 * Round-trip and robustness tests for js/qr-decode.js.
 *
 * The decoder is the half of the pairing flow with no user-visible feedback
 * when it is subtly wrong — it just says "no code found" — so the whole point
 * of this file is to prove it actually reads real pixels, not only the grids
 * our own encoder hands it. Every image is also put through jsQR, so a bug in
 * our sampler cannot quietly agree with a bug in our bit reader.
 *
 * Run: node tests/qr-decode.test.mjs
 */

import { createRequire } from "node:module";
import { encodeQR } from "../js/qr.js";
import { decodeQRFromImageData, decodeQRFromMatrix } from "../js/qr-decode.js";

const SCRATCH =
  "/tmp/claude-0/-home-user-Cousin-Congress/3ed12ed5-f595-5592-93db-45e4895ed3e3/scratchpad/";
const require = createRequire(SCRATCH);
const jsQRModule = require("jsqr");
const jsQR = typeof jsQRModule === "function" ? jsQRModule : jsQRModule.default;

/* ------------------------------------------------------------------ harness */

let passed = 0;
const failures = [];

function check(condition, name, detail = "") {
  if (condition) {
    passed += 1;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function equal(actual, expected, name) {
  const ok = actual === expected;
  check(
    ok,
    name,
    ok ? "" : `expected ${JSON.stringify(clip(expected))}, got ${JSON.stringify(clip(actual))}`
  );
}

const clip = (value) =>
  typeof value === "string" && value.length > 48 ? `${value.slice(0, 48)}…` : value;

/** Deterministic PRNG so a failure can be reproduced exactly. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ payloads */

const encoder = new TextEncoder();
const byteLength = (text) => encoder.encode(text).length;

const FILLER_ASCII = "abcdefghijklmnopqrstuvwxyz0123456789-";
const FILLER_UTF8 = "café—naïve ✓ 🎲 møøse ";

function asciiPayload(bytes) {
  let out = "";
  while (byteLength(out) < bytes) out += FILLER_ASCII;
  while (byteLength(out) > bytes) out = out.slice(0, -1);
  return out;
}

/* Trimmed by code point, never by code unit: lopping half a surrogate pair off
   would leave a lone surrogate that cannot survive a UTF-8 round trip. */
function utf8Payload(bytes) {
  let out = "";
  while (byteLength(out) < bytes) out += FILLER_UTF8;
  let points = [...out];
  while (byteLength(points.join("")) > bytes) points.pop();
  return points.join("");
}

function jsonPayload(bytes) {
  const base = { v: 1, kind: "cousin-invite", seat: "m-june", note: "" };
  const overhead = byteLength(JSON.stringify(base));
  const room = Math.max(0, bytes - overhead);
  base.note = asciiPayload(room);
  while (byteLength(JSON.stringify(base)) > bytes && base.note.length > 0) {
    base.note = base.note.slice(0, -1);
  }
  return JSON.stringify(base);
}

/** Largest byte payload that still fits at this version and level. */
function capacity(version, ecl) {
  let low = 1;
  let high = 3000;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    try {
      encodeQR(asciiPayload(mid), { ecl, minVersion: version, maxVersion: version });
      low = mid;
    } catch {
      high = mid - 1;
    }
  }
  return low;
}

/* ------------------------------------------------------------------ imaging */

/**
 * Nearest-neighbour render, so a fractional `scale` gives genuinely
 * non-integer module sizes rather than a resampled blur.
 */
function render(qr, { scale = 4, margin = 4, dark = 0, light = 255 } = {}) {
  const span = qr.size + margin * 2;
  const side = Math.round(span * scale);
  const data = new Uint8ClampedArray(side * side * 4);
  for (let py = 0; py < side; py += 1) {
    for (let px = 0; px < side; px += 1) {
      const mx = Math.floor(px / scale) - margin;
      const my = Math.floor(py / scale) - margin;
      const inside = mx >= 0 && my >= 0 && mx < qr.size && my < qr.size;
      const value = inside && qr.modules[my][mx] ? dark : light;
      const p = (py * side + px) * 4;
      data[p] = value;
      data[p + 1] = value;
      data[p + 2] = value;
      data[p + 3] = 255;
    }
  }
  return { data, width: side, height: side };
}

function addNoise(image, sigma, random) {
  const out = { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height };
  for (let i = 0; i < out.data.length; i += 4) {
    // Box–Muller, one draw shared by the three channels so it stays greyscale.
    const u = Math.max(random(), 1e-9);
    const noise = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random()) * sigma;
    for (let c = 0; c < 3; c += 1) out.data[i + c] = out.data[i + c] + noise;
  }
  return out;
}

/** A linear brightness ramp across the image, `amount` being the total swing. */
function gradient(image, amount) {
  const out = { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height };
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const factor = 1 + amount / 2 - (amount * x) / (image.width - 1);
      const p = (y * image.width + x) * 4;
      for (let c = 0; c < 3; c += 1) out.data[p + c] = out.data[p + c] * factor;
    }
  }
  return out;
}

/**
 * Harsh multiplicative shading along the diagonal — a lamp off to one side of
 * the table. Combined with the photo-ish contrast used below this leaves dark
 * modules in the lit corner brighter than light modules in the shadowed one, so
 * no single global threshold can separate them.
 */
function shade(image, darkest) {
  const out = { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height };
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const along = (x / (image.width - 1) + y / (image.height - 1)) / 2;
      const factor = darkest + (1 - darkest) * along;
      const p = (y * image.width + x) * 4;
      for (let c = 0; c < 3; c += 1) out.data[p + c] = out.data[p + c] * factor;
    }
  }
  return out;
}

/* Projective mapping, written out here rather than borrowed from the decoder:
   the test warps destination pixels back to source pixels, which is the
   opposite direction to anything the decoder computes. */
function squareToQuad(p) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
  const dx3 = x0 - x1 + x2 - x3;
  const dy3 = y0 - y1 + y2 - y3;
  if (dx3 === 0 && dy3 === 0) return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

function quadToQuad(from, to) {
  const [a, b, c, d, e, f, g, h, i] = squareToQuad(from);
  const inverse = [
    e * i - f * h, c * h - b * i, b * f - c * e,
    f * g - d * i, a * i - c * g, c * d - a * f,
    d * h - e * g, b * g - a * h, a * e - b * d,
  ];
  const m = squareToQuad(to);
  const out = new Array(9);
  for (let r = 0; r < 3; r += 1) {
    for (let col = 0; col < 3; col += 1) {
      out[r * 3 + col] =
        m[r * 3] * inverse[col] + m[r * 3 + 1] * inverse[3 + col] + m[r * 3 + 2] * inverse[6 + col];
    }
  }
  return out;
}

/** Tilt the image, as if the code were photographed off square. */
function warp(image, corners) {
  const destination = corners.map(([fx, fy]) => [fx * (image.width - 1), fy * (image.height - 1)]);
  const source = [
    [0, 0],
    [image.width - 1, 0],
    [image.width - 1, image.height - 1],
    [0, image.height - 1],
  ];
  const back = quadToQuad(destination, source);
  const data = new Uint8ClampedArray(image.data.length);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const w = back[6] * x + back[7] * y + back[8];
      const sx = (back[0] * x + back[1] * y + back[2]) / w;
      const sy = (back[3] * x + back[4] * y + back[5]) / w;
      const p = (y * image.width + x) * 4;
      data[p + 3] = 255;
      if (sx < 0 || sy < 0 || sx > image.width - 1.001 || sy > image.height - 1.001) {
        data[p] = 255;
        data[p + 1] = 255;
        data[p + 2] = 255;
        continue;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let c = 0; c < 3; c += 1) {
        const a = image.data[(y0 * image.width + x0) * 4 + c];
        const b = image.data[(y0 * image.width + x0 + 1) * 4 + c];
        const d = image.data[((y0 + 1) * image.width + x0) * 4 + c];
        const e = image.data[((y0 + 1) * image.width + x0 + 1) * 4 + c];
        data[p + c] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + d * (1 - fx) * fy + e * fx * fy;
      }
    }
  }
  return { data, width: image.width, height: image.height };
}

/** Separable 1-2-1 blur, repeated. */
function blur(image, passes = 1) {
  let { data, width, height } = image;
  for (let pass = 0; pass < passes; pass += 1) {
    const horizontal = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const p = (y * width + x) * 4;
        const l = (y * width + Math.max(0, x - 1)) * 4;
        const r = (y * width + Math.min(width - 1, x + 1)) * 4;
        for (let c = 0; c < 3; c += 1) {
          horizontal[p + c] = (data[l + c] + 2 * data[p + c] + data[r + c]) / 4;
        }
        horizontal[p + 3] = 255;
      }
    }
    const vertical = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const p = (y * width + x) * 4;
        const u = (Math.max(0, y - 1) * width + x) * 4;
        const d = (Math.min(height - 1, y + 1) * width + x) * 4;
        for (let c = 0; c < 3; c += 1) {
          vertical[p + c] = (horizontal[u + c] + 2 * horizontal[p + c] + horizontal[d + c]) / 4;
        }
        vertical[p + 3] = 255;
      }
    }
    data = vertical;
  }
  return { data, width, height };
}

/** Bilinear resample, used to land on fractional module sizes. */
function resample(image, factor) {
  const width = Math.round(image.width * factor);
  const height = Math.round(image.height * factor);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(image.height - 1.001, y / factor);
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(image.width - 1.001, x / factor);
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const p = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const a = image.data[(y0 * image.width + x0) * 4 + c];
        const b = image.data[(y0 * image.width + x0 + 1) * 4 + c];
        const d = image.data[((y0 + 1) * image.width + x0) * 4 + c];
        const e = image.data[((y0 + 1) * image.width + x0 + 1) * 4 + c];
        data[p + c] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + d * (1 - fx) * fy + e * fx * fy;
      }
      data[p + 3] = 255;
    }
  }
  return { data, width, height };
}

function rotate90(image, turns) {
  let current = image;
  for (let t = 0; t < ((turns % 4) + 4) % 4; t += 1) {
    const { width, height, data } = current;
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const nx = height - 1 - y;
        const ny = x;
        const from = (y * width + x) * 4;
        const to = (ny * height + nx) * 4;
        for (let c = 0; c < 4; c += 1) out[to + c] = data[from + c];
      }
    }
    current = { data: out, width: height, height: width };
  }
  return current;
}

function invertImage(image) {
  const data = new Uint8ClampedArray(image.data);
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) data[i + c] = 255 - data[i + c];
  }
  return { data, width: image.width, height: image.height };
}

const readWithJsQR = (image, options = {}) => {
  const result = jsQR(image.data, image.width, image.height, options);
  return result ? result.data : null;
};

/* --------------------------------------------- independent placement model */

/*
 * Deliberately re-derived from the spec rather than shared with the decoder:
 * the error-correction tests need to know which module carries which codeword,
 * and borrowing the decoder's own idea of that would make the test agree with
 * whatever the decoder happens to believe.
 */

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
  for (let pos = version * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function reservedMap(version) {
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
    for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) mark(cx + dx, cy + dy);
  }
  const positions = alignmentPositions(version);
  positions.forEach((cy, i) =>
    positions.forEach((cx, j) => {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === positions.length - 1) ||
        (i === positions.length - 1 && j === 0);
      if (corner) return;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) mark(cx + dx, cy + dy);
    })
  );
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

/** Module coordinates in data-bit order. */
function dataBitPositions(version) {
  const size = version * 4 + 17;
  const skip = reservedMap(version);
  const out = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!skip[y][x]) out.push([x, y]);
      }
    }
  }
  return out;
}

/** Which block each codeword of the interleaved stream belongs to. */
function streamBlocks(version, numBlocks, eccLen) {
  const total = Math.floor(rawDataModules(version) / 8);
  const shortLen = Math.floor(total / numBlocks) - eccLen;
  const numShort = numBlocks - (total % numBlocks);
  const owner = new Array(total);
  let index = 0;
  for (let i = 0; i < shortLen + 1; i += 1) {
    for (let b = 0; b < numBlocks; b += 1) {
      if (i < shortLen || b >= numShort) owner[index++] = b;
    }
  }
  for (let i = 0; i < eccLen; i += 1) {
    for (let b = 0; b < numBlocks; b += 1) owner[index++] = b;
  }
  return owner;
}

/* ------------------------------------------------------- 1. matrix round-trip */

console.log("— matrix round-trip, versions 1-20, all levels");

const kinds = [asciiPayload, utf8Payload, jsonPayload];

/* The JSON shape has around fifty bytes of overhead, so tiny symbols get the
   plain payloads instead. */
const pickKind = (seed, room) => kinds[seed % (room >= 90 ? 3 : 2)];
for (let version = 1; version <= 20; version += 1) {
  for (const ecl of ["L", "M", "Q", "H"]) {
    const room = capacity(version, ecl);
    const payload = pickKind(version + ecl.charCodeAt(0), room)(
      Math.max(1, Math.floor(room * 0.75))
    );
    const qr = encodeQR(payload, { ecl, minVersion: version, maxVersion: version });
    equal(qr.version, version, `v${version}-${ecl} encodes at the requested version`);
    equal(decodeQRFromMatrix(qr.modules), payload, `v${version}-${ecl} matrix round-trip`);
  }
}

console.log("— matrix round-trip, versions 21-40, all levels");

/* The big half of the range, which the app itself will never reach but a code
   from another app easily can. Three things only exist up here: the third
   character-count band from version 27, version 32's one-off alignment step,
   and grids with up to seven rows of alignment patterns. A fixed payload
   rather than a capacity search — the search costs a dozen encodes per cell
   and 180 bytes fits the smallest of these (version 21 at H holds around 400). */
for (let version = 21; version <= 40; version += 1) {
  for (const ecl of ["L", "M", "Q", "H"]) {
    const payload = `${asciiPayload(180)} v${version}${ecl}`;
    const qr = encodeQR(payload, { ecl, minVersion: version, maxVersion: version });
    equal(decodeQRFromMatrix(qr.modules), payload, `v${version}-${ecl} matrix round-trip`);
  }
}

console.log("— matrix rotations");
for (const ecl of ["L", "M", "Q", "H"]) {
  const payload = `rotate me ${ecl} — ✓`;
  const qr = encodeQR(payload, { ecl });
  let grid = qr.modules.map((row) => [...row]);
  for (let turn = 0; turn < 4; turn += 1) {
    equal(decodeQRFromMatrix(grid), payload, `matrix rotated ${turn * 90}deg, level ${ecl}`);
    const size = grid.length;
    grid = Array.from({ length: size }, (_, y) =>
      Array.from({ length: size }, (_, x) => grid[size - 1 - x][y])
    );
  }
}

/* ------------------------------------------------- 2. image round-trip + jsQR */

console.log("— image round-trip with jsQR cross-check");

const IMAGE_VERSIONS = [1, 2, 3, 5, 7, 10, 14, 20];
for (const version of IMAGE_VERSIONS) {
  for (const ecl of ["L", "M", "Q", "H"]) {
    const room = capacity(version, ecl);
    const payload = pickKind(version + ecl.charCodeAt(0), room)(
      Math.max(1, Math.floor(room * 0.7))
    );
    const qr = encodeQR(payload, { ecl, minVersion: version, maxVersion: version });
    const image = render(qr, { scale: 4, margin: 4 });
    const name = `v${version}-${ecl} image round-trip`;
    equal(decodeQRFromImageData(image), payload, name);
    equal(readWithJsQR(image), payload, `${name} (jsQR agrees)`);
  }
}

console.log("— long payloads");
for (const ecl of ["L", "M", "Q", "H"]) {
  for (const build of kinds) {
    const payload = build(340);
    const qr = encodeQR(payload, { ecl });
    const image = render(qr, { scale: 4, margin: 4 });
    const name = `${byteLength(payload)}-byte payload at ${ecl} (v${qr.version})`;
    equal(decodeQRFromImageData(image), payload, name);
    equal(readWithJsQR(image), payload, `${name} (jsQR agrees)`);
  }
}

console.log("— large symbols through the image path");

/* Detection is scale-sensitive in a way the matrix path cannot show: a version
   40 symbol is 177 modules across, so the finders are a far smaller fraction of
   the frame and the alignment estimate has much further to drift. */
for (const version of [27, 32, 40]) {
  const payload = `${asciiPayload(200)} big v${version}`;
  const qr = encodeQR(payload, { ecl: "M", minVersion: version, maxVersion: version });
  const image = render(qr, { scale: 3, margin: 4 });
  equal(decodeQRFromImageData(image), payload, `v${version} image round-trip`);
  equal(readWithJsQR(image), payload, `v${version} image round-trip (jsQR agrees)`);
}

/* ---------------------------------------------------------- 3. robustness */

console.log("— robustness");

const ROBUST = [
  { version: 3, ecl: "M", build: () => "cousin://pair?seat=m-june&n=7 — ✓" },
  { version: 6, ecl: "Q", build: (room) => jsonPayload(room) },
  { version: 10, ecl: "H", build: (room) => utf8Payload(room) },
];

for (const { version, ecl, build } of ROBUST) {
  const payload = build(Math.floor(capacity(version, ecl) * 0.8));
  const qr = encodeQR(payload, { ecl, minVersion: version, maxVersion: version });
  const label = `v${version}-${ecl}`;
  const clean = render(qr, { scale: 6, margin: 4 });
  const random = rng(0x5eed + version);

  const noisy = addNoise(clean, 26, random);
  equal(decodeQRFromImageData(noisy), payload, `${label} gaussian noise sigma 26`);
  equal(readWithJsQR(noisy), payload, `${label} gaussian noise (jsQR agrees)`);

  const shaded = gradient(clean, 0.15);
  equal(decodeQRFromImageData(shaded), payload, `${label} 15% brightness gradient`);

  const blurred = blur(clean, 2);
  equal(decodeQRFromImageData(blurred), payload, `${label} moderate blur`);

  const fractional = render(qr, { scale: 3.7, margin: 4 });
  equal(decodeQRFromImageData(fractional), payload, `${label} 3.7px modules`);
  equal(readWithJsQR(fractional), payload, `${label} 3.7px modules (jsQR agrees)`);

  const resampled = resample(render(qr, { scale: 6, margin: 4 }), 0.79);
  equal(decodeQRFromImageData(resampled), payload, `${label} bilinear resample to 4.74px modules`);

  for (let turns = 0; turns < 4; turns += 1) {
    equal(decodeQRFromImageData(rotate90(clean, turns)), payload, `${label} rotated ${turns * 90}deg`);
  }

  const inverted = invertImage(clean);
  equal(decodeQRFromImageData(inverted), payload, `${label} inverted (light on dark)`);

  // Photo-ish contrast, then a lamp off one corner. A global threshold has no
  // answer to this: the darkest light module here is below the brightest dark one.
  const lit = shade(render(qr, { scale: 6, margin: 4, dark: 45, light: 225 }), 0.16);
  equal(decodeQRFromImageData(lit), payload, `${label} steep uneven lighting`);

  const tilted = warp(render(qr, { scale: 8, margin: 4 }), [
    [0.1, 0.03],
    [0.9, 0.13],
    [0.97, 0.94],
    [0.04, 0.88],
  ]);
  equal(decodeQRFromImageData(tilted), payload, `${label} photographed off square`);
  equal(readWithJsQR(tilted), payload, `${label} photographed off square (jsQR agrees)`);

  const nasty = blur(addNoise(gradient(render(qr, { scale: 5, margin: 4 }), 0.15), 14, rng(11)), 1);
  equal(decodeQRFromImageData(nasty), payload, `${label} gradient + noise + blur combined`);
}

console.log("— a transparent background");

/*
 * What a QR PNG saved without a background looks like once a browser has drawn
 * it onto a fresh canvas: the light modules are RGB 0,0,0 with alpha 0, and only
 * the alpha channel separates them from the dark ones. Read the colour channels
 * alone and the symbol is a solid black square. jsQR is not asked to agree here
 * — it ignores alpha too, and gets nothing.
 */
{
  const payload = "cousin://pair?seat=m-june&n=7";
  const qr = encodeQR(payload, { ecl: "M" });

  const transparent = (backdropAlpha) => {
    const image = render(qr, { scale: 6, margin: 4 });
    for (let i = 0; i < image.data.length; i += 4) {
      const dark = image.data[i] === 0;
      image.data[i] = 0;
      image.data[i + 1] = 0;
      image.data[i + 2] = 0;
      image.data[i + 3] = dark ? 255 : backdropAlpha;
    }
    return image;
  };

  equal(decodeQRFromImageData(transparent(0)), payload, "fully transparent background");
  equal(decodeQRFromImageData(transparent(60)), payload, "mostly transparent background");
}

console.log("— a small code in a large frame");
{
  // What a forwarded photo actually looks like: a landscape frame with the code
  // off to one side and plenty of empty room around it.
  const payload = "cousin://pair?seat=m-june&n=7";
  const qr = encodeQR(payload, { ecl: "M" });
  const small = blur(addNoise(render(qr, { scale: 5, margin: 4 }), 12, rng(0x1a2b)), 1);
  const width = 1400;
  const height = 900;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const offsetX = 820;
  const offsetY = 160;
  for (let y = 0; y < small.height; y += 1) {
    for (let x = 0; x < small.width; x += 1) {
      const from = (y * small.width + x) * 4;
      const to = ((y + offsetY) * width + x + offsetX) * 4;
      for (let c = 0; c < 4; c += 1) data[to + c] = small.data[from + c];
    }
  }
  const frame = { data, width, height };
  equal(decodeQRFromImageData(frame), payload, "code off to one side of a 1400x900 frame");
  equal(readWithJsQR(frame), payload, "code off to one side of a 1400x900 frame (jsQR agrees)");
}

/* ------------------------------------------------- 4. real error correction */

console.log("— Reed–Solomon correction budget");

// version, level, blocks, ecc codewords per block — straight from ISO/IEC 18004.
const BUDGETS = [
  { version: 1, ecl: "M", blocks: 1, ecc: 10 },
  { version: 2, ecl: "Q", blocks: 1, ecc: 22 },
  { version: 5, ecl: "H", blocks: 4, ecc: 22 },
  { version: 7, ecl: "L", blocks: 2, ecc: 20 },
  { version: 10, ecl: "M", blocks: 5, ecc: 26 },
  { version: 13, ecl: "Q", blocks: 12, ecc: 24 },
];

function corruptCodewords(qr, version, blocks, ecc, perBlock, random) {
  const positions = dataBitPositions(version);
  const owner = streamBlocks(version, blocks, ecc);
  const grid = qr.modules.map((row) => [...row]);
  const chosen = Array.from({ length: blocks }, () => []);
  owner.forEach((block, index) => chosen[block].push(index));

  let flipped = 0;
  for (const list of chosen) {
    for (let i = 0; i < perBlock; i += 1) {
      const codeword = list[Math.floor(random() * list.length) % list.length];
      // One bit per codeword: Reed–Solomon counts symbols, so a single flipped
      // bit costs exactly as much as a wholly mangled byte.
      const bit = codeword * 8 + Math.floor(random() * 8);
      const [x, y] = positions[bit];
      grid[y][x] ^= 1;
      flipped += 1;
      list.splice(list.indexOf(codeword), 1);
    }
  }
  return { grid, flipped };
}

for (const { version, ecl, blocks, ecc } of BUDGETS) {
  const payload = asciiPayload(Math.max(1, Math.floor(capacity(version, ecl) * 0.6)));
  const qr = encodeQR(payload, { ecl, minVersion: version, maxVersion: version });
  const budget = Math.floor(ecc / 2);

  const within = corruptCodewords(qr, version, blocks, ecc, budget, rng(0xc0ffee + version));
  equal(
    decodeQRFromMatrix(within.grid),
    payload,
    `v${version}-${ecl} corrects ${within.flipped} damaged codewords (budget ${budget}/block)`
  );

  const beyond = corruptCodewords(qr, version, blocks, ecc, budget + 1, rng(0xbadc0de + version));
  equal(
    decodeQRFromMatrix(beyond.grid),
    null,
    `v${version}-${ecl} refuses ${beyond.flipped} damaged codewords rather than guessing`
  );
}

console.log("— damage through the image path");
{
  const payload = "cousin://pair?seat=m-ada&n=3";
  const qr = encodeQR(payload, { ecl: "Q" });
  const budget = Math.floor(26 / 2); // v3-Q: one block, 26 ecc codewords
  const damaged = corruptCodewords(qr, qr.version, 1, 26, budget, rng(0x1234));
  const image = render({ ...qr, modules: damaged.grid }, { scale: 5, margin: 4 });
  equal(decodeQRFromImageData(image), payload, "damaged symbol still reads from an image");
}

/* ------------------------------------------- 5. modes our encoder never emits */

/*
 * qr.js only ever writes byte mode, so codes from other apps are the only place
 * numeric, alphanumeric and ECI segments turn up — and they are exactly the
 * segments a decoder is most likely to get wrong unnoticed. These are built
 * here from scratch: an encodeQR symbol supplies the function patterns and the
 * data modules are then overwritten with hand-rolled codewords.
 *
 * Reaching past version 5 means interleaving, and interleaving means a block
 * table — re-derived from the standard here for the same reason as the
 * placement model above. It buys the two wider character-count bands, which
 * single-block versions can never reach.
 */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

function rsEcc(data, degree) {
  let generator = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(generator.length + 1).fill(0);
    for (let j = 0; j < generator.length; j += 1) {
      next[j] ^= generator[j];
      next[j + 1] ^= gfMul(generator[j], GF_EXP[i]);
    }
    generator = next;
  }
  const remainder = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[degree - 1] = 0;
    for (let i = 0; i < degree; i += 1) remainder[i] ^= gfMul(generator[i + 1], factor);
  }
  return remainder;
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

class Bits {
  constructor() {
    this.bits = [];
  }
  push(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }
}

const countWidth = (mode, version) => {
  const band = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  return { 1: [10, 12, 14], 2: [9, 11, 13], 4: [8, 16, 16] }[mode][band];
};

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

const ECL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
const ECL_FORMAT_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

/** Split data into blocks, append each block's parity, and interleave both. */
function interleave(version, ecl, data) {
  const index = ECL_INDEX[ecl];
  const numBlocks = NUM_BLOCKS[index][version];
  const eccLen = ECC_PER_BLOCK[index][version];
  const total = Math.floor(rawDataModules(version) / 8);
  const shortLen = Math.floor(total / numBlocks) - eccLen;
  const numShort = numBlocks - (total % numBlocks);

  const dataBlocks = [];
  const eccBlocks = [];
  let at = 0;
  for (let b = 0; b < numBlocks; b += 1) {
    const block = data.slice(at, at + shortLen + (b < numShort ? 0 : 1));
    at += block.length;
    dataBlocks.push(block);
    eccBlocks.push(rsEcc(block, eccLen));
  }

  const stream = [];
  for (let i = 0; i <= shortLen; i += 1) {
    for (const block of dataBlocks) if (i < block.length) stream.push(block[i]);
  }
  for (let i = 0; i < eccLen; i += 1) {
    for (const block of eccBlocks) stream.push(block[i]);
  }
  return stream;
}

/* Rewriting the format field is what lets a mask be chosen rather than accepted
   from the encoder, which is the only way to reach the masks its penalty scoring
   happens never to pick. */
function writeFormat(grid, ecl, mask) {
  const size = grid.length;
  const value = (ECL_FORMAT_BITS[ecl] << 3) | mask;
  let rem = value;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((value << 10) | (rem & 0x3ff)) ^ 0x5412;
  const bit = (i) => (bits >>> i) & 1;

  for (let i = 0; i <= 5; i += 1) grid[i][8] = bit(i);
  grid[7][8] = bit(6);
  grid[8][8] = bit(7);
  grid[8][7] = bit(8);
  for (let i = 9; i < 15; i += 1) grid[8][14 - i] = bit(i);

  for (let i = 0; i < 8; i += 1) grid[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i += 1) grid[size - 15 + i][8] = bit(i);
}

function numericSegment(bits, version, digits) {
  bits.push(0b0001, 4);
  bits.push(digits.length, countWidth(1, version));
  let i = 0;
  for (; i + 3 <= digits.length; i += 3) bits.push(Number(digits.slice(i, i + 3)), 10);
  if (digits.length - i === 2) bits.push(Number(digits.slice(i)), 7);
  else if (digits.length - i === 1) bits.push(Number(digits.slice(i)), 4);
}

function alnumSegment(bits, version, text) {
  const table = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
  bits.push(0b0010, 4);
  bits.push(text.length, countWidth(2, version));
  let i = 0;
  for (; i + 2 <= text.length; i += 2) {
    bits.push(table.indexOf(text[i]) * 45 + table.indexOf(text[i + 1]), 11);
  }
  if (i < text.length) bits.push(table.indexOf(text[i]), 6);
}

function byteSegment(bits, version, text) {
  const bytes = encoder.encode(text);
  bits.push(0b0100, 4);
  bits.push(bytes.length, countWidth(4, version));
  for (const byte of bytes) bits.push(byte, 8);
}

/**
 * Build a symbol whose data modules carry exactly the given bits. `mask`
 * defaults to whatever the host symbol chose; naming one rewrites the format
 * field to match.
 */
function symbolFromBits(version, ecl, bits, mask) {
  const index = ECL_INDEX[ecl];
  const total = Math.floor(rawDataModules(version) / 8);
  const dataLen = total - NUM_BLOCKS[index][version] * ECC_PER_BLOCK[index][version];
  const capacityBits = dataLen * 8;
  if (bits.bits.length > capacityBits) throw new Error("hand-built segment does not fit");

  const padded = [...bits.bits];
  for (let i = 0; i < 4 && padded.length < capacityBits; i += 1) padded.push(0);
  while (padded.length % 8 !== 0) padded.push(0);
  const data = [];
  for (let i = 0; i < padded.length; i += 8) {
    data.push(padded.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  for (let pad = 0xec; data.length < dataLen; pad ^= 0xec ^ 0x11) data.push(pad);

  const stream = interleave(version, ecl, data);
  const host = encodeQR("x", { ecl, minVersion: version, maxVersion: version });
  const grid = host.modules.map((row) => [...row]);
  const chosen = mask === undefined ? host.mask : mask;
  if (chosen !== host.mask) writeFormat(grid, ecl, chosen);

  const positions = dataBitPositions(version);
  const maskFn = MASKS[chosen];
  for (let i = 0; i < stream.length * 8; i += 1) {
    const bit = (stream[i >> 3] >> (7 - (i & 7))) & 1;
    const [x, y] = positions[i];
    grid[y][x] = bit ^ (maskFn(x, y) ? 1 : 0);
  }
  return grid;
}

/** A hand-built grid as an image, so jsQR can be asked whether it agrees. */
const asImage = (grid) => render({ size: grid.length, modules: grid }, { scale: 4, margin: 4 });

console.log("— numeric, alphanumeric and ECI segments");

{
  const bits = new Bits();
  numericSegment(bits, 2, "01234567891234");
  equal(decodeQRFromMatrix(symbolFromBits(2, "M", bits)), "01234567891234", "numeric mode");
}
{
  const bits = new Bits();
  numericSegment(bits, 2, "007"); // one leftover digit, the 4-bit tail
  equal(decodeQRFromMatrix(symbolFromBits(2, "M", bits)), "007", "numeric mode, 4-bit tail");
}
{
  const bits = new Bits();
  numericSegment(bits, 2, "12345"); // two leftover digits, the 7-bit tail
  equal(decodeQRFromMatrix(symbolFromBits(2, "M", bits)), "12345", "numeric mode, 7-bit tail");
}
{
  const bits = new Bits();
  alnumSegment(bits, 2, "COUSIN CONGRESS: PAIR-7");
  equal(
    decodeQRFromMatrix(symbolFromBits(2, "M", bits)),
    "COUSIN CONGRESS: PAIR-7",
    "alphanumeric mode"
  );
}
{
  const bits = new Bits();
  alnumSegment(bits, 2, "ODD/1"); // odd length, the 6-bit tail
  equal(decodeQRFromMatrix(symbolFromBits(2, "M", bits)), "ODD/1", "alphanumeric mode, 6-bit tail");
}
{
  const bits = new Bits();
  bits.push(0b0111, 4);
  bits.push(26, 8); // ECI 26, UTF-8, in the one-byte designator form
  byteSegment(bits, 4, "café — ✓ from another app");
  equal(
    decodeQRFromMatrix(symbolFromBits(4, "L", bits)),
    "café — ✓ from another app",
    "ECI with a one-byte designator, then byte mode"
  );
}
{
  const bits = new Bits();
  bits.push(0b0111, 4);
  bits.push(0x8000 | 899, 16); // ECI 899, binary, two-byte designator form
  byteSegment(bits, 4, "two-byte designator");
  equal(
    decodeQRFromMatrix(symbolFromBits(4, "L", bits)),
    "two-byte designator",
    "ECI with a two-byte designator"
  );
}
{
  const bits = new Bits();
  numericSegment(bits, 4, "2026");
  alnumSegment(bits, 4, " SEAT-A ");
  byteSegment(bits, 4, "møøse");
  equal(
    decodeQRFromMatrix(symbolFromBits(4, "L", bits)),
    "2026 SEAT-A møøse",
    "three segments of different modes in one symbol"
  );
}
{
  // Kanji is not something the family app can act on, and guessing at it would
  // return plausible nonsense rather than nothing.
  const bits = new Bits();
  bits.push(0b1000, 4);
  bits.push(3, 8);
  bits.push(0x6df, 13);
  bits.push(0x1c4, 13);
  bits.push(0x123, 13);
  check(decodeQRFromMatrix(symbolFromBits(2, "M", bits)) === null, "kanji mode is refused, not guessed");
}

console.log("— damaged format information");

for (const ecl of ["L", "M", "Q", "H"]) {
  const payload = `format check ${ecl}`;
  const qr = encodeQR(payload, { ecl });
  const size = qr.size;
  // The first copy runs down column 8 and along row 8; three flipped bits is
  // the most its BCH code is guaranteed to recover.
  const grid = qr.modules.map((row) => [...row]);
  for (const [x, y] of [[8, 0], [8, 2], [8, 4]]) grid[y][x] ^= 1;
  equal(decodeQRFromMatrix(grid), payload, `three bad bits in format copy 1 (${ecl})`);

  // Destroy the first copy outright; the second must carry the read.
  const wrecked = qr.modules.map((row) => [...row]);
  for (let i = 0; i <= 5; i += 1) wrecked[i][8] ^= 1;
  wrecked[7][8] ^= 1;
  wrecked[8][8] ^= 1;
  wrecked[8][7] ^= 1;
  for (let i = 9; i < 15; i += 1) wrecked[8][14 - i] ^= 1;
  equal(decodeQRFromMatrix(wrecked), payload, `format copy 1 wrecked, copy 2 carries it (${ecl})`);

  // Three bad bits in each copy: neither reading is clean, so the field can
  // only be recovered by actually correcting one of them.
  const both = qr.modules.map((row) => [...row]);
  for (const [x, y] of [[8, 1], [8, 3], [8, 5]]) both[y][x] ^= 1;
  for (const [x, y] of [[size - 1, 8], [size - 3, 8], [size - 5, 8]]) both[y][x] ^= 1;
  equal(decodeQRFromMatrix(both), payload, `both format copies damaged, BCH recovers (${ecl})`);
}

console.log("— wider character-count fields");

/*
 * The count field widens at version 10 and again at version 27. Getting a width
 * wrong there is the worst kind of bug: the count still parses, the rest of the
 * stream slides along by a couple of bits, and what comes out is confident
 * rubbish rather than nothing. jsQR is asked to agree on each of these, so the
 * check does not rest on this file's own idea of the band boundaries.
 */
for (const version of [2, 10, 27]) {
  {
    const digits = "40721180937"; // three triples and a pair
    const bits = new Bits();
    numericSegment(bits, version, digits);
    const grid = symbolFromBits(version, "M", bits);
    equal(decodeQRFromMatrix(grid), digits, `numeric count field at v${version}`);
    equal(readWithJsQR(asImage(grid)), digits, `numeric count field at v${version} (jsQR agrees)`);
  }
  {
    const text = "SEAT B-12/OK";
    const bits = new Bits();
    alnumSegment(bits, version, text);
    const grid = symbolFromBits(version, "M", bits);
    equal(decodeQRFromMatrix(grid), text, `alphanumeric count field at v${version}`);
    equal(readWithJsQR(asImage(grid)), text, `alphanumeric count field at v${version} (jsQR agrees)`);
  }
  {
    const text = `byte v${version} — ✓`;
    const bits = new Bits();
    byteSegment(bits, version, text);
    const grid = symbolFromBits(version, "M", bits);
    equal(decodeQRFromMatrix(grid), text, `byte count field at v${version}`);
    equal(readWithJsQR(asImage(grid)), text, `byte count field at v${version} (jsQR agrees)`);
  }
}

console.log("— every mask pattern");

/* The encoder's penalty scoring picks masks 2 and 4 most of the time and some
   of the others barely at all, so leaving mask coverage to whatever it happens
   to choose leaves several of the eight essentially untried. */
for (let mask = 0; mask < 8; mask += 1) {
  const text = `mask ${mask} — ✓`;
  const bits = new Bits();
  byteSegment(bits, 3, text);
  const grid = symbolFromBits(3, "M", bits, mask);
  equal(decodeQRFromMatrix(grid), text, `mask ${mask} unmasks correctly`);
  equal(readWithJsQR(asImage(grid)), text, `mask ${mask} (jsQR agrees)`);
}

console.log("— byte data that is not valid UTF-8");

{
  // A code from an app that took the spec's nominal ISO-8859-1 at its word.
  // 0xe9 followed by a space is not a legal UTF-8 sequence, so the strict pass
  // has to fail and hand over rather than emit replacement characters.
  const bytes = [0x63, 0x61, 0x66, 0xe9, 0x20, 0xbd, 0x20, 0xd8, 0x6c];
  const bits = new Bits();
  bits.push(0b0100, 4);
  bits.push(bytes.length, countWidth(4, 2));
  for (const byte of bytes) bits.push(byte, 8);
  equal(
    decodeQRFromMatrix(symbolFromBits(2, "M", bits)),
    "café ½ Øl",
    "invalid UTF-8 falls back to ISO-8859-1"
  );
}

{
  // The encoder takes raw bytes as well as strings, which is the other way this
  // path gets hit in practice.
  const qr = encodeQR(new Uint8Array([0xe9, 0xe8, 0x20, 0xff]), { ecl: "M" });
  equal(decodeQRFromMatrix(qr.modules), "éè ÿ", "raw byte payload round-trips through the fallback");
}

console.log("— segment headers we refuse rather than guess at");

{
  // Structured append: one symbol out of a set. Handing back its fragment as if
  // it were the whole payload would pair against half a ticket.
  const bits = new Bits();
  bits.push(0b0011, 4);
  bits.push(0, 4);
  bits.push(1, 4);
  bits.push(0x5a, 8);
  byteSegment(bits, 2, "half a payload");
  check(decodeQRFromMatrix(symbolFromBits(2, "M", bits)) === null, "structured append is refused");
}

{
  const bits = new Bits();
  bits.push(0b0101, 4); // FNC1 in first position, i.e. a GS1 code
  byteSegment(bits, 2, "0112345678901231");
  check(decodeQRFromMatrix(symbolFromBits(2, "M", bits)) === null, "FNC1 is refused");
}

{
  const bits = new Bits();
  bits.push(0b0111, 4);
  bits.push(0xf8, 8); // no legal ECI designator starts 11111
  byteSegment(bits, 2, "nope");
  check(
    decodeQRFromMatrix(symbolFromBits(2, "M", bits)) === null,
    "malformed ECI designator is refused"
  );
}

{
  const bits = new Bits();
  bits.push(0b0111, 4);
  bits.push(0xc00000 | 811800, 24); // ECI in the three-byte designator form
  byteSegment(bits, 2, "three-byte designator");
  equal(
    decodeQRFromMatrix(symbolFromBits(2, "M", bits)),
    "three-byte designator",
    "ECI with a three-byte designator"
  );
}

/* ------------------------------------------------------------- 6. rejection */

console.log("— rejection");

check(decodeQRFromImageData(null) === null, "null image returns null");
check(decodeQRFromImageData({ data: new Uint8ClampedArray(0), width: 0, height: 0 }) === null, "empty image returns null");

{
  const blank = { data: new Uint8ClampedArray(120 * 120 * 4).fill(255), width: 120, height: 120 };
  check(decodeQRFromImageData(blank) === null, "blank white image returns null");
}

{
  const random = rng(99);
  const noise = new Uint8ClampedArray(160 * 160 * 4);
  for (let i = 0; i < noise.length; i += 4) {
    const v = random() > 0.5 ? 255 : 0;
    noise[i] = v;
    noise[i + 1] = v;
    noise[i + 2] = v;
    noise[i + 3] = 255;
  }
  check(decodeQRFromImageData({ data: noise, width: 160, height: 160 }) === null, "pure noise returns null");
}

{
  const random = rng(7);
  const grid = Array.from({ length: 25 }, () => Array.from({ length: 25 }, () => (random() > 0.5 ? 1 : 0)));
  check(decodeQRFromMatrix(grid) === null, "random matrix returns null");
  check(decodeQRFromMatrix([[1, 0], [0, 1]]) === null, "matrix of an impossible size returns null");
  check(decodeQRFromMatrix("nonsense") === null, "non-matrix input returns null");
  check(decodeQRFromMatrix([]) === null, "empty matrix returns null");
  check(decodeQRFromMatrix([null, null]) === null, "matrix of missing rows returns null");
  check(decodeQRFromMatrix(42) === null, "a number returns null");

  // Ragged at a size that would otherwise pass the plausibility check, which is
  // what a caller that mis-built its grid actually hands over.
  const ragged = Array.from({ length: 21 }, () => new Array(21).fill(0));
  ragged[9] = new Array(20).fill(0);
  check(decodeQRFromMatrix(ragged) === null, "ragged matrix of a plausible size returns null");

  const oblong = Array.from({ length: 21 }, () => new Array(25).fill(0));
  check(decodeQRFromMatrix(oblong) === null, "non-square matrix returns null");
}

{
  check(
    decodeQRFromImageData({ data: new Uint8ClampedArray(40), width: 100, height: 100 }) === null,
    "image shorter than its own dimensions returns null"
  );
  check(
    decodeQRFromImageData({ data: "not pixels", width: 4, height: 4 }) === null,
    "non-pixel data returns null"
  );
}

{
  // A symbol carrying nothing at all is refused rather than reported as an empty
  // success. The pipeline tries a good many grids before it gives up and the
  // empty string is the one result a caller cannot tell apart from failure, so
  // the guard is deliberate; this pins it down so it is not "fixed" by accident.
  const qr = encodeQR("", { ecl: "M" });
  check(decodeQRFromMatrix(qr.modules) === null, "an empty payload is refused, not returned as \"\"");
}

/* ---------------------------------------------------------------- summary */

console.log("");
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks`);
} else {
  console.log(`FAIL — ${failures.length} of ${passed + failures.length} checks failed`);
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exitCode = 1;
}
