/**
 * ui.js — presentation helpers.
 *
 * Deliberately small. The stylesheet does the layout, the motion and most of
 * the interaction; this file only covers the handful of things CSS genuinely
 * cannot express — escaping untrusted text, formatting dates, and the
 * IntersectionObserver fallback for browsers without scroll-driven animation.
 */

export const qs = (selector, scope = document) => scope.querySelector(selector);
export const qsa = (selector, scope = document) => [...scope.querySelectorAll(selector)];

/* --------------------------------------------------------------------------
   Escaping
   -------------------------------------------------------------------------- */

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Everything rendered from the op log is member-authored. All of it goes through here. */
export const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ENTITIES[ch]);

class Raw {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

/** Mark an already-escaped fragment as safe to interpolate. */
export const raw = (value) => new Raw(value);

/** Tagged template that escapes every interpolation unless wrapped in raw(). */
export function h(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    out += value instanceof Raw ? value.value : Array.isArray(value)
      ? value.map((v) => (v instanceof Raw ? v.value : esc(v))).join("")
      : esc(value);
    out += strings[i + 1];
  }
  return out;
}

/* --------------------------------------------------------------------------
   Formatting
   -------------------------------------------------------------------------- */

const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export const toDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const fmtDate = (value) => {
  const date = toDate(value);
  return date ? DATE_FMT.format(date) : "—";
};

export const fmtTime = (value) => {
  const date = toDate(value);
  return date ? TIME_FMT.format(date) : "—";
};

const REL_UNITS = [
  ["year", 31536000000],
  ["month", 2592000000],
  ["week", 604800000],
  ["day", 86400000],
  ["hour", 3600000],
  ["minute", 60000],
];

const REL_FMT = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function relTime(value) {
  const date = toDate(value);
  if (!date) return "—";
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  for (const [unit, ms] of REL_UNITS) {
    if (abs >= ms) return REL_FMT.format(Math.round(diff / ms), unit);
  }
  return REL_FMT.format(Math.round(diff / 1000), "second");
}

/** Wall time carried by a hybrid logical clock stamp. */
export const timeOfStamp = (hlc) => {
  const ms = Number(String(hlc || "").split(":")[0]);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
};

export const initials = (name) =>
  String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");

export const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many ?? `${one}s`}`;

/* --------------------------------------------------------------------------
   Toasts
   -------------------------------------------------------------------------- */

let toastHost = null;

export function toast(message, kind = "ok", ms = 4200) {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toast-stack";
    toastHost.setAttribute("role", "status");
    toastHost.setAttribute("aria-live", "polite");
    document.body.append(toastHost);
  }
  const node = document.createElement("div");
  node.className = `toast toast--${kind}`;
  node.textContent = message;
  toastHost.append(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.translate = "0 8px";
    setTimeout(() => node.remove(), 300);
  }, ms);
  return node;
}

/* --------------------------------------------------------------------------
   Ask dialog — one native <dialog>, reused for every password prompt
   -------------------------------------------------------------------------- */

let askHost = null;

/**
 * Big friendly modal question with a single input. Resolves to the entered
 * string, or null if dismissed. Passwords here are family secrets between
 * cousins, so the input is visible text by default — young kids need to see
 * what they typed.
 */
/**
 * A dialog that SHOWS something rather than asking for it — a QR to hold up, a
 * code to copy. `bodyHtml` is trusted markup the caller built (an SVG we
 * generated), never user text; anything from a member must be escaped first.
 */
export function showDialog({
  icon = "📣",
  title,
  hint = "",
  bodyHtml = "",
  copyText = "",
  confirmLabel = "Done",
} = {}) {
  return new Promise((resolve) => {
    if (!askHost) {
      askHost = document.createElement("dialog");
      askHost.className = "ask";
      document.body.append(askHost);
    }

    askHost.innerHTML = h`
      <form method="dialog" class="ask__form">
        <div class="ask__icon" aria-hidden="true">${icon}</div>
        <h2 class="ask__title">${title}</h2>
        ${raw(hint ? h`<p class="ask__hint">${hint}</p>` : "")}
        ${raw(bodyHtml)}
        <div class="ask__actions">
          ${raw(copyText ? `<button class="btn btn--ghost" type="button" data-ask-copy>Copy link</button>` : "")}
          <button class="btn" value="ok">${confirmLabel}</button>
        </div>
      </form>`;

    askHost.querySelector("[data-ask-copy]")?.addEventListener("click", () => {
      navigator.clipboard?.writeText(copyText).then(
        () => toast("Copied — send it to them however you like."),
        () => toast("Couldn't copy automatically; long-press the code instead.", "warn")
      );
    });
    askHost.returnValue = "ok";
    const onClose = () => resolve(true);
    askHost.addEventListener("close", onClose, { once: true });
    askHost.showModal();
  });
}

/**
 * A yes/no. Same shape as askDialog, minus the field.
 *
 * Cancel is a plain button rather than a second submit for the same reason it
 * is there: the first submit button in a form is what Enter activates, and a
 * cancel in that position turns "press Enter to agree" into "press Enter to
 * back out" — which on a consequential question is precisely the wrong default.
 */
export function confirmDialog({
  icon = "❓",
  title,
  hint = "",
  confirmLabel = "Yes",
  cancelLabel = "Never mind",
} = {}) {
  return new Promise((resolve) => {
    if (!askHost) {
      askHost = document.createElement("dialog");
      askHost.className = "ask";
      document.body.append(askHost);
    }
    askHost.innerHTML = h`
      <form method="dialog" class="ask__form">
        <div class="ask__icon" aria-hidden="true">${icon}</div>
        <h2 class="ask__title">${title}</h2>
        ${raw(hint ? h`<p class="ask__hint">${hint}</p>` : "")}
        <div class="ask__actions">
          <button class="btn btn--ghost" type="button" data-ask-cancel>${cancelLabel}</button>
          <button class="btn" value="ok">${confirmLabel}</button>
        </div>
      </form>`;
    askHost.querySelector("[data-ask-cancel]")?.addEventListener("click", () => {
      askHost.returnValue = "cancel";
      askHost.close("cancel");
    });
    askHost.returnValue = "cancel";
    askHost.addEventListener("close", () => resolve(askHost.returnValue === "ok"), { once: true });
    askHost.showModal();
  });
}

/**
 * Ask for one line of text — or for a password.
 *
 * `password: true` renders a real `<input type="password">` rather than a text
 * box with the letters showing. That matters for more than shoulder-surfing: a
 * browser only offers to save, sync and autofill a credential it can recognise
 * as one, and recognition needs the password type, an `autocomplete` hint, and
 * a username field to hang the entry on. Without those, every cousin has to
 * remember the chamber's password by heart forever, which for a family app is
 * the difference between "works next month" and "locked out".
 *
 * @param {boolean} password        Render a masked credential field.
 * @param {string}  autocomplete    "current-password" when proving a password
 *                                  you already have, "new-password" when
 *                                  setting one — the browser offers to generate
 *                                  and save on the latter and only fills on the
 *                                  former.
 * @param {string}  username        What the password belongs to. Password
 *                                  managers key their entry on this, so a seat
 *                                  password and the Chair's gavel end up as two
 *                                  separate saved credentials rather than one
 *                                  overwriting the other.
 */
export function askDialog({
  icon = "🔑",
  title,
  hint = "",
  placeholder = "",
  confirmLabel = "OK",
  cancelLabel = "Never mind",
  password = false,
  autocomplete = "current-password",
  username = "",
} = {}) {
  return new Promise((resolve) => {
    if (!askHost) {
      askHost = document.createElement("dialog");
      askHost.className = "ask";
      document.body.append(askHost);
    }

    // The username field is offscreen rather than absent: managers need
    // something to label the saved entry with, but nobody is meant to edit it.
    const identity = password
      ? h`<input class="u-visually-hidden" type="text" name="username"
                 autocomplete="username" value="${username || "Cousin Congress"}"
                 readonly tabindex="-1" aria-hidden="true">`
      : "";

    const field = password
      ? h`<div class="ask__reveal">
            <input class="input ask__input" type="password" name="password"
                   autocomplete="${autocomplete}" autocapitalize="none"
                   spellcheck="false" required
                   placeholder="${placeholder}" aria-label="${title}">
            <button class="ask__eye" type="button" data-ask-reveal
                    aria-label="Show the password" aria-pressed="false">Show</button>
          </div>`
      : h`<input class="input ask__input" type="text" autocomplete="off"
                 autocapitalize="none" spellcheck="false" required
                 placeholder="${placeholder}" aria-label="${title}">`;

    askHost.innerHTML = h`
      <form method="dialog" class="ask__form">
        <div class="ask__icon" aria-hidden="true">${icon}</div>
        <h2 class="ask__title">${title}</h2>
        ${raw(hint ? h`<p class="ask__hint">${hint}</p>` : "")}
        ${raw(identity)}
        ${raw(field)}
        <div class="ask__actions">
          <button class="btn btn--ghost" type="button" data-ask-cancel>${cancelLabel}</button>
          <button class="btn" value="ok">${confirmLabel}</button>
        </div>
      </form>`;

    const input = askHost.querySelector(".ask__input");

    // Kids mistype long words. Letting them look is worth more here than the
    // shoulder-surfing it costs, so long as it is off by default.
    askHost.querySelector("[data-ask-reveal]")?.addEventListener("click", (event) => {
      const eye = event.currentTarget;
      const shown = input.type === "text";
      input.type = shown ? "password" : "text";
      eye.textContent = shown ? "Show" : "Hide";
      eye.setAttribute("aria-pressed", String(!shown));
      eye.setAttribute("aria-label", shown ? "Show the password" : "Hide the password");
      input.focus();
    });
    // Cancel is a plain button, not a submit: the FIRST submit button in a form
    // is what Enter activates, and having cancel there meant pressing Enter
    // dismissed the dialog instead of accepting what you just typed.
    askHost.querySelector("[data-ask-cancel]")?.addEventListener("click", () => {
      askHost.returnValue = "cancel";
      askHost.close("cancel");
    });
    askHost.returnValue = "cancel";
    askHost.addEventListener(
      "close",
      () => resolve(askHost.returnValue === "ok" ? input.value : null),
      { once: true }
    );
    askHost.showModal();
    input.focus();
  });
}

/* --------------------------------------------------------------------------
   Scroll reveal fallback
   -------------------------------------------------------------------------- */

/**
 * Only used where `animation-timeline: view()` is missing. Where it exists,
 * the reveals are already running off the compositor and this never mounts.
 */
export function initReveal() {
  if (CSS.supports("animation-timeline: view()")) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!("IntersectionObserver" in window)) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
  );

  const watch = (scope = document) => qsa("[data-reveal]", scope).forEach((el) => observer.observe(el));
  watch();
  return watch;
}

/* --------------------------------------------------------------------------
   Live clock and countdowns
   -------------------------------------------------------------------------- */

export function initClock() {
  const clocks = qsa("[data-clock]");
  const counters = qsa("[data-countdown]");
  if (!clocks.length && !counters.length) return;

  const tick = () => {
    const now = new Date();
    for (const node of clocks) {
      node.textContent =
        node.dataset.clock === "date"
          ? DATE_FMT.format(now)
          : now.toLocaleTimeString(undefined, { hour12: false });
    }
    for (const node of counters) paintCountdown(node);
  };

  tick();
  setInterval(tick, 1000);
}

export function paintCountdown(node) {
  const target = toDate(node.dataset.countdown);
  if (!target) return;
  const remaining = Math.max(0, target.getTime() - Date.now());
  const total = Math.floor(remaining / 1000);
  const parts = {
    h: Math.floor(total / 3600),
    m: Math.floor((total % 3600) / 60),
    s: total % 60,
  };
  for (const [unit, value] of Object.entries(parts)) {
    const slot = qs(`[data-unit="${unit}"]`, node);
    if (slot) slot.textContent = String(value).padStart(2, "0");
  }
  node.classList.toggle("countdown--urgent", remaining > 0 && remaining < 5 * 60 * 1000);
  node.dataset.expired = remaining === 0 ? "true" : "false";
}

/* --------------------------------------------------------------------------
   Client-side filtering
   -------------------------------------------------------------------------- */

/**
 * Wires `[data-search]` inputs and `[data-filter]` selects to the rows inside
 * the scope they name. Filtering is a data attribute; hiding is a CSS rule.
 */
export function initFilters() {
  const apply = (scope) => {
    const inputs = qsa(`[data-search-for="${scope.id}"], [data-filter-for="${scope.id}"]`);
    const term = (
      inputs.find((i) => i.dataset.searchFor)?.value || ""
    )
      .trim()
      .toLowerCase();
    const facets = inputs
      .filter((i) => i.dataset.filterFor && i.value && i.value !== "all")
      .map((i) => [i.dataset.facet, i.value.toLowerCase()]);

    let shown = 0;
    for (const item of qsa("[data-item]", scope)) {
      const haystack = (item.dataset.text || item.textContent || "").toLowerCase();
      const matchesTerm = !term || haystack.includes(term);
      const matchesFacets = facets.every(
        ([facet, value]) => (item.dataset[facet] || "").toLowerCase() === value
      );
      const visible = matchesTerm && matchesFacets;
      item.dataset.filtered = visible ? "false" : "true";
      if (visible) shown += 1;
    }

    const readout = qs(`[data-count-for="${scope.id}"]`);
    if (readout) readout.textContent = String(shown);
    const empty = qs(`[data-empty-for="${scope.id}"]`);
    if (empty) empty.hidden = shown > 0;
  };

  // Called after every repaint, so wiring must be idempotent: listeners are
  // attached once per input, but the filter itself re-applies to fresh rows.
  for (const scope of qsa("[data-filter-scope]")) {
    const run = () => apply(scope);
    for (const input of qsa(`[data-search-for="${scope.id}"], [data-filter-for="${scope.id}"]`)) {
      if (input.dataset.filterWired) continue;
      input.dataset.filterWired = "true";
      input.addEventListener("input", run);
      input.addEventListener("change", run);
    }
    run();
  }
}

/* --------------------------------------------------------------------------
   Theme
   -------------------------------------------------------------------------- */

const THEME_KEY = "cc.theme";

/**
 * The palette itself is `light-dark()` in tokens.css, so switching themes is
 * just flipping `color-scheme` — this stores the preference and toggles one
 * attribute.
 */
export function initTheme() {
  const root = document.documentElement;
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") root.dataset.theme = saved;

  for (const button of qsa("[data-action='theme']")) {
    button.addEventListener("click", () => {
      const current =
        root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const next = current === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      localStorage.setItem(THEME_KEY, next);
      button.setAttribute("aria-pressed", String(next === "dark"));
    });
  }
}

/* --------------------------------------------------------------------------
   Copy to clipboard
   -------------------------------------------------------------------------- */

export async function copyText(text, successMessage = "Copied to clipboard.") {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMessage);
    return true;
  } catch {
    // Clipboard is gated on transient activation and a secure context; when
    // it is unavailable the caller still has the text on screen to select.
    toast("Copy blocked by the browser — select the text and copy manually.", "warn");
    return false;
  }
}

export function download(filename, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
