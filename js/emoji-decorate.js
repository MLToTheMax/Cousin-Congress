/**
 * emoji-decorate.js — a cousin decorates their badge.
 *
 * The catalogue in emoji.js gets a member to "the fox". This gets them to
 * "MY fox": the same glyph on a grape circle with a crown is unmistakably a
 * different cousin from the same glyph on a mint shield. That matters because
 * a House of a dozen cousins runs out of distinctive animals faster than it
 * runs out of children, and two identical badges on the roster is exactly the
 * confusion the badge existed to prevent.
 *
 * The result is stored as a spec — {emoji, bg, shape, accessory, ring} — and
 * never as the rendered SVG. Every member record replicates to every peer, so
 * the field has to stay small; a spec is five short strings, the SVG it turns
 * into is around a kilobyte. Storing the spec also means a later change to the
 * shapes or the palette re-renders every existing badge, which storing the
 * markup would have frozen.
 *
 * The colours are literal hex rather than theme tokens. A badge is the same
 * badge in a night session as in a day one — a cousin who picked the yellow
 * one should not have to re-identify themselves after dark — and the same
 * string has to survive being dropped into a QR seal card or a downloaded
 * export, neither of which carries our stylesheet.
 */

import { esc, h, raw } from "./ui.js";
import { emojiName, mountEmojiPicker, RANDOM_BADGE } from "./emoji.js";

/* --------------------------------------------------------------------------
   Vocabulary

   Every part of a spec is an id into one of these tables, never a raw colour
   or a raw path. That keeps the stored record short, but it is also the whole
   injection defence for four of the five fields: an unknown id from a peer
   falls back to the default instead of reaching the SVG. Only `emoji` is free
   text, and that one goes through esc().
   -------------------------------------------------------------------------- */

/** Mid-tone by design: a badge has to hold a black-outlined glyph legibly. */
export const BADGE_COLOURS = [
  { id: "sun", label: "Sunshine", hex: "#ffc21a" },
  { id: "coral", label: "Coral", hex: "#ff7a6b" },
  { id: "rose", label: "Rose", hex: "#ff9ec4" },
  { id: "grape", label: "Grape", hex: "#a06bff" },
  { id: "sky", label: "Sky", hex: "#4aa8ff" },
  { id: "sea", label: "Sea", hex: "#1b8fa8" },
  { id: "mint", label: "Mint", hex: "#34d39e" },
  { id: "lime", label: "Lime", hex: "#b6e34a" },
  { id: "sand", label: "Sand", hex: "#e7d5a8" },
  { id: "slate", label: "Slate", hex: "#7b89a8" },
  { id: "ink", label: "Ink", hex: "#1b2438" },
  { id: "paper", label: "Paper", hex: "#fffdf8" },
];

/**
 * `glyph` and `dy` are per shape because the usable area is not: a star has
 * to seat its emoji in the small pentagon at the middle, and a shield's mass
 * sits above its centre, so a glyph parked at 32,32 in both reads as centred
 * in one and as sliding out the bottom of the other.
 */
export const BADGE_SHAPES = [
  {
    id: "circle",
    label: "Circle",
    glyph: 34,
    dy: 0,
    path: "M32 3a29 29 0 1 1 0 58 29 29 0 1 1 0-58z",
  },
  {
    id: "round",
    label: "Rounded square",
    glyph: 34,
    dy: 0,
    path: "M19 3h26a16 16 0 0 1 16 16v26a16 16 0 0 1-16 16H19a16 16 0 0 1-16-16V19a16 16 0 0 1 16-16z",
  },
  {
    id: "shield",
    label: "Shield",
    glyph: 30,
    dy: -2,
    path: "M32 3 59 12v20c0 14-11 24-27 29C16 56 5 46 5 32V12z",
  },
  {
    id: "star",
    label: "Star",
    glyph: 23,
    dy: 3,
    path: "M32 2 39.6 21.5 60.5 22.7 44.4 36 49.6 56.3 32 45 14.4 56.3 19.6 36 3.5 22.7 24.4 21.5Z",
  },
];

/**
 * Accessory glyphs follow the same single-code-point rule as the catalogue in
 * emoji.js — no ZWJ, no variation selector — so a spec survives a trip through
 * a chat app or an export without arriving as two boxes.
 *
 * Headwear is worn and everything else is a sticker. A crown pinned to the
 * top-right corner reads as a mistake rather than a decoration, so hat and
 * crown sit centred on the crown of the badge and the rest take the corner.
 */
export const BADGE_ACCESSORIES = [
  { id: "hat", label: "Top hat", char: "🎩", x: 32, y: 9, size: 26 },
  { id: "crown", label: "Crown", char: "👑", x: 32, y: 9, size: 26 },
  { id: "glasses", label: "Glasses", char: "👓", x: 48, y: 14, size: 22 },
  { id: "sparkle", label: "Sparkles", char: "✨", x: 48, y: 14, size: 22 },
  { id: "bow", label: "Bow", char: "🎀", x: 48, y: 14, size: 22 },
  { id: "star", label: "Gold star", char: "⭐", x: 48, y: 14, size: 22 },
];

const COLOUR_BY_ID = new Map(BADGE_COLOURS.map((c) => [c.id, c]));
const SHAPE_BY_ID = new Map(BADGE_SHAPES.map((s) => [s.id, s]));
const ACCESSORY_BY_ID = new Map(BADGE_ACCESSORIES.map((a) => [a.id, a]));

/**
 * A slightly-surprised face on sky blue: recognisably unfinished, so a member
 * who never opened the decorator still gets something rather than a blank, and
 * anyone looking at the roster can tell it was never chosen.
 */
export const DEFAULT_AVATAR = Object.freeze({
  emoji: "🙂",
  bg: "sky",
  shape: "circle",
  accessory: "",
  ring: "",
});

/* The emoji families most likely to be read as "a cousin" at 32px. */
const EMOJI_FONTS = "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji','Twemoji Mozilla',sans-serif";

/* --------------------------------------------------------------------------
   The spec
   -------------------------------------------------------------------------- */

/**
 * Coerce anything into a spec we are willing to render. Specs arrive from the
 * op log, which is to say from other people's devices, so this is a trust
 * boundary and not a convenience: unknown ids become defaults and the glyph is
 * clamped to a single code point (the same rule emoji.js enforces, applied
 * here because nothing guarantees the value came from our own picker).
 */
export function normaliseSpec(spec) {
  const input = spec && typeof spec === "object" ? spec : {};
  const glyph = [...String(input.emoji ?? "")][0] || DEFAULT_AVATAR.emoji;
  return {
    emoji: glyph,
    bg: COLOUR_BY_ID.has(input.bg) ? input.bg : DEFAULT_AVATAR.bg,
    shape: SHAPE_BY_ID.has(input.shape) ? input.shape : DEFAULT_AVATAR.shape,
    accessory: ACCESSORY_BY_ID.has(input.accessory) ? input.accessory : "",
    ring: COLOUR_BY_ID.has(input.ring) ? input.ring : "",
  };
}

const pickOne = (list) => {
  const random = globalThis.crypto?.getRandomValues
    ? crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32
    : Math.random();
  return list[Math.floor(random * list.length)];
};

/** A whole badge at random — the "surprise me" a child actually wants. */
export function randomSpec() {
  return {
    emoji: RANDOM_BADGE(),
    bg: pickOne(BADGE_COLOURS).id,
    shape: pickOne(BADGE_SHAPES).id,
    // Two thirds of random badges get no accessory and no ring: when every
    // roll comes back maximally decorated they all start to look the same,
    // which is the opposite of what the decorator is for.
    accessory: pickOne([...BADGE_ACCESSORIES, null, null, null])?.id ?? "",
    ring: pickOne([...BADGE_COLOURS, null, null, null, null])?.id ?? "",
  };
}

/** Human sentence for a spec — used for alt text and the live region. */
export function describeSpec(spec) {
  const s = normaliseSpec(spec);
  const name = emojiName(s.emoji) || "badge";
  const parts = [`${name} on a ${COLOUR_BY_ID.get(s.bg).label.toLowerCase()} ${SHAPE_BY_ID.get(s.shape).label.toLowerCase()}`];
  if (s.accessory) parts.push(`with a ${ACCESSORY_BY_ID.get(s.accessory).label.toLowerCase()}`);
  if (s.ring) parts.push(`ringed in ${COLOUR_BY_ID.get(s.ring).label.toLowerCase()}`);
  return parts.join(", ");
}

/* --------------------------------------------------------------------------
   Rendering
   -------------------------------------------------------------------------- */

/**
 * A decorated badge as a standalone SVG string.
 *
 * Decorative by default, matching how views.js renders avatars: the member's
 * name is always sitting next to it, and hearing the badge described before
 * the name is noise. Pass a `label` for the rare avatar that stands alone.
 */
export function renderAvatar(spec, size = 64, { label = "", cls = "" } = {}) {
  const s = normaliseSpec(spec);
  const shape = SHAPE_BY_ID.get(s.shape);
  const bg = COLOUR_BY_ID.get(s.bg).hex;
  const ring = s.ring ? COLOUR_BY_ID.get(s.ring).hex : "";
  const accessory = s.accessory ? ACCESSORY_BY_ID.get(s.accessory) : null;
  const px = Math.max(16, Math.round(Number(size) || 64));

  // The ring is a stroke on the same path rather than a second shape: one path
  // means the ring can never drift out of register with the fill it outlines.
  const ringAttrs = ring ? ` stroke="${ring}" stroke-width="4" stroke-linejoin="round"` : "";
  const a11y = label
    ? `role="img" aria-label="${esc(label)}"`
    : 'aria-hidden="true" focusable="false"';

  return (
    `<svg class="cc-avatar${cls ? ` ${esc(cls)}` : ""}" viewBox="0 0 64 64" width="${px}" height="${px}" ${a11y}>` +
    `<path d="${shape.path}" fill="${bg}"${ringAttrs}/>` +
    `<text x="32" y="${32 + shape.dy}" text-anchor="middle" dominant-baseline="central"` +
    ` font-size="${shape.glyph}" font-family="${EMOJI_FONTS}">${esc(s.emoji)}</text>` +
    (accessory
      ? `<text x="${accessory.x}" y="${accessory.y}" text-anchor="middle" dominant-baseline="central"` +
        ` font-size="${accessory.size}" font-family="${EMOJI_FONTS}">${accessory.char}</text>`
      : "") +
    `</svg>`
  );
}

/** The same badge as a data: URL, for the places that need an <img> src. */
export const avatarDataUrl = (spec, size = 64) =>
  `data:image/svg+xml,${encodeURIComponent(
    renderAvatar(spec, size).replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ')
  )}`;

/* --------------------------------------------------------------------------
   The editor
   -------------------------------------------------------------------------- */

let decoratorSeq = 0;

/**
 * One row of choices. Radios rather than buttons because a radio group is
 * already the thing being built — one value out of a known set, arrow keys
 * move between them, the whole row is one tab stop, and `:checked` styles the
 * selection without a line of JavaScript keeping a class in sync.
 */
function optionRow({ uid, part, legend, options, current }) {
  const items = options.map((option) => {
    const checked = option.value === current ? " checked" : "";
    return h`<label class="dec__opt" title="${option.label}">
        <input class="dec__radio u-visually-hidden" type="radio" name="${`${uid}-${part}`}"
               data-dec-part="${part}" value="${option.value}"${raw(checked)}>
        <span class="dec__swatch dec__swatch--${raw(part)}" aria-hidden="true"${raw(option.style || "")}>${raw(option.face || "")}</span>
        <span class="u-visually-hidden">${option.label}</span>
      </label>`;
  });

  return h`<fieldset class="dec__row dec__row--${raw(part)}">
      <legend class="dec__legend">${legend}</legend>
      <div class="dec__opts">${raw(items.join(""))}</div>
    </fieldset>`;
}

/** Tiny filled silhouette of a shape, reusing the very path we will render. */
const shapeFace = (shape) =>
  `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="${shape.path}" fill="currentColor"/></svg>`;

/**
 * Markup for the editor.
 *
 * Returns a string rather than nodes so it drops into the same `h`-built
 * templates as the rest of the app; call `mountDecorator` on the element
 * afterwards to get the live preview and the badge picker. Without that call
 * the markup is still a working, submittable set of radio groups — the preview
 * simply stays on the badge it was rendered with.
 */
export function decoratorMarkup(spec, { picker = true, legend = "Your badge" } = {}) {
  const s = normaliseSpec(spec);
  const uid = `dec-${(decoratorSeq += 1)}`;

  const colourOptions = (withNone) => [
    ...(withNone ? [{ value: "", label: "No outline", style: ' data-none="true"' }] : []),
    ...BADGE_COLOURS.map((colour) => ({
      value: colour.id,
      label: colour.label,
      // The only inline style in the file, and the hex in it comes from the
      // frozen table above — a static stylesheet cannot name twelve swatches
      // and stay the single source of truth for the palette.
      style: ` style="--sw:${colour.hex}"`,
    })),
  ];

  return h`<div class="dec" data-decorator id="${uid}" data-dec-emoji="${s.emoji}">
      <div class="dec__stage">
        <div class="dec__preview" data-dec-preview>${raw(renderAvatar(s, 128))}</div>
        <p class="dec__caption" data-dec-caption>${describeSpec(s)}</p>
        <p class="u-visually-hidden" role="status" aria-live="polite" data-dec-live></p>
      </div>

      ${raw(
        picker
          ? h`<details class="dec__badge" data-dec-details>
              <summary class="dec__summary">
                <span class="dec__summary-glyph" aria-hidden="true" data-dec-glyph>${s.emoji}</span>
                <span class="dec__summary-text">Change the picture</span>
              </summary>
              <div class="dec__picker" data-dec-picker></div>
            </details>`
          : ""
      )}

      <div class="dec__rows" role="group" aria-label="${legend}">
        ${raw(
          optionRow({
            uid,
            part: "shape",
            legend: "Shape",
            current: s.shape,
            options: BADGE_SHAPES.map((shape) => ({
              value: shape.id,
              label: shape.label,
              face: shapeFace(shape),
            })),
          })
        )}
        ${raw(
          optionRow({
            uid,
            part: "bg",
            legend: "Colour",
            current: s.bg,
            options: colourOptions(false),
          })
        )}
        ${raw(
          optionRow({
            uid,
            part: "accessory",
            legend: "Add something",
            current: s.accessory,
            options: [
              { value: "", label: "Nothing", style: ' data-none="true"' },
              ...BADGE_ACCESSORIES.map((a) => ({ value: a.id, label: a.label, face: esc(a.char) })),
            ],
          })
        )}
        ${raw(
          optionRow({
            uid,
            part: "ring",
            legend: "Outline",
            current: s.ring,
            options: colourOptions(true),
          })
        )}
      </div>

      <button class="btn btn--ghost btn--sm dec__surprise" type="button" data-dec-surprise>
        🎲 Surprise me
      </button>
    </div>`;
}

/** The editor element, whether we were handed it or a wrapper around it. */
const rootOf = (element) =>
  !element ? null : element.matches?.("[data-decorator]") ? element : element.querySelector("[data-decorator]");

/**
 * Read the current spec back out of a mounted (or merely rendered) editor.
 *
 * Reads the DOM rather than a JS variable so the editor has exactly one source
 * of truth: whatever the radios say is what the member sees, and a caller that
 * never called `mountDecorator` still gets a correct answer.
 */
export function readDecorator(rootEl) {
  const root = rootOf(rootEl);
  if (!root) return { ...DEFAULT_AVATAR };
  const valueOf = (part) =>
    root.querySelector(`[data-dec-part="${part}"]:checked`)?.value ?? "";
  return normaliseSpec({
    emoji: root.dataset.decEmoji,
    shape: valueOf("shape"),
    bg: valueOf("bg"),
    accessory: valueOf("accessory"),
    ring: valueOf("ring"),
  });
}

/** Force a spec into an editor — used to land a "surprise me" roll. */
export function writeDecorator(rootEl, spec) {
  const root = rootOf(rootEl);
  if (!root) return null;
  const s = normaliseSpec(spec);
  root.dataset.decEmoji = s.emoji;
  for (const part of ["shape", "bg", "accessory", "ring"]) {
    for (const radio of root.querySelectorAll(`[data-dec-part="${part}"]`)) {
      radio.checked = radio.value === s[part];
    }
  }
  return s;
}

/**
 * Give a rendered editor its live preview and its badge picker.
 *
 * This is the JavaScript the CSS-first rule permits rather than the JS it
 * discourages: selection state, focus rings and the disclosure are all CSS
 * here, but composing an SVG out of five independent choices — one of them an
 * arbitrary glyph out of 721 — is not something a stylesheet can express.
 *
 * @returns {{destroy: () => void, read: () => object, set: (spec: object) => void}}
 */
export function mountDecorator(rootEl, { onChange, size = 128 } = {}) {
  const root = rootOf(rootEl);
  if (!root) throw new Error("mountDecorator needs a decorator element.");

  const preview = root.querySelector("[data-dec-preview]");
  const caption = root.querySelector("[data-dec-caption]");
  const live = root.querySelector("[data-dec-live]");
  const glyph = root.querySelector("[data-dec-glyph]");
  const details = root.querySelector("[data-dec-details]");
  const pickerHost = root.querySelector("[data-dec-picker]");
  let badgePicker = null;
  let destroyed = false;

  const paint = (announce = false) => {
    const spec = readDecorator(root);
    // Our own generated markup, with the one free-text field already through
    // esc() — the same contract showDialog's bodyHtml runs on.
    if (preview) preview.innerHTML = renderAvatar(spec, size);
    const description = describeSpec(spec);
    if (caption) caption.textContent = description;
    if (glyph) glyph.textContent = spec.emoji;
    // Only the deliberate changes get announced. Repainting after a "surprise
    // me" or a badge pick is news; re-announcing on every arrow key as a child
    // walks a colour row is a screen reader talking over itself.
    if (announce && live) live.textContent = description;
    root.classList.remove("is-fresh");
    // Reflow between removing and adding is what lets the same pop animation
    // replay; without it the class never leaves the element's computed style.
    void root.offsetWidth;
    root.classList.add("is-fresh");
    onChange?.(spec);
    return spec;
  };

  const onChangeEvent = (event) => {
    if (event.target.matches("[data-dec-part]")) paint(false);
  };

  const onClick = (event) => {
    if (!event.target.closest("[data-dec-surprise]")) return;
    writeDecorator(root, randomSpec());
    paint(true);
  };

  // The picker asks to be closed rather than closing anything itself; here the
  // thing to close is the disclosure it lives in.
  const onPickerClose = () => {
    if (details) details.open = false;
  };

  root.addEventListener("change", onChangeEvent);
  root.addEventListener("click", onClick);
  root.addEventListener("emoji-picker-close", onPickerClose);

  if (pickerHost) {
    badgePicker = mountEmojiPicker(pickerHost, {
      value: root.dataset.decEmoji,
      onPick: (char) => {
        root.dataset.decEmoji = char;
        paint(true);
      },
    });
  }

  paint(false);

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      root.removeEventListener("change", onChangeEvent);
      root.removeEventListener("click", onClick);
      root.removeEventListener("emoji-picker-close", onPickerClose);
      badgePicker?.destroy();
    },
    read: () => readDecorator(root),
    set(spec) {
      writeDecorator(root, spec);
      badgePicker?.setValue(root.dataset.decEmoji);
      paint(true);
    },
  };
}

export default { renderAvatar, decoratorMarkup, readDecorator, mountDecorator };
