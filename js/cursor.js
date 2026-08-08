/**
 * cursor.js — pointer plumbing, and nothing else.
 *
 * This file publishes two numbers and three booleans. Every shape, colour,
 * label and morph the pointer performs is decided in cursor.css from :has()
 * state, which means new pointer behaviour is a CSS rule rather than another
 * branch in here.
 */

const FINE_POINTER = "(pointer: fine) and (hover: hover)";

export function initCursor() {
  if (!window.matchMedia?.(FINE_POINTER).matches) return null;

  const root = document.documentElement;
  const mount = document.querySelector(".cursor");
  if (!mount) return null;

  let x = innerWidth / 2;
  let y = innerHeight / 2;
  let frame = 0;

  const paint = () => {
    frame = 0;
    root.style.setProperty("--cursor-x", `${x}px`);
    root.style.setProperty("--cursor-y", `${y}px`);
  };

  // Coalesce to one write per frame: pointermove can fire far more often than
  // the compositor will ever use, and each write invalidates style.
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };

  addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType !== "mouse") return;
      x = event.clientX;
      y = event.clientY;
      if (root.dataset.cursor !== "on") {
        root.dataset.cursor = "on";
        root.dataset.cursorVisible = "true";
        paint();
        return;
      }
      schedule();
    },
    { passive: true }
  );

  addEventListener("pointerdown", () => (root.dataset.cursorPressed = "true"), { passive: true });
  addEventListener("pointerup", () => (root.dataset.cursorPressed = "false"), { passive: true });

  document.addEventListener("pointerleave", () => (root.dataset.cursorVisible = "false"));
  document.addEventListener("pointerenter", () => (root.dataset.cursorVisible = "true"));
  addEventListener("blur", () => (root.dataset.cursorVisible = "false"));

  // A touch on a hybrid device retires the custom pointer until a mouse moves
  // again, so the native touch affordances are never fighting a drawn circle.
  addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType === "touch") root.dataset.cursor = "off";
    },
    { passive: true }
  );

  return { mount };
}

export default initCursor;
