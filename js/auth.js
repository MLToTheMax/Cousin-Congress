/**
 * auth.js — secret words for seats and the gavel.
 *
 * Passwords are hashed client-side (salted SHA-256 via WebCrypto) and the
 * hash travels in the replicated record like everything else, so any device
 * can check a password with no server involved. Honesty about the threat
 * model: this is a family latch, not a bank vault — it keeps a younger cousin
 * from voting as an older one, and that is exactly the job. Anyone who can
 * read this code can bypass it; anyone who can do that has aged out of
 * needing to.
 *
 * Kid concessions, deliberate:
 *  - passwords are case-insensitive and whitespace-trimmed,
 *  - typed in visible text, not dots,
 *  - three friendly attempts, then a hint to go find the Chair.
 */

import store from "./store.js";
import { select } from "./crdt.js";
import { askDialog, toast } from "./ui.js";
import { makeChairRecovery, proveChairRecovery } from "./crypto.js";
import CONFIG from "./config.js";

const CHAIR_UNLOCK_KEY = "cc.chair";

/* --------------------------------------------------------------------------
   Hashing
   -------------------------------------------------------------------------- */

const hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The label a password manager files the gavel under. Deliberately distinct
 * from any seat name so the Chair's password saves as its own credential
 * rather than overwriting the cousin's seat password on the same origin.
 */
const CHAIR_CREDENTIAL = "Chair of the Chamber";

export function newSalt() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

const normalize = (pin) => String(pin).trim().toLowerCase();

/**
 * Password stretching, matched to the recovery blob.
 *
 * This used to be a single SHA-256, and that was the weak link in a chain
 * nobody looked at end to end. The Chair's recovery key is wrapped under
 * PBKDF2 at 310,000 iterations precisely because it replicates to every
 * device — but the SAME password was also stored here as one SHA-256, in the
 * SAME replicated record. An attacker never grinds the expensive verifier when
 * a cheap one for the same secret sits beside it: one hash per candidate
 * instead of 310,000, and on a GPU that is a factor of about a million. The
 * expensive KDF was decorative.
 *
 * Seat passwords are stretched the same way and for the same reason: they are
 * salted hashes in a record every cousin holds. A few hundred milliseconds once
 * at sign-in is not a cost anyone notices.
 *
 * The algorithm rides in the hash prefix, so a chamber founded before this
 * change keeps verifying against the algorithm its passwords were made with:
 *   p:  PBKDF2-SHA-256, PIN_KDF_ITERATIONS      (current)
 *   s:  single SHA-256                          (legacy, verify only)
 *   f:  FNV fallback for a non-secure context   (no WebCrypto available)
 */
const PIN_KDF_ITERATIONS = 310000;

async function pbkdf2Pin(material, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(material), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode(String(salt)), iterations: PIN_KDF_ITERATIONS, hash: "SHA-256" },
    base,
    256
  );
  return `p:${hex(bits)}`;
}

export async function hashPin(pin, salt, algorithm = "p") {
  const material = `cc:${salt}:${normalize(pin)}`;
  if (globalThis.crypto?.subtle) {
    if (algorithm === "p") return pbkdf2Pin(material, salt);
    // Legacy verification only — never chosen for a new password.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
    return `s:${hex(digest)}`;
  }
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (const ch of material) {
    const c = ch.codePointAt(0);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c << 3) | (c >> 5)), 0x01000193) >>> 0;
  }
  return `f:${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/**
 * Is this stored hash made with a weaker algorithm than we now use?
 *
 * Upgrading the algorithm only protects chambers founded afterwards; every
 * chamber that already exists keeps its cheap hash in a record every cousin
 * holds, which is exactly the thing that made the expensive recovery KDF
 * pointless. So a password proved against a legacy hash is re-stored at full
 * strength on the spot — the one moment we legitimately have the plaintext.
 */
export const needsRehash = (auth) => Boolean(auth?.hash) && !auth.hash.startsWith("p:");

export async function verifyPin(pin, auth) {
  if (!auth?.salt || !auth?.hash) return false;
  if ((auth.hash.startsWith("s:") || auth.hash.startsWith("p:")) && !globalThis.crypto?.subtle) {
    toast(
      "This browser can't check passwords over an insecure connection — open the site the same way it was set up.",
      "err"
    );
    return false;
  }
  // Verify with the algorithm the password was CREATED with, which the prefix
  // records — otherwise every pre-existing chamber locks its cousins out.
  const algorithm = auth.hash.startsWith("p:") ? "p" : auth.hash.startsWith("s:") ? "s" : "f";
  return (await hashPin(pin, auth.salt, algorithm)) === auth.hash;
}

export async function makeAuth(pin) {
  const salt = newSalt();
  return { salt, hash: await hashPin(pin, salt) };
}

/* --------------------------------------------------------------------------
   Seat claiming
   -------------------------------------------------------------------------- */

const ATTEMPTS = 3;

/**
 * Register THIS device's signing key as authorised to act as the seat. This is
 * what turns a password (a local check anyone reading the code could fake) into
 * cryptographic authority the rest of the mesh enforces: from here on, only a
 * key bound to the seat — or the Chair — may cast its ballots or speak for it.
 * First device to a fresh seat binds it; a second device on an already-claimed
 * seat is refused by the mesh until the Chair enrols it (see authz.js).
 */
function bindSeatKey(memberId) {
  const kid = store.myFingerprint;
  if (!kid) return; // crypto not up (or unavailable) — seat stays unbound
  store.dispatch("member.claimKey", { memberId, kid });
}

/** Ask the Chair to enrol THIS device onto an already-claimed seat. Grants
 *  nothing until the Chair approves (member.enrollKey); it just lets them see
 *  the request in the Chair's Office. */
function requestSeatKey(memberId, name) {
  const kid = store.myFingerprint;
  if (!kid) return;
  store.dispatch("member.requestKey", { memberId, kid, name: name || "" });
}

/** True if the seat is already bound to a device that is not this one. */
function claimedByAnotherDevice(memberId) {
  const kid = store.myFingerprint;
  return Boolean(
    kid && select.seatClaimed(store.state, memberId) && !select.ownsSeat(store.state, memberId, kid)
  );
}

/**
 * Bind this device to a member's seat. A seat with no password yet asks its
 * first claimant to invent one — that op replicates, and from then on every
 * device honours it.
 */
export async function claimSeat(memberId) {
  const member = select.member(store.state, memberId);
  if (!member) {
    toast("That seat isn't in the roster any more.", "err");
    return false;
  }

  if (!member.auth) {
    const pin = await askDialog({
      icon: "✨",
      title: `Pick a secret password for ${member.name}`,
      hint: "Anything you'll remember. Capitals and spaces don't matter. You'll use it to sit here on any device — don't lose it, or the Chair will have to reset it!",
      placeholder: "your secret word",
      confirmLabel: "Save my password",
      password: true,
      autocomplete: "new-password",
      username: member.name,
    });
    if (!pin || !normalize(pin)) return false;
    bindSeatKey(memberId); // register this device's key as the seat's own
    store.dispatch("member.auth", { memberId, auth: await makeAuth(pin) });
    store.setIdentity({ memberId, displayName: member.name });
    toast(`Password saved. Welcome to the floor, ${member.name}! 🎉`);
    return true;
  }

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const pin = await askDialog({
      icon: "🔑",
      title: `What's the password for ${member.name}?`,
      hint:
        attempt === 1
          ? "Capitals and spaces don't matter."
          : `Not quite — try again (${ATTEMPTS - attempt + 1} ${ATTEMPTS - attempt + 1 === 1 ? "try" : "tries"} left).`,
      placeholder: "secret word",
      confirmLabel: "Take my seat",
      password: true,
      autocomplete: "current-password",
      username: member.name,
    });
    if (pin === null) return false;
    if (await verifyPin(pin, member.auth)) {
      // Re-store at current strength while we have the plaintext in hand.
      if (needsRehash(member.auth)) {
        store.dispatch("member.auth", { memberId, auth: await makeAuth(pin) });
      }
      const otherDevice = claimedByAnotherDevice(memberId);
      store.setIdentity({ memberId, displayName: member.name });
      if (otherDevice) {
        // The seat is already bound to another device. Don't silently bind a
        // second key (the mesh would reject its votes anyway) — file a request
        // the Chair can approve, and say so plainly.
        requestSeatKey(memberId, member.name);
        toast(
          `Seated as ${member.name} on this device. This seat is already registered to another device — I've asked the Chair to add this one (Chair's Office → Seats). Your votes count everywhere once they approve it. 🪑`,
          "warn"
        );
      } else {
        bindSeatKey(memberId);
        toast(`Welcome back to the floor, ${member.name}! 🎉`);
      }
      return true;
    }
  }

  toast("Three misses — ask the Chair to reset your password in the Chair's Office.", "err");
  return false;
}

/* --------------------------------------------------------------------------
   Seat codes — "here is your seat", from the Chair
   -------------------------------------------------------------------------- */

/**
 * Redeem a seat code: become that cousin on this device, then invent a password.
 *
 * The Chair hands this out (on screen, printed, in a chat) and the first device
 * to scan it takes the seat. Claiming binds this device's key, so a code that
 * leaks afterwards cannot steal the seat back — a second device needs the Chair
 * to enrol it. The password is set right after, because a seat with no password
 * is a seat anyone in the room could claim on their next device.
 */
export async function redeemSeatCode(body, sync) {
  const member = select.member(store.state, body.memberId);
  const label = member?.name || body.name || "your seat";

  // Adopt the room the Chair invited us into, so we are in the same chamber.
  if (body.psk && sync?.adoptRoomSecretFromCode) {
    try {
      sync.adoptRoomSecretFromCode(body.psk);
    } catch {
      /* a malformed secret just means pairing has to happen the usual way */
    }
  }

  // A sign-in code also CONNECTS: the Chair baked a live pairing offer into it,
  // so accepting it here opens the channel and the record starts flowing. The
  // reply travels back over the relay when one is configured; with no relay the
  // Chair scans the reply we surface, which is the second half of the WebRTC
  // handshake and cannot be skipped.
  if (body.invite && sync?.acceptInvite) {
    try {
      const reply = await sync.acceptInvite(body.invite);
      if (reply?.compact) {
        toast("Connecting… show the Chair your reply code to finish.", "warn");
        try {
          const { showReplyCode } = await import("./connect.js");
          await showReplyCode(reply);
        } catch {
          /* the pairing page shows it too */
        }
      }
    } catch {
      // An expired offer is normal for a code that has been sitting around; the
      // seat still works, they just pair separately.
    }
  }

  if (!member) {
    // The roster has not reached this device yet. Take the identity anyway; the
    // record arrives with the first sync and the seat is already ours.
    store.setIdentity({ memberId: body.memberId, displayName: body.name || "" });
    toast(`Welcome! You're seated as ${label}. Connect to a cousin to see the chamber. 🎉`);
    return true;
  }

  if (claimedByAnotherDevice(body.memberId)) {
    toast(
      `${label} is already registered to another device. Ask the Chair to add this one (Chair's Office → Members → Reset devices).`,
      "warn"
    );
    return false;
  }

  bindSeatKey(body.memberId);
  store.setIdentity({ memberId: body.memberId, displayName: member.name });

  if (!member.auth) {
    const pin = await askDialog({
      icon: "✨",
      title: `Welcome, ${member.name}! Pick a secret password`,
      hint: "You'll use it to sit in your seat on any device. Capitals and spaces don't matter — just don't forget it!",
      placeholder: "your secret word",
      confirmLabel: "Save my password",
      password: true,
      autocomplete: "new-password",
      username: member.name,
    });
    if (pin && normalize(pin)) {
      store.dispatch("member.auth", { memberId: body.memberId, auth: await makeAuth(pin) });
      toast(`Password saved. You're on the floor, ${member.name}! 🎉`);
      return true;
    }
    toast(`You're seated as ${member.name}. You can set a password any time from Members.`, "warn");
    return true;
  }

  toast(`Welcome back, ${member.name}! You're seated on this device. 🎉`);
  return true;
}

/* --------------------------------------------------------------------------
   The Chair
   -------------------------------------------------------------------------- */

const chairAuth = () => store.state.session?.chairAuth || null;

/** Chair unlock is per-tab and dies with the tab (sessionStorage). */
function chairUnlocked() {
  const auth = chairAuth();
  try {
    return Boolean(auth) && sessionStorage.getItem(CHAIR_UNLOCK_KEY) === auth.hash;
  } catch {
    return false;
  }
}

function rememberChairUnlock() {
  try {
    sessionStorage.setItem(CHAIR_UNLOCK_KEY, chairAuth()?.hash || "");
  } catch {
    /* per-tab convenience only */
  }
}

/**
 * Does the gavel belong to the cousin signed in on this device?
 *
 * The Chair used to be "whoever can type the chair password", re-asked on every
 * privileged action, which is tedious for the one person who uses it constantly.
 * A chamber now records `chairSeat` — the seat the gavel belongs to — so once
 * that cousin has signed in with THEIR password on a device whose key is
 * enrolled as a chair device, they simply are the Chair. Both halves are
 * required: the seat says who, the key says which device.
 */
export function isChairSeat() {
  const seat = store.state.session?.chairSeat;
  if (!seat || store.identity.memberId !== seat) return false;
  const kid = store.myFingerprint;
  return Boolean(kid && select.isChairDevice(store.state, kid));
}

export function isChair() {
  return isChairSeat() || chairUnlocked();
}

/**
 * Register THIS device's key as a chair device, or — if the chair has already
 * been founded by someone else — ask to be enrolled rather than seizing it.
 * The founder (first to take the gavel) binds the root chair key; every other
 * chair device must be approved by an existing one, so the gavel cannot be
 * grabbed over the wire by anyone who merely learned the password.
 */
function claimChairKey() {
  const kid = store.myFingerprint;
  if (!kid) return;
  if (select.chairEstablished(store.state) && !select.isChairDevice(store.state, kid)) {
    store.dispatch("chair.request", { kid, name: store.identity.displayName || "" });
  } else {
    store.dispatch("chair.claim", { kid });
  }
}

/**
 * Mint the recovery verifier for a password, or null if this browser cannot.
 *
 * Never fatal: a chamber without a verifier simply has no self-recovery, which
 * is exactly where things stood before. Better a Chair with no escape hatch
 * than a password that refused to be set at all.
 */
async function mintRecovery(pin) {
  try {
    return await makeChairRecovery(pin);
  } catch {
    return null;
  }
}

/**
 * Enrol THIS device as a Chair device by proving the Chair's password.
 *
 * The op carries a signature made with a key that only the password can unwrap,
 * so every replica verifies it for itself — no surviving Chair device has to
 * approve, and no server has to vouch. Returns false when the chamber predates
 * recovery verifiers or the browser lacks the crypto, in which case the caller
 * falls back to filing a request.
 */
async function recoverChairDevice(pin) {
  const kid = store.myFingerprint;
  const recovery = store.state.session?.chairRecovery;
  if (!kid || !recovery?.pub) return false;

  const ts = Date.now();
  const proof = await proveChairRecovery(recovery, pin, { room: CONFIG.room, kid, ts });
  if (!proof) return false;

  store.dispatch("chair.recover", { kid, ts, proof });
  return select.isChairDevice(store.state, kid);
}

/** True if the gavel exists but this device's key is not a chair device yet. */
function chairUnenrolled() {
  const kid = store.myFingerprint;
  return Boolean(
    kid && select.chairEstablished(store.state) && !select.isChairDevice(store.state, kid)
  );
}

/**
 * Gate for everything only the gavel may do: calling and closing votes,
 * editing the docket, publishing dispatches, and provisioning members.
 * The very first use anywhere in the chamber sets the Chair's password —
 * a small constitutional moment.
 */
export async function requireChair() {
  if (chairUnlocked()) return true;

  const auth = chairAuth();
  if (!auth) {
    const pin = await askDialog({
      icon: "🔨",
      title: "Set the Chair's password",
      hint: "No Chair password exists yet, so you get to invent it. Whoever knows it holds the gavel: they can add members, call votes, and run the chamber. Share it wisely!",
      placeholder: "the gavel's secret word",
      confirmLabel: "Take the gavel",
      password: true,
      autocomplete: "new-password",
      username: CHAIR_CREDENTIAL,
    });
    if (!pin || !normalize(pin)) return false;
    claimChairKey(); // bind this device as the founding chair key first
    store.dispatch("session.set", {
      chairAuth: await makeAuth(pin),
      // Minted with the password, not after it: a chamber whose only Chair
      // device dies before this exists has no way back in.
      chairRecovery: await mintRecovery(pin),
    });
    rememberChairUnlock();
    toast("You hold the gavel. 🔨 Rule justly.");
    return true;
  }

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const pin = await askDialog({
      icon: "🔨",
      title: "Chair's password, please",
      hint:
        attempt === 1
          ? "This action needs the gavel."
          : `That's not it — ${ATTEMPTS - attempt + 1} ${ATTEMPTS - attempt + 1 === 1 ? "try" : "tries"} left.`,
      placeholder: "the gavel's secret word",
      confirmLabel: "Unlock",
      password: true,
      autocomplete: "current-password",
      username: CHAIR_CREDENTIAL,
    });
    if (pin === null) return false;
    if (await verifyPin(pin, auth)) {
      // Same upgrade for the gavel. Only a device that already IS a chair
      // device may rewrite chairAuth, so a recovering device skips this and
      // gets the upgrade on its next unlock once it is enrolled.
      if (needsRehash(auth) && !chairUnenrolled()) {
        store.dispatch("session.set", {
          chairAuth: await makeAuth(pin),
          chairRecovery: await mintRecovery(pin),
        });
      }
      rememberChairUnlock();
      if (chairUnenrolled()) {
        // Try to self-enrol by proving the password to the whole chamber. This
        // is the answer to "my only Chair device is gone": nobody is left to
        // approve a request, but the password still proves who you are.
        const recovered = await recoverChairDevice(pin);
        if (recovered) {
          toast("Chair device recovered. Every cousin's device recognises this one now. 🔨");
        } else {
          claimChairKey(); // falls back to a request for a surviving Chair device
          toast(
            "Gavel unlocked on this tab. This device isn't a registered Chair device yet — your Chair actions apply here but won't reach everyone until another Chair device approves it (Chair's Office → Chair devices).",
            "warn"
          );
        }
      } else {
        toast("Gavel unlocked for this tab. 🔨");
      }
      return true;
    }
  }

  toast("The gavel stays put. Ask whoever holds the Chair's password.", "err");
  return false;
}

/** Change the Chair's password (requires knowing the current one). */
export async function changeChairPin() {
  if (!(await requireChair())) return false;
  const pin = await askDialog({
    icon: "🔨",
    title: "New Chair's password",
    hint: "Replaces the old one everywhere, on every device, as soon as they sync.",
    placeholder: "new secret word",
    confirmLabel: "Change it",
    password: true,
    autocomplete: "new-password",
    username: CHAIR_CREDENTIAL,
  });
  if (!pin || !normalize(pin)) return false;
  // Re-mint the verifier too. Leaving the old one in place would mean the
  // PREVIOUS password still recovered the gavel, which is the opposite of what
  // changing a password is for.
  store.dispatch("session.set", {
    chairAuth: await makeAuth(pin),
    chairRecovery: await mintRecovery(pin),
  });
  rememberChairUnlock();
  toast("Chair's password changed.");
  return true;
}
