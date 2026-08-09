/**
 * sealcard.js — the Seal Card: an invite that happens to be a scannable code.
 *
 * A plain black-and-white QR reads as machinery. Nobody drops one in the family
 * chat for fun. So the same matrix js/qr.js produces gets dressed as a little
 * membership certificate — great seal, emoji badge, name, subtitle — and the
 * code itself becomes the ornament in the middle of the card.
 *
 * The disguise is skin deep on purpose. This invents no symbology: every module
 * keeps its position and its dark/light meaning, the quiet zone is untouched,
 * the finder and alignment patterns keep their exact ring structure, and every
 * colour used for a dark module is forced below a brightness ceiling before it
 * is drawn. Decoders binarise on brightness and sample the centre of each
 * module, so shape and hue are free; luminance is not. A pretty code that does
 * not scan is a broken code, and the guard in inkFor() is what stops a future
 * theme author from breaking one by picking a cheerful yellow.
 */

import { encodeQR } from "./qr.js";

/* --------------------------------------------------------------------------
   Geometry

   All figures are user units in the card's own viewBox. Portrait, roughly
   1:1.58, which is close enough to a photo aspect that chat apps do not crop
   the caption off the bottom.
   -------------------------------------------------------------------------- */

const CARD = { width: 660, height: 1040 };

const SEAL = { cx: 330, cy: 178, r: 92 };

/** The code sits on its own light plaque so the card frame can be any colour. */
const PLAQUE = { x: 54, y: 382, size: 552, pad: 12, radius: 24 };

/** Modules of quiet zone. The spec asks for four and cameras genuinely use it. */
const QUIET = 4;

/**
 * Error correction level Q. Stylised modules cost a decoder a little confidence
 * at the edges of each cell, and a card that gets screenshotted, re-compressed
 * and re-photographed loses more, so we buy the headroom rather than the extra
 * few bytes of capacity.
 */
const ECL = "Q";

/* --------------------------------------------------------------------------
   Themes
   -------------------------------------------------------------------------- */

/**
 * Every theme keeps a light plaque under the code even when the card around it
 * is dark. Inverted codes do decode on some readers and not others, and "some
 * readers" is not good enough for a card a seven-year-old is going to hold up
 * to a phone.
 */
const THEMES = {
  chamber: {
    label: "Chamber",
    card: "#f7f5ef",
    frame: "#1b3fd8",
    plaque: "#fffdf8",
    plaqueEdge: "#dde2ec",
    heading: "#0b1c4a",
    body: "#38425a",
    eyebrow: "#1b3fd8",
    sealCore: "#0b1c4a",
    sealRing: "#1b3fd8",
    sealDash: "#e0243c",
    sealBand: "#ffc21a",
    inks: ["#1b3fd8", "#e0243c", "#8a5e04"],
  },
  midnight: {
    label: "Midnight session",
    card: "#071232",
    frame: "#ffc21a",
    plaque: "#f2f5ff",
    plaqueEdge: "#122c73",
    heading: "#fffdf8",
    body: "#b9c7ff",
    eyebrow: "#ffd447",
    sealCore: "#122c73",
    sealRing: "#ffc21a",
    sealDash: "#e0243c",
    sealBand: "#b9c7ff",
    inks: ["#122c73", "#c11530", "#8a5e04"],
  },
  rosette: {
    label: "Rosette",
    card: "#fff6d9",
    frame: "#c11530",
    plaque: "#fff8f4",
    plaqueEdge: "#ffc4cd",
    heading: "#8f1224",
    body: "#5c6781",
    eyebrow: "#c11530",
    sealCore: "#8f1224",
    sealRing: "#c11530",
    sealDash: "#1b3fd8",
    sealBand: "#ffc21a",
    inks: ["#c11530", "#8f1224", "#1b3fd8"],
  },
  playground: {
    label: "Playground",
    card: "#e4e9ff",
    frame: "#2f57ff",
    plaque: "#ffffff",
    plaqueEdge: "#b9c7ff",
    heading: "#071232",
    body: "#38425a",
    eyebrow: "#e0243c",
    sealCore: "#1b3fd8",
    sealRing: "#e0243c",
    sealDash: "#ffc21a",
    sealBand: "#17a463",
    inks: ["#1b3fd8", "#e0243c", "#a06b00"],
  },
};

const FONT_DISPLAY =
  "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif";
const FONT_BODY = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/* --------------------------------------------------------------------------
   Colour
   -------------------------------------------------------------------------- */

function parseHex(hex) {
  const value = String(hex).replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  const int = parseInt(full, 16);
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}

const toHex = (rgb) =>
  `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;

/**
 * The brightness a decoder actually sees: Rec.709 weights applied straight to
 * the gamma-encoded channels, which is what image binarisers do rather than
 * the linear-light luminance colour science would ask for. Matching the
 * decoder's arithmetic is the point — being right about human perception here
 * would tell us nothing useful.
 */
export function moduleGrey(hex) {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Local thresholding puts the black point near the midpoint of the dark and
 * light greys in a neighbourhood, so a dark module at 45% of the paper's
 * brightness still lands a long way under it. Anything brighter than that gets
 * scaled toward black.
 */
const INK_CEILING = 0.45;

/**
 * Force a colour dark enough to survive binarisation against a given paper.
 * Scaling all three channels by the same factor keeps the hue and the
 * saturation ratio, so brass stays recognisably brass — just aged into bronze
 * rather than the bright #ffc21a it starts life as. It darkens faster than a
 * proper linear-light scale would, which is the direction we want to err in.
 */
function inkFor(hex, paper) {
  const ceiling = moduleGrey(paper) * INK_CEILING;
  const grey = moduleGrey(hex);
  if (grey <= ceiling) return hex;
  return toHex(parseHex(hex).map((channel) => channel * (ceiling / grey)));
}

/* --------------------------------------------------------------------------
   Module shapes

   Paths are written in module units and placed by a group transform, so the
   numbers below stay readable and the whole grid is one scale away from any
   card size. Each shape covers the centre of its cell with room to spare:
   decoders sample the middle of a module, so that is the part that must never
   be clipped by a rounded corner or a triangle's slope.
   -------------------------------------------------------------------------- */

const num = (value) => String(Math.round(value * 1000) / 1000);

/** Full-bleed dot, touching its neighbours so runs of modules stay connected. */
const dotPath = (x, y) =>
  `M${num(x)} ${num(y + 0.5)}a.5.5 0 1 0 1 0a.5.5 0 1 0-1 0z`;

const squarePath = (x, y, r = 0.3) => {
  const span = num(1 - 2 * r);
  return (
    `M${num(x + r)} ${num(y)}h${span}q${num(r)} 0 ${num(r)} ${num(r)}` +
    `v${span}q0 ${num(r)} ${num(-r)} ${num(r)}h${num(-(1 - 2 * r))}` +
    `q${num(-r)} 0 ${num(-r)} ${num(-r)}v${num(-(1 - 2 * r))}q0 ${num(-r)} ${num(r)} ${num(-r)}z`
  );
};

/** Alternating up/down triangles read as a chevron weave rather than confetti. */
const trianglePath = (x, y, up) =>
  up
    ? `M${num(x + 0.5)} ${num(y + 0.04)}L${num(x + 0.98)} ${num(y + 0.96)}L${num(x + 0.02)} ${num(y + 0.96)}z`
    : `M${num(x + 0.5)} ${num(y + 0.96)}L${num(x + 0.98)} ${num(y + 0.04)}L${num(x + 0.02)} ${num(y + 0.04)}z`;

/**
 * Shape and colour both come from the coordinates, but on different diagonals:
 * colour bands run one way at a pitch of three, shape blocks run the other way
 * in pairs. The two lattices crossing is what makes the fill look woven and
 * deliberate instead of speckled, and it costs nothing at decode time because
 * the underlying module values are untouched.
 */
const inkIndex = (x, y) => (x + 2 * y) % 3;
const shapeIndex = (x, y) => ((x >> 1) + (y >> 1)) % 3;

function modulePath(x, y) {
  switch (shapeIndex(x, y)) {
    case 0:
      return dotPath(x, y);
    case 1:
      return squarePath(x, y);
    default:
      return trianglePath(x, y, (x + y) % 2 === 0);
  }
}

/* --------------------------------------------------------------------------
   Function patterns

   qr.js does not export the alignment pattern positions and must not be
   modified, so the placement rule from the spec is repeated here. It is four
   lines and it has not changed since 2000; the alternative is scanning the
   matrix for concentric squares and guessing.
   -------------------------------------------------------------------------- */

function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 10; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** Centres of every pattern that must be drawn as a solid concentric eye. */
function eyeCentres(qr) {
  const last = qr.size - 4;
  const eyes = [
    { cx: 3, cy: 3, radius: 3 },
    { cx: last, cy: 3, radius: 3 },
    { cx: 3, cy: last, radius: 3 },
  ];

  const positions = alignmentPositions(qr.version);
  positions.forEach((cy, i) => {
    positions.forEach((cx, j) => {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === positions.length - 1) ||
        (i === positions.length - 1 && j === 0);
      if (!corner) eyes.push({ cx, cy, radius: 2 });
    });
  });
  return eyes;
}

/**
 * A finder or alignment pattern drawn as a seal: rounded rings, but the ring
 * widths are still exactly one module and the centre is still exactly its
 * proper size, so the 1:1:3:1:1 run a locator scans for survives intact.
 *
 * The corner radius is the only liberty taken, and it is bounded by the corner
 * module rather than by taste. A rounded rect of radius r misses its corner
 * cell's centre once the arc cuts inside (0.5, 0.5) from the corner, leaving
 * r - (r - 0.5)*sqrt(2) modules of cover; that goes negative at r = 1.707, so
 * a ring rounded any harder than that simply deletes the four corner modules
 * of the pattern. The values below all keep at least a quarter of a module of
 * cover, which is what a decoder sampling the centre needs to still find ink.
 */
function eyeMarkup(eye, ink, paper) {
  const span = eye.radius * 2 + 1;
  const x = eye.cx - eye.radius;
  const y = eye.cy - eye.radius;
  const outerR = eye.radius === 3 ? 1.1 : 0.9;
  const middleR = eye.radius === 3 ? 0.85 : 0.6;
  const coreR = eye.radius === 3 ? 0.6 : 0.3;

  return (
    `<rect x="${num(x)}" y="${num(y)}" width="${span}" height="${span}" rx="${num(outerR)}" fill="${ink}"/>` +
    `<rect x="${num(x + 1)}" y="${num(y + 1)}" width="${span - 2}" height="${span - 2}" ` +
    `rx="${num(middleR)}" fill="${paper}"/>` +
    `<rect x="${num(x + 2)}" y="${num(y + 2)}" width="${span - 4}" height="${span - 4}" ` +
    `rx="${num(coreR)}" fill="${ink}"/>`
  );
}

/* --------------------------------------------------------------------------
   Text
   -------------------------------------------------------------------------- */

const escapeXml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * The caption exists so a person can read what the code says without a camera:
 * someone forwards a screenshot, someone else types it in. Schemes are dropped
 * because they are noise on a card, and long payloads are cut in the middle so
 * the tail — usually the part that identifies the invite — stays visible.
 */
function captionFor(payload) {
  const text = String(payload).replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  if (text.length <= 44) return text;
  return `${text.slice(0, 26)}…${text.slice(-14)}`;
}

/* --------------------------------------------------------------------------
   Public API
   -------------------------------------------------------------------------- */

/**
 * Render a Seal Card.
 *
 * @param {object} options
 * @param {string} options.payload  what the code carries; encoded as UTF-8.
 * @param {string} [options.name]     the member's name, set large under the seal.
 * @param {string} [options.icon]     their emoji badge, sat in the seal's core.
 * @param {string} [options.subtitle] one line of context under the name.
 * @param {string} [options.theme]    a key of the theme table.
 * @returns {{svg:string, qr:object, bytes:Uint8Array}} the card, the matrix it
 *   was drawn from, and the exact bytes that were encoded.
 */
export function renderSealCard({
  payload,
  name = "Cousin",
  icon = "🦉",
  subtitle = "Member of the Cousin Congress",
  theme = "chamber",
} = {}) {
  if (payload === undefined || payload === null || payload === "") {
    throw new Error("renderSealCard needs a payload to put in the code.");
  }
  const palette = THEMES[theme];
  if (!palette) {
    throw new Error(
      `Unknown Seal Card theme "${theme}". Available: ${Object.keys(THEMES).join(", ")}.`
    );
  }

  const bytes = new TextEncoder().encode(String(payload));
  const qr = encodeQR(bytes, { ecl: ECL });

  const paper = palette.plaque;
  const inks = palette.inks.map((ink) => inkFor(ink, paper));

  const codeSide = PLAQUE.size - PLAQUE.pad * 2;
  const module = codeSide / (qr.size + QUIET * 2);
  const originX = PLAQUE.x + PLAQUE.pad + QUIET * module;
  const originY = PLAQUE.y + PLAQUE.pad + QUIET * module;

  // Mark the eyes first so the shape pass can leave those cells alone.
  const eyes = eyeCentres(qr);
  const reserved = Array.from({ length: qr.size }, () => new Uint8Array(qr.size));
  for (const eye of eyes) {
    for (let dy = -eye.radius; dy <= eye.radius; dy += 1) {
      for (let dx = -eye.radius; dx <= eye.radius; dx += 1) {
        reserved[eye.cy + dy][eye.cx + dx] = 1;
      }
    }
  }

  // One path per ink rather than one element per module: a dense code is a few
  // thousand modules, and three paths keep the card small enough to paste into
  // a chat without a second thought.
  const paths = inks.map(() => "");
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (!qr.modules[y][x] || reserved[y][x]) continue;
      paths[inkIndex(x, y)] += modulePath(x, y);
    }
  }

  const grid =
    `<g transform="translate(${num(originX)} ${num(originY)}) scale(${num(module)})">` +
    paths.map((d, i) => (d ? `<path d="${d}" fill="${inks[i]}"/>` : "")).join("") +
    eyes.map((eye, i) => eyeMarkup(eye, inks[i % inks.length], paper)).join("") +
    `</g>`;

  const caption = captionFor(payload);
  const titleText = `Seal Card for ${name}`;
  const descText =
    `A Cousin Congress invite card in the ${palette.label} theme. ` +
    `The pattern in the middle is a scannable code containing: ${caption}`;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD.width}" height="${CARD.height}" ` +
    `viewBox="0 0 ${CARD.width} ${CARD.height}" role="img" ` +
    `aria-labelledby="sealcard-title sealcard-desc">` +
    `<title id="sealcard-title">${escapeXml(titleText)}</title>` +
    `<desc id="sealcard-desc">${escapeXml(descText)}</desc>` +
    cardFrame(palette) +
    sealMarkup(palette, icon) +
    headingMarkup(palette, name, subtitle) +
    plaqueMarkup(palette) +
    grid +
    captionMarkup(palette, caption) +
    `</svg>`;

  return { svg, qr, bytes };
}

function cardFrame(palette) {
  return (
    `<rect width="${CARD.width}" height="${CARD.height}" fill="${palette.card}"/>` +
    `<rect x="14" y="14" width="${CARD.width - 28}" height="${CARD.height - 28}" rx="28" ` +
    `fill="none" stroke="${palette.frame}" stroke-width="3"/>` +
    `<rect x="24" y="24" width="${CARD.width - 48}" height="${CARD.height - 48}" rx="20" ` +
    `fill="none" stroke="${palette.frame}" stroke-width="1" stroke-opacity="0.45"/>`
  );
}

/**
 * The great seal from the site's masthead, redrawn as flat geometry.
 *
 * The ring widths here are deliberately nothing like a finder pattern's
 * 1:1:3:1:1. Concentric rings are exactly the shape a locator hunts for, and a
 * decorative seal that accidentally reads as a fourth finder would send the
 * perspective transform somewhere silly. Thin rings, wide gaps, and a dashed
 * middle ring that breaks up most scan lines keep it clearly not-a-finder.
 */
function sealMarkup(palette, icon) {
  const { cx, cy, r } = SEAL;

  // The beads sit a little outside the rim rather than on it: on it they read
  // as damage to the ring, just beyond it they read as orbiting.
  const rim = r + 3;
  const orbit = [
    { x: cx, y: cy - rim, shape: "circle", fill: palette.sealDash },
    { x: cx + rim * 0.87, y: cy + rim * 0.5, shape: "square", fill: palette.sealBand },
    { x: cx - rim * 0.87, y: cy + rim * 0.5, shape: "triangle", fill: palette.sealRing },
  ];

  const orbitMarkup = orbit
    .map((item) => {
      if (item.shape === "circle") {
        return `<circle cx="${num(item.x)}" cy="${num(item.y)}" r="9" fill="${item.fill}"/>`;
      }
      if (item.shape === "square") {
        return (
          `<rect x="${num(item.x - 8)}" y="${num(item.y - 8)}" width="16" height="16" rx="3" ` +
          `fill="${item.fill}" transform="rotate(20 ${num(item.x)} ${num(item.y)})"/>`
        );
      }
      return (
        `<path d="M${num(item.x)} ${num(item.y - 9)}L${num(item.x + 9)} ${num(item.y + 7)}` +
        `L${num(item.x - 9)} ${num(item.y + 7)}z" fill="${item.fill}"/>`
      );
    })
    .join("");

  return (
    `<g>` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${palette.sealRing}" stroke-width="2.5"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r - 10}" fill="none" stroke="${palette.sealDash}" ` +
    `stroke-width="2" stroke-dasharray="7 7"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r - 22}" fill="none" stroke="${palette.sealBand}" stroke-width="9"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r - 40}" fill="${palette.sealCore}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r - 44}" fill="none" stroke="${palette.sealBand}" ` +
    `stroke-width="2" stroke-opacity="0.7"/>` +
    orbitMarkup +
    `<text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="44" ` +
    `font-family="${FONT_BODY}">${escapeXml(icon)}</text>` +
    `</g>`
  );
}

function headingMarkup(palette, name, subtitle) {
  return (
    `<text x="${CARD.width / 2}" y="54" text-anchor="middle" font-family="${FONT_BODY}" ` +
    `font-size="13" font-weight="700" letter-spacing="3.4" fill="${palette.eyebrow}">` +
    `COUSIN CONGRESS</text>` +
    `<text x="${CARD.width / 2}" y="322" text-anchor="middle" font-family="${FONT_DISPLAY}" ` +
    `font-size="42" font-weight="700" fill="${palette.heading}">${escapeXml(name)}</text>` +
    `<text x="${CARD.width / 2}" y="356" text-anchor="middle" font-family="${FONT_BODY}" ` +
    `font-size="17" fill="${palette.body}">${escapeXml(subtitle)}</text>`
  );
}

function plaqueMarkup(palette) {
  return (
    `<rect x="${PLAQUE.x}" y="${PLAQUE.y}" width="${PLAQUE.size}" height="${PLAQUE.size}" ` +
    `rx="${PLAQUE.radius}" fill="${palette.plaque}" stroke="${palette.plaqueEdge}" stroke-width="1.5"/>`
  );
}

function captionMarkup(palette, caption) {
  return (
    `<text x="${CARD.width / 2}" y="976" text-anchor="middle" font-family="${FONT_BODY}" ` +
    `font-size="19" fill="${palette.heading}">${escapeXml(caption)}</text>` +
    `<text x="${CARD.width / 2}" y="1006" text-anchor="middle" font-family="${FONT_BODY}" ` +
    `font-size="12" font-weight="700" letter-spacing="2.6" fill="${palette.body}">` +
    `POINT A CAMERA AT THE PICTURE</text>`
  );
}

/**
 * Rasterise a card to a PNG Blob, because chat apps and printers want a bitmap
 * and phone cameras are happier with one too.
 *
 * Browser only — there is no canvas to draw on anywhere else, and shipping a
 * rasteriser of our own would be a far bigger dependency than the one platform
 * already provides. The SVG goes through an object URL rather than a data URL:
 * same-origin so the canvas stays untainted and toBlob keeps working, and no
 * base64 inflation for a card that can run to tens of kilobytes.
 *
 * @param {string} svg  markup from renderSealCard.
 * @param {{size?:number}} [options] target width in pixels; height follows the
 *   card's aspect ratio.
 * @returns {Promise<Blob>}
 */
export function sealCardToPngBlob(svg, { size = 1024 } = {}) {
  if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function") {
    return Promise.reject(new Error("sealCardToPngBlob needs a browser: it rasterises via canvas."));
  }

  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));

  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => {
      try {
        const width = image.naturalWidth || CARD.width;
        const height = image.naturalHeight || CARD.height;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(size));
        canvas.height = Math.max(1, Math.round((height / width) * canvas.width));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error("The browser refused to encode the Seal Card as a PNG."));
        }, "image/png");
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(url);
      }
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The Seal Card SVG could not be loaded for rasterising."));
    };

    image.src = url;
  });
}
