/**
 * onboard.js — the four questions a new cousin is asked, once.
 *
 * Enrolling used to be four separate prompts fired in sequence, and the ones
 * in the middle were routinely dismissed: a child who has just been told "you
 * are in the House" does not read the third modal. So this is one dialog that
 * stays open, remembers what has been answered, and cannot lose a step's work
 * by accident — Escape walks BACK through the steps instead of throwing the
 * whole thing away, and only closes when there is nothing left to lose.
 *
 * Deliberately knows nothing about the store, the op log, auth or the chair.
 * It is handed what it needs and hands back a plain object; whoever called it
 * decides what a "member" is and how a password is hashed. That keeps the flow
 * usable for a chair enrolling someone else, for a self-enrolling cousin, and
 * for the test page, without three copies of the same four questions.
 */

import { h, raw } from "./ui.js";
import { icon, installSprite } from "./icons-ui.js";
import { decoratorMarkup, mountDecorator, normaliseSpec, randomSpec } from "./emoji-decorate.js";

/**
 * Four characters, not eight. This is a family secret between cousins, not a
 * credential guarding money, and a password a seven-year-old cannot remember
 * is a password that ends up written on the side of the tablet.
 */
const MIN_PASSWORD = 4;
const MAX_NAME = 32;

const STEPS = ["Your name", "Your badge", "Your secret word", "Your settings"];

/**
 * Progress dots. Hidden from assistive tech on purpose — the live region below
 * already says "Step 2 of 4: Your badge", which is the same information said
 * once and in words, rather than four unlabelled list items said every move.
 */
const stepDots = (current) =>
  h`<ol class="ob__dots" aria-hidden="true">${raw(
    STEPS.map(
      (_, i) =>
        h`<li class="ob__dot" data-index="${i + 1}" data-state="${
          i + 1 < current ? "done" : i + 1 === current ? "now" : "todo"
        }"></li>`
    ).join("")
  )}</ol>`;

/**
 * The walkie-talkie row. Shown, never offered: whether the House can talk is
 * the chair's call, and a switch a member can flip that silently does nothing
 * is worse than a sentence explaining who decides.
 */
function walkieRow(walkie) {
  const state = walkie === true ? "on" : walkie === false ? "off" : "unset";
  const words = {
    on: "Walkie-talkie is switched on for the House.",
    off: "Walkie-talkie is switched off right now.",
    unset: "The chair has not switched walkie-talkie on yet.",
  };
  return h`<p class="ob__status" data-state="${state}">
      ${raw(icon("talkie"))}
      <span>
        <strong>${words[state]}</strong>
        <span class="ob__status-hint">Only the chair can change this.</span>
      </span>
    </p>`;
}

/** One labelled switch. A checkbox styled by CSS — no JS keeps its state. */
function toggle({ id, part, label, hint, checked }) {
  return h`<label class="ob__toggle" for="${id}">
      <input class="ob__check" type="checkbox" id="${id}" data-ob-pref="${part}"${raw(
    checked ? " checked" : ""
  )}>
      <span class="ob__track" aria-hidden="true"></span>
      <span class="ob__toggle-text">
        <strong>${label}</strong>
        <span class="ob__status-hint">${hint}</span>
      </span>
    </label>`;
}

/**
 * Run the flow.
 *
 * Resolves to {name, avatarSpec, password, prefs} when the member finishes, or
 * null when they back all the way out. Rejecting on cancel was the obvious
 * alternative and the wrong one: backing out of a welcome screen is a normal
 * thing to do, not an error every call site has to wrap in a try.
 *
 * @param {object}   options
 * @param {string}   options.name        Name to start from (a chair may have set one).
 * @param {object}   options.avatar      Existing avatar spec, if they have one.
 * @param {boolean?} options.walkie      Chair's walkie setting: true, false, or null if unset.
 * @param {string}   options.houseName   What to call the House on the welcome step.
 * @param {boolean}  options.nameLocked  True when the chair chose the name and it is not theirs to change.
 * @param {Function} options.onStep      Called with (stepNumber, total) on each move.
 * @param {Function} options.onDone      Called with the result, just before resolving.
 */
export function runOnboarding({
  name = "",
  avatar = null,
  walkie = null,
  houseName = "Cousin Congress",
  nameLocked = false,
  minPassword = MIN_PASSWORD,
  onStep,
  onDone,
} = {}) {
  return new Promise((resolve) => {
    installSprite();

    const dialog = document.createElement("dialog");
    // Borrowing the `ask` dialog's chrome — box, backdrop, entrance animation —
    // so the flow cannot drift away from every other modal in the app when one
    // of them is restyled. `ob` only adds what a multi-step form needs.
    dialog.className = "ask ob-dialog";

    const startSpec = avatar ? normaliseSpec(avatar) : randomSpec();
    const prefersReduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

    dialog.innerHTML = h`
      <form class="ask__form ob" data-step="1" novalidate>
        <p class="u-visually-hidden" role="status" aria-live="polite" data-ob-live></p>

        <section class="ob__step" data-index="1" aria-label="${STEPS[0]}">
          <span class="ob__icon" aria-hidden="true">${raw(icon("users"))}</span>
          <h2 class="ask__title">Welcome to ${houseName}</h2>
          <p class="ask__hint">Four quick things and you have a seat. You can change all of them later.</p>
          <div class="field ob__field">
            <label class="field__label" for="ob-name">What should we call you?</label>
            <input class="input ob__input" id="ob-name" type="text" data-ob-name
                   value="${name}" maxlength="${MAX_NAME}" autocomplete="given-name"
                   spellcheck="false" placeholder="Your name"${raw(nameLocked ? " readonly" : "")}>
            <p class="ob__error" data-ob-error="1"></p>
          </div>
        </section>

        <section class="ob__step" data-index="2" aria-label="${STEPS[1]}">
          <span class="ob__icon" aria-hidden="true">${raw(icon("pencil"))}</span>
          <h2 class="ask__title">Make it yours</h2>
          <p class="ask__hint">This is how cousins spot you in the chamber.</p>
          ${raw(decoratorMarkup(startSpec))}
        </section>

        <section class="ob__step" data-index="3" aria-label="${STEPS[2]}">
          <span class="ob__icon" aria-hidden="true">${raw(icon("key"))}</span>
          <h2 class="ask__title">Pick a secret word</h2>
          <p class="ask__hint">You type this to take your seat. It shows on screen on purpose — a
            secret word you mistyped once and cannot see is a seat you cannot get back into.</p>
          <div class="field ob__field">
            <label class="field__label" for="ob-pass">Secret word</label>
            <input class="input ask__input ob__input" id="ob-pass" type="text" data-ob-pass
                   autocomplete="off" autocapitalize="none" spellcheck="false"
                   minlength="${minPassword}" placeholder="at least ${minPassword} letters">
            <p class="ob__error" data-ob-error="3"></p>
          </div>
        </section>

        <section class="ob__step" data-index="4" aria-label="${STEPS[3]}">
          <span class="ob__icon" aria-hidden="true">${raw(icon("settings"))}</span>
          <h2 class="ask__title">Last bit</h2>
          <p class="ask__hint">Two switches, both yours to change whenever you like.</p>
          <div class="ob__prefs">
            ${raw(walkieRow(walkie))}
            ${raw(
              toggle({
                id: "ob-notify",
                part: "notify",
                label: "Tell me when things happen",
                hint: "A nudge when a vote opens or someone answers you.",
                checked: false,
              })
            )}
            ${raw(
              toggle({
                id: "ob-motion",
                part: "reduceMotion",
                label: "Calmer screens",
                hint: "Turns off the sliding and the confetti.",
                checked: prefersReduced,
              })
            )}
          </div>
        </section>

        <footer class="ob__foot">
          ${raw(stepDots(1))}
          <div class="ask__actions ob__actions">
            <button class="btn btn--ghost" type="button" data-ob-back>Not now</button>
            <button class="btn" type="submit" data-ob-next>Next ${raw(icon("arrowRight"))}</button>
          </div>
        </footer>
      </form>`;

    document.body.append(dialog);

    const form = dialog.querySelector("form");
    const live = dialog.querySelector("[data-ob-live]");
    const dots = [...dialog.querySelectorAll(".ob__dot")];
    const backBtn = dialog.querySelector("[data-ob-back]");
    const nextBtn = dialog.querySelector("[data-ob-next]");
    const nameInput = dialog.querySelector("[data-ob-name]");
    const passInput = dialog.querySelector("[data-ob-pass]");
    const decorator = mountDecorator(dialog.querySelector("[data-decorator]"));

    let step = 1;
    let result = null;

    const errorSlot = (n) => dialog.querySelector(`[data-ob-error="${n}"]`);
    const clearErrors = () => {
      for (const slot of dialog.querySelectorAll(".ob__error")) slot.textContent = "";
    };

    const fail = (n, message) => {
      const slot = errorSlot(n);
      if (slot) slot.textContent = message;
      // The live region is the only announcement; the error text sits beside a
      // field that may already be scrolled out of view on a short phone.
      if (live) live.textContent = message;
      return false;
    };

    /** Whichever control the member should be typing in on this step. */
    const focusStep = () => {
      const panel = dialog.querySelector(`.ob__step[data-index="${step}"]`);
      const target =
        panel?.querySelector("input:not([readonly]):not(.u-visually-hidden), summary, button") ||
        nextBtn;
      target?.focus();
    };

    const paint = ({ announce = true, focus = true } = {}) => {
      form.dataset.step = String(step);
      for (const dot of dots) {
        const index = Number(dot.dataset.index);
        dot.dataset.state = index < step ? "done" : index === step ? "now" : "todo";
      }
      backBtn.textContent = step === 1 ? "Not now" : "Back";
      nextBtn.innerHTML =
        step === STEPS.length ? `Take my seat ${icon("check")}` : `Next ${icon("arrowRight")}`;
      if (announce && live) live.textContent = `Step ${step} of ${STEPS.length}: ${STEPS[step - 1]}.`;
      onStep?.(step, STEPS.length);
      if (focus) focusStep();
    };

    /** Everything a step needs to be true before it is allowed to advance. */
    const validate = () => {
      clearErrors();
      if (step === 1) {
        const value = nameInput.value.trim().replace(/\s+/g, " ");
        if (!value) return fail(1, "Type a name so cousins know who you are.");
        nameInput.value = value;
        return true;
      }
      if (step === 3) {
        const value = passInput.value.trim();
        if (value.length < minPassword) {
          return fail(3, `A bit longer, please — at least ${minPassword} letters.`);
        }
        return true;
      }
      return true;
    };

    const collect = () => ({
      name: nameInput.value.trim(),
      avatarSpec: decorator.read(),
      password: passInput.value.trim(),
      prefs: {
        notify: dialog.querySelector('[data-ob-pref="notify"]').checked,
        reduceMotion: dialog.querySelector('[data-ob-pref="reduceMotion"]').checked,
        // Echoed rather than collected, so a caller storing `prefs` wholesale
        // records what the member was actually told about the House.
        walkie: walkie === true,
      },
    });

    const goto = (next) => {
      step = Math.min(Math.max(next, 1), STEPS.length);
      clearErrors();
      paint();
    };

    const onSubmit = (event) => {
      event.preventDefault();
      if (!validate()) return;
      if (step < STEPS.length) return goto(step + 1);
      result = collect();
      dialog.close("done");
      return undefined;
    };

    const onBack = () => {
      if (step === 1) dialog.close("cancel");
      else goto(step - 1);
    };

    // Escape on a later step is far more likely to mean "wrong answer, go
    // back" than "discard everything I just did", so it rewinds. On step one
    // there is nothing to protect and it does what Escape normally does.
    const onCancel = (event) => {
      if (step === 1) return;
      event.preventDefault();
      goto(step - 1);
    };

    const onClose = () => {
      decorator.destroy();
      dialog.remove();
      if (result) onDone?.(result);
      resolve(result);
    };

    form.addEventListener("submit", onSubmit);
    backBtn.addEventListener("click", onBack);
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("close", onClose, { once: true });

    dialog.showModal();
    paint({ announce: false });
  });
}

export default runOnboarding;
