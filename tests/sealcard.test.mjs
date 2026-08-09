/**
 * sealcard.test.mjs — proof that the disguise never costs a scan.
 *
 * Renders every theme at a spread of payload sizes, rasterises each card in a
 * real browser exactly the way a phone would see it (whole card, frame, seal,
 * emoji and all — not just the code region), and hands the pixels to jsQR. A
 * theme that does not round-trip its payload is a failing theme.
 *
 * A whole-card decode is the headline check but it is a lenient one: error
 * correction will carry a card that is quietly drawing several modules wrong,
 * right up until some other loss lands on top of it. So the module centres are
 * also sampled directly against the matrix, across a version sweep wide enough
 * to exercise the parts of the layout that only appear at size — alignment
 * patterns, version information, the odd step at version 32.
 *
 * Run: node tests/sealcard.test.mjs
 * Needs the scratchpad devDependencies (playwright, jsqr). Nothing here is
 * imported by shipped code.
 */

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

import { chromium } from "/tmp/claude-0/-home-user-Cousin-Congress/3ed12ed5-f595-5592-93db-45e4895ed3e3/scratchpad/node_modules/playwright/index.mjs";
import jsQRModule from "/tmp/claude-0/-home-user-Cousin-Congress/3ed12ed5-f595-5592-93db-45e4895ed3e3/scratchpad/node_modules/jsqr/dist/jsQR.js";

import { renderSealCard, moduleGrey } from "../js/sealcard.js";

const jsQR = jsQRModule.default ?? jsQRModule;

/** The image on this box is not the revision playwright-core wants; find it. */
function chromiumPath() {
  const root = "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  const build = readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort()
    .pop();
  const path = build && `${root}/${build}/chrome-linux/chrome`;
  return path && existsSync(path) ? path : undefined;
}

/**
 * The shipped module is loaded over http rather than injected as text, because
 * sealCardToPngBlob is only reachable through a real module graph: it imports
 * qr.js by relative path and it needs a document to draw on.
 */
function serveRepo() {
  const root = new URL("..", import.meta.url).pathname;
  const server = createServer((request, response) => {
    const path = request.url === "/" ? "/index.html" : request.url.split("?")[0];
    try {
      const body =
        path === "/index.html" ? "<!doctype html><meta charset=utf-8>" : readFileSync(root + path);
      const type = path.endsWith(".js") ? "text/javascript" : "text/html";
      response.writeHead(200, { "content-type": `${type}; charset=utf-8` });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/* -------------------------------------------------------------------------- */

/** Theme names, cross-checked below against what the module admits to having. */
const THEMES = ["chamber", "midnight", "rosette", "playground"];

const PAYLOADS = [
  { label: "short", text: "cc:join/ab12" },
  { label: "url", text: "https://cousin-congress.example/join#s=7hQ2mK9pR4tW" },
  { label: "ticket", text: `cc1:${"A7f9Kq2".repeat(12)}` },
  { label: "long", text: `cc1:${"Zx4Vb8Nm3Qw7Ly1Rt6".repeat(16)}` },
];

/**
 * Card widths in pixels to decode at. 900 is a comfortable share; 480 is a
 * thumbnail a chat app might hand back, and at the densest payload here that
 * leaves barely four pixels per module. If a theme is going to fall over, it
 * falls over at the small size first.
 */
const RASTER_WIDTHS = [480, 900];

/**
 * Versions worth sampling module-by-module, with the payload length that lands
 * on each at ECL Q. Version 1 has no alignment patterns at all, 7 is where
 * version information blocks appear, 32 is the one version whose alignment step
 * is a special case rather than the general formula, and 40 is the ceiling.
 * The theme rotates through the sweep: the fill is positional, so a mistake in
 * it shows up whatever the palette.
 */
const VERSION_PROBES = [
  { version: 1, length: 1 },
  { version: 7, length: 75 },
  { version: 14, length: 242 },
  { version: 32, length: 1031 },
  { version: 40, length: 1580 },
];

/** Wide enough that even a version 40 card gets ten pixels to a module. */
const FIDELITY_WIDTH = 2400;

const FILLER = "Zx4Vb8Nm3Qw7Ly1Rt6Kd5Sp0Hj2Gc9";
const stuffing = (length) =>
  FILLER.repeat(Math.ceil(length / FILLER.length)).slice(0, length);

/* -------------------------------------------------------------------------- */

const parseHex = (hex) => {
  const int = parseInt(hex.replace("#", ""), 16);
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
};

/** WCAG relative luminance — linear-light, unlike the decoder's grey. */
const relativeLuminance = (hex) => {
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrastRatio = (a, b) => {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * Pull the fills the card actually painted inside the code grid, so the report
 * reflects reality rather than the theme table. Scoped to the transformed group
 * — the seal above it is allowed bright colours, the modules are not.
 */
function inksUsedIn(svg) {
  const grid = svg.match(/<g transform="translate[^"]+">(.*?)<\/g>/s);
  const paths = [...(grid ? grid[1] : "").matchAll(/<path d="[^"]+" fill="(#[0-9a-f]{6})"\/>/g)].map(
    (m) => m[1]
  );
  return [...new Set(paths)];
}

function plaqueColourIn(svg) {
  const match = svg.match(/rx="24" fill="(#[0-9a-f]{6})"/);
  return match ? match[1] : "#ffffff";
}

/**
 * The card's layout, repeated here because the module exports no geometry and
 * should not have to. If these ever drift from sealcard.js the sampler starts
 * reading the wrong pixels and every version fails at once, which is a loud
 * enough failure to be worth the duplication.
 */
const GEOMETRY = { card: 660, plaqueX: 54, plaqueY: 382, pad: 12, codeSide: 528, quiet: 4 };

/**
 * Which modules a decoder would read wrong. It thresholds a neighbourhood and
 * then samples the centre of each cell, so the centre is the only part of a
 * module the styling may not touch — a shape that misses it, or a stylised
 * finder whose rounded corner eats its own corner modules, shows up here long
 * before it shows up as a failed scan.
 */
function centreMismatches(raster, qr, paper) {
  const pixels = Buffer.from(raster.base64, "base64");
  const ceiling = moduleGrey(paper) * 0.45;
  const scale = raster.width / GEOMETRY.card;
  const module = GEOMETRY.codeSide / (qr.size + GEOMETRY.quiet * 2);
  const originX = GEOMETRY.plaqueX + GEOMETRY.pad + GEOMETRY.quiet * module;
  const originY = GEOMETRY.plaqueY + GEOMETRY.pad + GEOMETRY.quiet * module;

  const wrong = [];
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      const px = Math.round((originX + (x + 0.5) * module) * scale);
      const py = Math.round((originY + (y + 0.5) * module) * scale);
      const i = (py * raster.width + px) * 4;
      const grey = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
      const shouldBeDark = qr.modules[y][x] === 1;
      if (shouldBeDark !== (grey <= ceiling)) {
        wrong.push(`(${x},${y}) ${shouldBeDark ? "dark" : "light"} read as grey ${grey.toFixed(0)}`);
      }
    }
  }
  return wrong;
}

/* -------------------------------------------------------------------------- */

let failures = 0;
const check = (ok, message) => {
  if (!ok) {
    failures += 1;
    console.log(`  FAIL  ${message}`);
  }
  return ok;
};

async function main() {
  // The module exports only its two functions plus the grey helper, so the
  // theme list is discovered through the error it throws for an unknown one.
  let advertised = [];
  try {
    renderSealCard({ payload: "x", theme: "not-a-theme" });
  } catch (error) {
    advertised = (error.message.match(/Available: (.+)\./) || [, ""])[1]
      .split(", ")
      .filter(Boolean);
  }
  check(
    advertised.join(",") === THEMES.join(","),
    `theme list drifted: module offers [${advertised}], test covers [${THEMES}]`
  );
  check(advertised.length >= 3, "fewer than three themes are available");

  console.log("Contrast (dark module ink vs plaque paper)");
  console.log("  theme        ink       grey   ceiling  WCAG");
  for (const theme of THEMES) {
    const { svg } = renderSealCard({ payload: "contrast probe", theme });
    const paper = plaqueColourIn(svg);
    const ceiling = moduleGrey(paper) * 0.45;
    for (const ink of inksUsedIn(svg)) {
      const grey = moduleGrey(ink);
      const ratio = contrastRatio(ink, paper);
      console.log(
        `  ${theme.padEnd(12)} ${ink}  ${grey.toFixed(1).padStart(5)}  ` +
          `${ceiling.toFixed(1).padStart(6)}  ${ratio.toFixed(2).padStart(5)}:1`
      );
      check(grey <= ceiling, `${theme}: ink ${ink} grey ${grey.toFixed(1)} over ceiling`);
      check(ratio >= 4.5, `${theme}: ink ${ink} contrast ${ratio.toFixed(2)}:1 under 4.5:1`);
    }
  }

  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const page = await browser.newPage();

  console.log("\nDecode");
  for (const theme of THEMES) {
    for (const payload of PAYLOADS) {
      const { svg, qr, bytes } = renderSealCard({
        payload: payload.text,
        name: "Wren Ashdown-Vale",
        icon: "🦉",
        subtitle: "Sworn in, spring session",
        theme,
      });

      check(!/<image|href=/.test(svg), `${theme}/${payload.label}: svg references something external`);

      let line =
        `  ${theme.padEnd(11)} ${payload.label.padEnd(7)} v${String(qr.version).padStart(2)} ` +
        `${qr.ecl} ${String(bytes.length).padStart(4)}B `;
      for (const width of RASTER_WIDTHS) {
        const raster = await page.evaluate(rasterise, { svg, width });
        const pixels = new Uint8ClampedArray(Buffer.from(raster.base64, "base64"));
        const result = jsQR(pixels, raster.width, raster.height);
        const ok = check(
          result && result.data === payload.text,
          `${theme}/${payload.label} at ${width}px: ` +
            `${result ? "decoded the wrong payload" : "did not decode"}`
        );
        const perModule = ((raster.width * (528 / 660)) / (qr.size + 8)).toFixed(1);
        line += ` ${width}px:${ok ? "ok" : "FAIL"}(${perModule}px/module)`;
      }
      console.log(line);
    }
  }

  console.log("\nModule centres");
  for (const [index, probe] of VERSION_PROBES.entries()) {
    const theme = THEMES[index % THEMES.length];
    const { svg, qr } = renderSealCard({ payload: stuffing(probe.length), theme });
    if (!check(qr.version === probe.version, `expected v${probe.version}, encoder chose v${qr.version}`)) {
      continue;
    }
    const raster = await page.evaluate(rasterise, { svg, width: FIDELITY_WIDTH });
    const wrong = centreMismatches(raster, qr, plaqueColourIn(svg));
    const ok = check(
      wrong.length === 0,
      `v${qr.version}/${theme}: ${wrong.length} module(s) read wrong, first ${wrong[0]}`
    );
    console.log(
      `  v${String(qr.version).padStart(2)} ${theme.padEnd(11)} ${String(qr.size).padStart(3)}²  ` +
        `${ok ? "ok" : "FAIL"}  ${qr.size * qr.size} modules checked`
    );
  }

  // Text on the card is attacker-adjacent in the mildest way — a cousin types
  // their own name — but it lands in markup, and markup that does not parse is
  // a card that renders as nothing at all.
  console.log("\nEscaping");
  const hostile = renderSealCard({
    payload: "cc:x&y<z\"q'",
    name: "A & B <script>alert(1)</script>",
    icon: "👩🏽‍⚖️",
    subtitle: "O'Brien \"quoted\" & <b>bold</b>",
  });
  check(!/<script/.test(hostile.svg), "a name got through as live markup");
  check(
    (hostile.svg.match(/&(?!(amp|lt|gt|quot|apos);)/g) || []).length === 0,
    "the svg carries a bare ampersand and will not parse as xml"
  );
  const parsed = await page.evaluate((svg) => {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    return doc.querySelector("parsererror")?.textContent ?? "";
  }, hostile.svg);
  check(parsed === "", `hostile card is not well-formed xml: ${parsed.slice(0, 120)}`);
  console.log(`  ok    parses as xml, ${hostile.svg.length}B, script tag neutralised`);

  // Non-ASCII has to survive as UTF-8 bytes, not as whatever the decoder
  // guesses the text was: the payload is a ticket, and a mangled ticket is
  // worse than no ticket.
  const unicode = "cc:🦉 Ünïcøde 日本語";
  const uni = renderSealCard({ payload: unicode });
  check(
    new TextDecoder().decode(uni.bytes) === unicode,
    "utf-8 payload did not survive the encode"
  );
  const uniRaster = await page.evaluate(rasterise, { svg: uni.svg, width: 900 });
  const uniResult = jsQR(
    new Uint8ClampedArray(Buffer.from(uniRaster.base64, "base64")),
    uniRaster.width,
    uniRaster.height
  );
  check(
    uniResult && Buffer.from(uniResult.binaryData).equals(Buffer.from(uni.bytes)),
    "utf-8 payload did not decode back to the same bytes"
  );
  console.log(`  ok    ${uni.bytes.length} utf-8 bytes decoded back byte for byte`);

  // Two cards from the same arguments must be the same card. Anything else and
  // a re-render invalidates a code someone has already printed.
  const twice = ["chamber", "midnight"].map((theme) =>
    [0, 1].map(() => renderSealCard({ payload: "cc:join/ab12", theme }).svg)
  );
  check(
    twice.every(([first, second]) => first === second),
    "the same arguments produced two different cards"
  );

  console.log("\nRefusals");
  const refuses = (label, args, pattern) => {
    let message = null;
    try {
      renderSealCard(args);
    } catch (error) {
      message = error.message;
    }
    const ok = check(
      message !== null && pattern.test(message),
      `${label}: ${message === null ? "did not throw" : `threw "${message}"`}`
    );
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);
  };
  refuses("no arguments", undefined, /payload/i);
  refuses("no payload", {}, /payload/i);
  refuses("empty payload", { payload: "" }, /payload/i);
  refuses("unknown theme", { payload: "x", theme: "sparkle" }, /Available: chamber, midnight/);
  refuses("payload beyond version 40", { payload: stuffing(4000) }, /./);

  // The PNG path, driven through the real module in a real page: a card
  // rasterised by sealCardToPngBlob must still decode after the round trip.
  console.log("\nsealCardToPngBlob");
  const { server, port } = await serveRepo();
  await page.goto(`http://127.0.0.1:${port}/`);
  const png = await page.evaluate(pngRoundTrip, PAYLOADS[1].text);
  server.close();

  check(png.type === "image/png", `blob type was ${png.type}, expected image/png`);
  check(png.bytes > 1000, `blob was only ${png.bytes} bytes`);
  check(png.width === 1024, `blob rasterised to ${png.width}px, expected 1024`);
  const decoded = jsQR(
    new Uint8ClampedArray(Buffer.from(png.base64, "base64")),
    png.width,
    png.height
  );
  const pngOk = check(
    decoded && decoded.data === PAYLOADS[1].text,
    `png round trip: ${decoded ? "decoded the wrong payload" : "did not decode"}`
  );
  console.log(
    `  ${pngOk ? "ok  " : "FAIL"}  ${png.width}x${png.height}px ${png.type} ${png.bytes}B, decoded`
  );

  await browser.close();

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Runs inside the page: paint the SVG through the same Image + canvas route
 * sealCardToPngBlob uses, then ship the raw RGBA back as base64 (a plain array
 * of five million numbers crawls over the CDP bridge).
 */
async function rasterise({ svg, width }) {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("svg failed to load"));
    image.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round((image.naturalHeight / image.naturalWidth) * width);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);

  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let binary = "";
  for (let i = 0; i < data.length; i += 8192) {
    binary += String.fromCharCode.apply(null, data.subarray(i, i + 8192));
  }
  return { width: canvas.width, height: canvas.height, base64: btoa(binary) };
}

/**
 * Runs inside the page: build a card, put it through the shipped PNG encoder,
 * then decode that PNG back to pixels the way a receiving app would.
 */
async function pngRoundTrip(payload) {
  const { renderSealCard, sealCardToPngBlob } = await import("/js/sealcard.js");
  const { svg } = renderSealCard({ payload, name: "Wren Ashdown-Vale", theme: "chamber" });
  const blob = await sealCardToPngBlob(svg, { size: 1024 });

  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const data = canvas.getContext("2d").getImageData(0, 0, bitmap.width, bitmap.height).data;

  let binary = "";
  for (let i = 0; i < data.length; i += 8192) {
    binary += String.fromCharCode.apply(null, data.subarray(i, i + 8192));
  }
  return {
    type: blob.type,
    bytes: blob.size,
    width: bitmap.width,
    height: bitmap.height,
    base64: btoa(binary),
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
