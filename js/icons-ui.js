/**
 * icons-ui.js — the interface icon set.
 *
 * Emoji are wonderful for CousinS — a member's avatar, the pairing alphabet, the
 * decorated faces on the roster — and those stay exactly as they are. But emoji
 * make poor INTERFACE icons: they render differently on every platform, they sit
 * on the text baseline instead of aligning to a button, they carry colour we
 * cannot theme, and at small sizes they turn to mush. So the chrome — navigation,
 * buttons, panels, dashboards — uses this set instead.
 *
 * One flat, professional family: 24×24, 1.75px strokes, round caps, currentColor.
 * They inherit type colour, so they theme themselves in light and dark and read
 * as one system rather than a sticker sheet.
 *
 * `icon(name)` returns markup for templates; SPRITE is injected once per page so
 * the geometry is defined a single time and every use is a reference.
 */

/** Path data only — everything else is identical between icons. */
const PATHS = {
  /* navigation */
  floor: '<path d="M4 20V9l8-5 8 5v11"/><path d="M9 20v-6h6v6"/><path d="M2 20h20"/>',
  members: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19a6 6 0 0 1 12 0"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6"/><path d="M17.5 13.6A6 6 0 0 1 21 19"/>',
  connect: '<path d="M8.5 15.5 15.5 8.5"/><path d="M10.5 5.5 12 4a4.2 4.2 0 0 1 6 6l-1.5 1.5"/><path d="M13.5 18.5 12 20a4.2 4.2 0 0 1-6-6l1.5-1.5"/>',
  news: '<path d="M3 6h13v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M16 9h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2"/><path d="M6.5 9.5h6"/><path d="M6.5 13h6"/><path d="M6.5 16.5h4"/>',
  votes: '<path d="M4 10.5 12 4l8 6.5"/><path d="M5 10.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8.5"/><path d="M9 14.5l2 2 4-4"/>',
  bills: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6"/><path d="M9 16h6"/>',
  docket: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/>',
  about: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.8h.01"/>',

  /* chrome + actions */
  bell: '<path d="M18 15.5V11a6 6 0 1 0-12 0v4.5L4.5 18h15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  talkie: '<rect x="9" y="3" width="6" height="10" rx="3"/><path d="M6 11.5a6 6 0 0 0 12 0"/><path d="M12 17.5V21"/><path d="M9 21h6"/>',
  chat: '<path d="M20.5 12c0 4-3.8 7.2-8.5 7.2a10 10 0 0 1-2.6-.34L4.5 20.5l1.2-3.4A6.9 6.9 0 0 1 3.5 12c0-4 3.8-7.2 8.5-7.2s8.5 3.2 8.5 7.2z"/>',
  gavel: '<path d="m14.5 3.5 6 6"/><path d="m17.5 6.5-8 8"/><path d="m12.8 4.7 2.5-1.2 5.2 5.2-1.2 2.5z" fill="none"/><path d="m3.5 17.5 5-5 2.5 2.5-5 5z"/><path d="M2.5 21.5h9"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/>',
  scan: '<path d="M3.5 8.5v-3a2 2 0 0 1 2-2h3"/><path d="M15.5 3.5h3a2 2 0 0 1 2 2v3"/><path d="M20.5 15.5v3a2 2 0 0 1-2 2h-3"/><path d="M8.5 20.5h-3a2 2 0 0 1-2-2v-3"/><path d="M3.5 12h17"/>',
  qr: '<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><path d="M13.5 13.5h3v3h-3z"/><path d="M20.5 13.5v3"/><path d="M17 20.5h3.5"/>',
  share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.8 7.6-4"/><path d="m8.2 13.2 7.6 4"/>',
  camera: '<path d="M3.5 8.5h3l1.5-2.5h8l1.5 2.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  upload: '<path d="M12 15.5V4"/><path d="m7.5 8 4.5-4 4.5 4"/><path d="M4 15v3.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V15"/>',
  link: '<path d="M9.5 14.5 14.5 9.5"/><path d="M11 6.5 12.8 4.7a3.8 3.8 0 0 1 5.4 5.4L16.4 12"/><path d="M13 17.5l-1.8 1.8a3.8 3.8 0 0 1-5.4-5.4L7.6 12"/>',
  shield: '<path d="M12 3.2 5 6v6c0 4.2 2.9 7.5 7 8.8 4.1-1.3 7-4.6 7-8.8V6z"/><path d="m9.2 12 2 2 3.6-3.6"/>',
  users: '<circle cx="8.5" cy="9" r="3"/><path d="M3 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9.5" r="2.5"/><path d="M16 14.6a5 5 0 0 1 5 4.4"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 5.5v-1a1 1 0 0 0-1-1h-10a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h1"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/>',
  key: '<circle cx="8" cy="15.5" r="3.5"/><path d="m10.5 13 8-8"/><path d="m15.5 8 2 2"/><path d="m18 5.5 2.2 2.2"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.2 2.4 3.4 5.4 3.4 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.4-5.4-3.4-8.5S9.8 5.9 12 3.5z"/>',
  ticket: '<path d="M3.5 8.5A2 2 0 0 0 5.5 6.5h13a2 2 0 0 1 2 2 2.2 2.2 0 0 0 0 4.4V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-4.1a2.2 2.2 0 0 0 0-4.4z"/><path d="M13 7v11"/>',
  power: '<path d="M12 3.5v8"/><path d="M17.5 6.8a7.5 7.5 0 1 1-11 0"/>',
  pencil: '<path d="m4.5 19.5 4-1 10-10a2.1 2.1 0 0 0-3-3l-10 10z"/><path d="m14.5 6.5 3 3"/>',
  trash: '<path d="M4.5 6.5h15"/><path d="M9 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h3.4A1.3 1.3 0 0 1 15 4.8v1.7"/><path d="M6.5 6.5 7.4 20a1.3 1.3 0 0 0 1.3 1.2h6.6a1.3 1.3 0 0 0 1.3-1.2l.9-13.5"/>',
  arrowRight: '<path d="M4.5 12h15"/><path d="m13.5 6 6 6-6 6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11.2v5"/><path d="M12 8.2h.01"/>',
};

/** One <symbol> per icon, injected once per document. */
export const SPRITE = `<svg class="ico-sprite" aria-hidden="true" focusable="false"><defs>${Object.entries(
  PATHS
)
  .map(
    ([name, d]) =>
      `<symbol id="i-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${d}</symbol>`
  )
  .join("")}</defs></svg>`;

export const ICON_NAMES = Object.freeze(Object.keys(PATHS));

/**
 * Markup for one icon. Decorative by default (the neighbouring label names it);
 * pass a `label` when the icon stands alone so screen readers still get a name.
 */
export function icon(name, { label = "", cls = "" } = {}) {
  const klass = `ico${cls ? ` ${cls}` : ""}`;
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg class="${klass}" ${a11y} focusable="false"><use href="#i-${name}"></use></svg>`;
}

/** Put the sprite in the document once, before anything references it. */
export function installSprite(doc = document) {
  if (doc.getElementById("cc-icon-sprite")) return;
  const host = doc.createElement("div");
  host.id = "cc-icon-sprite";
  host.hidden = true;
  host.innerHTML = SPRITE;
  doc.body.prepend(host);
}

export default { icon, installSprite, SPRITE, ICON_NAMES };
