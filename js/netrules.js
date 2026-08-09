/**
 * netrules.js — address matching for the Chair's IP moderation.
 *
 * The Chair can allow or block individual addresses or whole ranges, optionally
 * scoped to one member ("Sam may only connect from the house network"). This is
 * the matcher those rules run through. It handles IPv4 and IPv6, single
 * addresses and CIDR ranges, and it is written to fail *safe*: a rule it cannot
 * parse never matches, so a typo can lock nobody out by accident.
 *
 * A caveat worth stating where the code lives: WebRTC addresses can be
 * mDNS-obfuscated or carried through a relay, so this is a useful moderation
 * tool, not a security boundary. The security boundary is the pairing secret
 * and the signatures. IP rules are for "I don't recognise that network", not
 * "this keeps determined attackers out".
 */

const isV4 = (addr) => /^\d{1,3}(\.\d{1,3}){3}$/.test(addr);

/** Pack an IPv4 string into a 32-bit integer, or null if malformed. */
function v4ToInt(addr) {
  const parts = addr.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** Expand an IPv6 address to eight 16-bit groups, or null if malformed. */
function v6ToGroups(addr) {
  let text = addr.trim();
  if (text.includes(".")) {
    // IPv4-mapped tail (::ffff:1.2.3.4) → convert the tail to two groups.
    const idx = text.lastIndexOf(":");
    const v4 = v4ToInt(text.slice(idx + 1));
    if (v4 === null) return null;
    text = `${text.slice(0, idx + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/**
 * Does `addr` fall inside `rule`? `rule` is a single address or CIDR
 * (`10.0.0.0/8`, `192.168.1.5`, `2001:db8::/32`). Mismatched families and
 * unparseable input return false.
 */
export function matchAddress(addr, rule) {
  if (typeof addr !== "string" || typeof rule !== "string") return false;
  const [range, bitsRaw] = rule.trim().split("/");
  const bits = bitsRaw === undefined ? null : Number(bitsRaw);

  if (isV4(addr) && isV4(range)) {
    const a = v4ToInt(addr);
    const r = v4ToInt(range);
    if (a === null || r === null) return false;
    const prefix = bits === null ? 32 : bits;
    if (prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (a & mask) === (r & mask);
  }

  // Anything with a colon is treated as IPv6.
  if (addr.includes(":") && range.includes(":")) {
    const a = v6ToGroups(addr);
    const r = v6ToGroups(range);
    if (!a || !r) return false;
    const prefix = bits === null ? 128 : bits;
    if (prefix < 0 || prefix > 128) return false;
    let remaining = prefix;
    for (let i = 0; i < 8; i += 1) {
      const take = Math.min(16, Math.max(0, remaining));
      const mask = take === 0 ? 0 : (0xffff << (16 - take)) & 0xffff;
      if ((a[i] & mask) !== (r[i] & mask)) return false;
      remaining -= 16;
    }
    return true;
  }

  return false;
}

/**
 * Decide whether an address is permitted given a set of rules.
 *
 * Semantics, chosen to be predictable for a non-expert Chair:
 *  - If any BLOCK rule matches, deny. Blocks always win.
 *  - If any ALLOW rule exists at all, then an address must match one to be
 *    permitted (allow-list mode). With no allow rules, everything not blocked
 *    is permitted (block-list mode).
 *  - Rules may be scoped to a member; unscoped rules apply to everyone.
 */
export function addressAllowed(rules, addr, memberId = null) {
  if (!Array.isArray(rules) || !rules.length) return true;

  const applicable = rules.filter((r) => !r.memberId || r.memberId === memberId);
  const blocks = applicable.filter((r) => r.action === "block");
  const allows = applicable.filter((r) => r.action === "allow");

  if (blocks.some((r) => matchAddress(addr, r.cidr))) return false;
  if (allows.length) return allows.some((r) => matchAddress(addr, r.cidr));
  return true;
}
