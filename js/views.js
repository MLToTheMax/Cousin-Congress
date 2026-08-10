/**
 * views.js — renderers.
 *
 * Each function turns a slice of folded CRDT state into markup for one
 * `[data-render]` region. Regions ship with static fallback markup inside
 * them, so the page is complete and readable before any of this runs — and
 * stays complete if it never does.
 *
 * Nothing here binds event listeners: interaction is delegated once in
 * actions.js, which means re-rendering a region can never leak a handler.
 */

import { select } from "./crdt.js";
import { memberAvatar } from "./emoji-decorate.js";
import { esc, fmtDate, fmtTime, h, initials, pct, raw, relTime, timeOfStamp } from "./ui.js";

const PRESENCE_LABEL = {
  present: "On the floor",
  voting: "At the rostrum",
  remote: "Attending remotely",
  away: "Away",
};

const STAGE_INDEX = { drafted: 1, introduced: 2, committee: 3, floor: 4, enacted: 5 };
const STAGE_LABEL = {
  drafted: "Drafted",
  introduced: "Introduced",
  committee: "In committee",
  floor: "On the floor",
  enacted: "Enacted",
};

const memberName = (state, id) => select.member(state, id)?.name || "Unassigned";

/** A cousin's decorated badge when they have one, plain emoji or initials otherwise. */
function avatarOf(member, extraClass = "") {
  // A decorated badge is a five-key spec, not markup, so it re-renders from the
  // current palette every time. memberAvatar also understands a bare `icon`, so
  // cousins who never opened the decorator keep exactly the avatar they had.
  if (member?.avatar || member?.icon) {
    return h`<div class="member__avatar member__avatar--icon ${raw(extraClass)}" aria-hidden="true">${raw(memberAvatar(member, 44))}</div>`;
  }
  return h`<div class="member__avatar ${raw(extraClass)}" aria-hidden="true">${initials(member?.name)}</div>`;
}

/* ==========================================================================
   Chamber
   ========================================================================== */

function renderSession(state) {
  const session = state.session || {};
  const quorum = select.quorum(state);
  const status = session.inSession ? "In session" : session.recess ? "In recess" : "Adjourned";
  return h`
    <span class="badge ${raw(session.inSession ? "badge--live" : "badge--absent")}">${status}</span>
    <span class="u-mono">Sitting ${session.sitting ?? "—"}</span>
    <span class="u-mono">${quorum.attending}/${quorum.total} present</span>
    <span class="u-mono">${quorum.met ? "Quorum met" : "No quorum"}</span>`;
}

function renderQuorum(state) {
  const { attending, total, required, met } = select.quorum(state);
  const presentPct = pct(attending, total);
  const requiredPct = pct(required, total);
  return h`
    <div class="quorum ${raw(met ? "quorum--met" : "quorum--short")}">
      <div class="quorum__track" style="--present:${presentPct}%; --required:${requiredPct}%">
        <div class="quorum__fill"></div>
        <div class="quorum__mark"></div>
      </div>
      <div class="quorum__read">
        <span>${attending} of ${total} attending</span>
        <span>${met ? "Quorum met" : `${required - attending} more needed`}</span>
      </div>
    </div>`;
}

/**
 * Titles that mean "this cousin presides". Matched instead of a dedicated
 * field because the roster already carries a free-text role and a second
 * source of truth would only be able to disagree with it.
 */
const CHAIR_ROLE = /^(speaker|chair|chairman|chairwoman|president|presiding officer)$/i;

/** A presence we have a colour and a label for; anything else reads as away. */
const seatPresence = (m) => (PRESENCE_LABEL[m?.presence] ? m.presence : "away");

/**
 * Split the chamber into arcs.
 *
 * Row capacity is not uniform: each arc sits at a larger radius than the one in
 * front, so it is physically longer and seats more without crowding. The split
 * therefore weights rows by their distance from the rostrum rather than dividing
 * evenly.
 *
 * The row COUNT has to grow too. It used to stop at three, which is fine for a
 * family and wrong for a reunion: past roughly two dozen cousins the back arc
 * was asked to hold more seats than fit along it and the discs overlapped. Rows
 * are now added until no arc exceeds what it can seat, so a chamber of forty
 * lays out as cleanly as a chamber of four.
 */
const MAX_ROWS = 6;
/** Seats an arc can hold before its discs start touching, front row outward. */
const rowCapacity = (index) => 6 + index * 3;

export function seatRows(total) {
  if (total <= 6) return [total];

  // Fewest rows that can seat everyone without any arc going over capacity.
  let rows = 2;
  while (rows < MAX_ROWS) {
    const capacity = Array.from({ length: rows }, (_, i) => rowCapacity(i)).reduce((a, b) => a + b, 0);
    if (capacity >= total) break;
    rows += 1;
  }

  // Distribute by capacity so the front arc stays sparse and the back fills up,
  // which is what a real chamber looks like from the rostrum.
  const weights = Array.from({ length: rows }, (_, i) => rowCapacity(i));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => Math.max(1, Math.floor((total * w) / weightSum)));

  // Rounding leaves a few seats unplaced; give them to the back rows, which
  // have the most room for them.
  let placed = out.reduce((a, b) => a + b, 0);
  for (let i = out.length - 1; placed < total; i = i === 0 ? out.length - 1 : i - 1) {
    out[i] += 1;
    placed += 1;
  }
  // And if rounding overshot, take them back off the front.
  for (let i = 0; placed > total; i = (i + 1) % out.length) {
    if (out[i] > 1) {
      out[i] -= 1;
      placed -= 1;
    }
  }
  return out;
}

/**
 * One desk. The emoji rides in the disc and the name sits under it, because
 * a coloured dot alone forced everyone to hover to answer "who is that?".
 * The accessible name lives on the button so screen readers never depend on
 * the label being the visible one — CSS hides it on crowded rows.
 */
function seatButton(member, extraClass, positionStyle, roleNote) {
  const presence = seatPresence(member);
  const face = member.icon
    ? h`<span class="chamber__face" aria-hidden="true">${member.icon}</span>`
    : h`<span class="chamber__face chamber__face--text" aria-hidden="true">${initials(member.name)}</span>`;
  return h`<button type="button"
      class="chamber__seat chamber__seat--${raw(presence)}${raw(extraClass)}"
      style="${raw(positionStyle)}"
      data-action="member-detail" data-member="${member.id}"
      aria-label="${member.name}${roleNote} — ${PRESENCE_LABEL[presence]}">
      ${raw(face)}
      <span class="chamber__name" aria-hidden="true">${member.name}</span>
    </button>`;
}

function renderChamber(state) {
  const members = select.members(state);
  if (!members.length) {
    return h`<p class="empty">No seats claimed yet. The chamber fills in as cousins arrive.</p>`;
  }

  // The rostrum used to be a caption sitting beside the diagram. Drawing the
  // presiding cousin *at* the head of the room instead makes the picture one
  // chamber rather than a chart plus a label — and it is the only seat whose
  // position carries meaning on its own.
  const chairIndex = members.findIndex((m) => CHAIR_ROLE.test(String(m.role || "").trim()));
  const chair = chairIndex >= 0 ? members[chairIndex] : null;
  const seated = chair ? members.filter((_, i) => i !== chairIndex) : members;

  const rows = seatRows(seated.length);
  let cursor = 0;
  let arc = "";

  rows.forEach((capacity, rowIndex) => {
    const seats = seated.slice(cursor, cursor + capacity);
    cursor += capacity;
    if (!seats.length) return;
    // The seat's place on the arc is handed to CSS as a 0..1 fraction rather
    // than an index, so a one-seat row lands dead centre instead of dividing
    // by zero at the end of the arc.
    const span = seats.length - 1;
    // How many names a row can show before they touch. A three-deep chamber
    // packs its arcs closer together than a shallow one, so the same head
    // count runs out of room sooner; past the budget the row falls back to
    // emoji-only and hands the names to hover and keyboard focus.
    const budget = (rows.length === 3 ? [5, 6, 7] : [7, 8, 9])[rowIndex];
    const dense = seats.length > budget ? " chamber__row--dense" : "";
    arc += h`<div class="chamber__row chamber__row--${raw(String(rowIndex + 1))}${raw(dense)}"
      style="--n:${seats.length}">
      ${raw(
        seats
          .map((m, i) => {
            const t = span ? Math.round((i / span) * 1e4) / 1e4 : 0.5;
            return seatButton(m, "", `--t:${t}`, "");
          })
          .join("")
      )}
    </div>`;
  });

  const rostrum = chair
    ? h`<div class="chamber__rostrum">
        ${raw(seatButton(chair, " chamber__seat--chair", "", `, ${chair.role || "in the chair"}`))}
        <span class="chamber__plate">Rostrum</span>
      </div>`
    : h`<div class="chamber__rostrum chamber__rostrum--vacant">
        <span class="chamber__seat chamber__seat--chair chamber__seat--away" aria-hidden="true">
          <span class="chamber__face">🪑</span>
        </span>
        <span class="chamber__plate">Rostrum · vacant</span>
      </div>`;

  return h`<div class="chamber__arc" data-rows="${rows.length}">${raw(arc)}</div>${raw(rostrum)}`;
}

/**
 * The legend doubles as a head count: the same four colours the seats use,
 * each carrying how many cousins are in that state right now. A legend that
 * only names colours goes unread after the first visit.
 */
function renderChamberKey(state) {
  const counts = select.presenceCounts(state);
  // Shorter than PRESENCE_LABEL on purpose: the legend has to survive four
  // chips on one 360px row, where "Attending remotely" wraps and the colours
  // stop lining up with the seats they explain.
  const short = { present: "On the floor", voting: "At the rostrum", remote: "Remote", away: "Away" };
  return ["present", "voting", "remote", "away"]
    .map(
      (key) => h`<span class="chamber__key-item chamber__key-item--${raw(key)}">
        <span class="chamber__key-count">${counts[key]}</span>${short[key]}</span>`
    )
    .join("");
}

function renderRoster(state) {
  const members = select.members(state);
  if (!members.length) return h`<p class="empty">No members seated yet.</p>`;

  return members
    .map(
      (m) => h`
      <article class="member member--${raw(esc(m.presence || "away"))}" data-item
               data-text="${m.name} ${m.district || ""} ${m.location || ""}"
               data-presence="${m.presence || "away"}">
        ${raw(avatarOf(m))}
        <div class="member__name">
          <a href="members.html#member-${m.id}" data-cursor="card">${m.name}</a>
        </div>
        <div class="member__where">${m.location || PRESENCE_LABEL[m.presence] || "Away"}</div>
      </article>`
    )
    .join("");
}

function renderStatusFeed(state) {
  const items = select.statuses(state, 12);
  if (!items.length) {
    return h`<li class="empty">No status updates yet. Post the first one above.</li>`;
  }
  return items
    .map((s) => {
      const when = timeOfStamp(s._hlc);
      return h`
        <li class="status-item">
          ${raw(avatarOf(select.member(state, s.memberId) || { name: memberName(state, s.memberId) }))}
          <div class="status-item__who">${memberName(state, s.memberId)}</div>
          <p class="status-item__text">${s.text}</p>
          <div class="status-item__when">
            ${s.location ? raw(h`<span>${s.location} · </span>`) : raw("")}${when ? relTime(when) : "just now"}
          </div>
        </li>`;
    })
    .join("");
}

/* ==========================================================================
   Voting
   ========================================================================== */

function tallyBar(tally) {
  const total = Math.max(tally.total, 1);
  return h`
    <div class="tally">
      <div class="tally__bar" style="--yea-pct:${pct(tally.yea, total)}%; --nay-pct:${pct(
        tally.nay,
        total
      )}%; --present-pct:${pct(tally.present, total)}%; --threshold:${pct(tally.needed, total)}%"
           role="img"
           aria-label="Yea ${tally.yea}, nay ${tally.nay}, present ${tally.present}, not voting ${tally.notVoting}">
        <div class="tally__seg tally__seg--yea">${tally.yea || ""}</div>
        <div class="tally__seg tally__seg--nay">${tally.nay || ""}</div>
        <div class="tally__seg tally__seg--present">${tally.present || ""}</div>
        <div class="tally__seg tally__seg--absent"></div>
      </div>
      <div class="tally__legend">
        <span style="color:var(--yea)">Yea ${tally.yea}</span>
        <span style="color:var(--nay)">Nay ${tally.nay}</span>
        <span style="color:var(--present)">Present ${tally.present}</span>
        <span style="color:var(--absent)">Not voting ${tally.notVoting}</span>
      </div>
    </div>`;
}

function ballotForm(state, vote, myId) {
  if (!myId) {
    // .notice lays its children out as flex items, so the sentence has to
    // travel as one element — unwrapped it split into three columns the
    // moment the card was narrower than the text.
    return h`<p class="notice notice--info">
      <span>🪑 Take your seat on the <a href="members.html">Members page</a> first —
      then these big vote buttons light up for you.</span>
    </p>`;
  }
  const mine = select.ballotOf(state, vote.id, myId);
  const choice = (value, label, sub) => h`
    <label class="choice choice--${raw(value)}" data-cursor="vote">
      <input type="radio" name="ballot-${vote.id}" value="${value}"
             ${raw(mine?.choice === value ? "checked" : "")}
             data-action="cast" data-vote="${vote.id}">
      <span class="choice__mark" aria-hidden="true"></span>
      <span class="choice__word">${label}</span>
      <span class="choice__sub">${sub}</span>
    </label>`;

  return h`
    <fieldset class="choice-set" style="border:0;padding:0;margin:0">
      <legend class="u-visually-hidden">Your ballot on ${vote.title}</legend>
      ${raw(choice("yea", "Yea", "For it!"))}
      ${raw(choice("nay", "Nay", "Against it!"))}
      ${raw(choice("present", "Present", "Just watching"))}
    </fieldset>
    <p class="field__hint">
      ${raw(
        mine
          ? h`✅ Your ballot says <strong>${mine.choice}</strong> (${relTime(timeOfStamp(mine._hlc))}). Tap another to change your mind — only your last pick counts.`
          : raw("Tap one! Your ballot lands instantly and travels to every cousin's device.")
      )}
    </p>`;
}

function renderOpenVotes(state, node) {
  const votes = select.openVotes(state);
  const myId = node.dataset.member || "";
  if (!votes.length) {
    return h`<div class="empty">No votes are open. The next motion appears here the moment it is called.</div>`;
  }

  return votes
    .map((vote) => {
      const tally = select.tally(state, vote.id);
      return h`
        <article class="panel" data-item data-text="${vote.title}">
          <div class="cluster cluster--between">
            <div>
              <p class="kicker">${vote.number || "Motion"} · ${raw(
                esc(
                  { majority: "Simple majority", twothirds: "Two-thirds", unanimous: "Unanimous consent" }[
                    vote.threshold
                  ] || "Simple majority"
                )
              )}</p>
              <h3>${vote.title}</h3>
            </div>
            <span class="badge badge--live">Voting open</span>
          </div>
          <p class="u-muted">${vote.summary || ""}</p>
          ${raw(tallyBar(tally))}
          <p class="u-mono" style="font-size:var(--fs-xs)">
            ${tally.needed} of ${tally.yea + tally.nay} decisive ballots needed to carry ·
            currently ${tally.passing ? "carrying" : "failing"}
          </p>
          ${raw(
            vote.closesAt
              ? h`<div class="countdown" data-countdown="${vote.closesAt}">
                    <div class="countdown__unit"><span class="countdown__num" data-unit="h">00</span><small>hrs</small></div>
                    <div class="countdown__unit"><span class="countdown__num" data-unit="m">00</span><small>min</small></div>
                    <div class="countdown__unit"><span class="countdown__num" data-unit="s">00</span><small>sec</small></div>
                  </div>`
              : raw("")
          )}
          ${raw(ballotForm(state, vote, myId))}
          <details class="disclosure" style="margin-top:var(--sp-2)">
            <summary>🔨 Chair's controls</summary>
            <div class="disclosure__body cluster">
              <button class="btn btn--danger btn--sm" data-action="close-vote" data-vote="${vote.id}">
                Gavel it closed
              </button>
              <span class="field__hint">Needs the Chair's password. Closing freezes the tally into
                the record as ${raw(
                  tally.passing ? "<strong>agreed to</strong>" : "<strong>not agreed to</strong>"
                )}.</span>
            </div>
          </details>
        </article>`;
    })
    .join("");
}

function renderWhip(state) {
  const vote = select.openVotes(state)[0];
  if (!vote) return h`<p class="empty">No motion pending.</p>`;
  const tally = select.tally(state, vote.id);
  const members = select.members(state);

  const bucket = { yea: [], nay: [], present: [], undecided: [] };
  for (const m of members) {
    const ballot = tally.byMember[m.id];
    if (ballot?.choice) bucket[ballot.choice].push(m.name);
    else bucket.undecided.push(m.name);
  }

  const col = (key, label, cls) => h`
    <div class="whip__col whip__col--${raw(cls)}">
      <span class="whip__count">${bucket[key].length}</span>
      <span class="whip__label">${label}</span>
      <ul class="whip__names">${raw(bucket[key].slice(0, 6).map((n) => h`<li>${n}</li>`).join(""))}</ul>
    </div>`;

  return h`<div class="whip__grid">
      ${raw(col("yea", "Committed yea", "yes"))}
      ${raw(col("present", "Voting present", "lean"))}
      ${raw(col("undecided", "Not yet voted", "undecided"))}
      ${raw(col("nay", "Committed nay", "no"))}
    </div>`;
}

function renderResults(state) {
  const votes = select.closedVotes(state);
  if (!votes.length) return h`<p class="empty">No completed roll calls yet.</p>`;

  return votes
    .map((vote) => {
      const tally = select.tally(state, vote.id);
      const passed = vote.result ? vote.result === "passed" : tally.passing;
      return h`
        <article class="panel rollcall" data-item
                 data-text="${vote.title} ${vote.number || ""}"
                 data-outcome="${passed ? "passed" : "failed"}">
          <div class="rollcall__head">
            <div>
              <p class="kicker">${vote.number || "Roll call"} · ${fmtDate(vote.closedAt || vote.opensAt)}</p>
              <h3>${vote.title}</h3>
            </div>
            <span class="rollcall__verdict ${raw(passed ? "rollcall__verdict--passed" : "rollcall__verdict--failed")}">
              ${passed ? "Agreed to" : "Not agreed to"}
            </span>
          </div>
          ${raw(tallyBar(tally))}
          <details class="disclosure">
            <summary>Individual ballots</summary>
            <div class="disclosure__body">
              <div class="ballot-grid">
                ${raw(
                  select
                    .members(state)
                    .map((m) => {
                      const ballot = tally.byMember[m.id];
                      const cls = ballot?.choice ? `ballot-cell--${ballot.choice}` : "";
                      const suffix = ballot?.viaProxy
                        ? ` (proxy: ${memberName(state, ballot.viaProxy)})`
                        : "";
                      return h`<div class="ballot-cell ${raw(cls)}">${m.name}${suffix}</div>`;
                    })
                    .join("")
                )}
              </div>
            </div>
          </details>
        </article>`;
    })
    .join("");
}

function renderHistogram(state) {
  const votes = select.closedVotes(state).slice(0, 14).reverse();
  if (!votes.length) return h`<p class="empty">No history to chart yet.</p>`;

  return votes
    .map((vote) => {
      const tally = select.tally(state, vote.id);
      const total = Math.max(tally.cast, 1);
      return h`
        <div class="histogram__col">
          <div class="histogram__stack" data-grow title="${vote.title}">
            <div class="histogram__seg histogram__seg--present" style="--pct:${pct(tally.present, total)}"></div>
            <div class="histogram__seg histogram__seg--nay" style="--pct:${pct(tally.nay, total)}"></div>
            <div class="histogram__seg histogram__seg--yea" style="--pct:${pct(tally.yea, total)}"></div>
          </div>
          <span class="histogram__label">${vote.number || vote.title}</span>
        </div>`;
    })
    .join("");
}

/* ==========================================================================
   Legislation
   ========================================================================== */

function renderBills(state) {
  const bills = select.bills(state);
  if (!bills.length) return h`<p class="empty">No legislation on file.</p>`;

  return bills
    .map((bill) => {
      const stage = bill.stage || "drafted";
      const cosponsors = select.cosponsorsOf(state, bill.id);
      return h`
        <article class="card card--filed card--interactive" data-item
                 data-text="${bill.number || ""} ${bill.title} ${memberName(state, bill.sponsor)}"
                 data-stage="${stage}"
                 style="--spine:var(${raw(stage === "enacted" ? "--c-green-600" : stage === "floor" ? "--c-red-500" : "--c-blue-600")})">
          <div class="cluster cluster--between">
            <p class="kicker">${bill.number || "Draft"}</p>
            <span class="badge badge--info">${raw(esc(STAGE_LABEL[stage] || stage))}</span>
          </div>
          <h3 class="card__title">
            <a href="bills.html#bill-${bill.id}" data-cursor="card">${bill.title}</a>
          </h3>
          <p class="u-muted" style="font-size:var(--fs-sm)">${bill.summary || ""}</p>
          <ol class="pipeline pipeline--compact" data-stage="${STAGE_INDEX[stage] || 1}">
            <li class="pipeline__step">Drafted</li>
            <li class="pipeline__step">Introduced</li>
            <li class="pipeline__step">Committee</li>
            <li class="pipeline__step">Floor</li>
            <li class="pipeline__step">Enacted</li>
          </ol>
          <div class="card__meta">
            <span>Sponsor: ${memberName(state, bill.sponsor)}</span>
            <span>${cosponsors.length} cosponsor${cosponsors.length === 1 ? "" : "s"}</span>
            <span>${fmtDate(bill.introduced)}</span>
          </div>
          <div class="card__foot">
            <button class="btn btn--ghost btn--sm" data-action="cosponsor" data-bill="${bill.id}">
              Add my sign-on
            </button>
            <a class="link-arrow" href="bills.html#bill-${bill.id}">Read the text</a>
          </div>
        </article>`;
    })
    .join("");
}

function renderBillDetail(state, node) {
  const billId = node.dataset.bill || location.hash.replace("#bill-", "");
  const bill = select.bill(state, billId) || select.bills(state)[0];
  if (!bill) return h`<p class="empty">Select a bill to read its text.</p>`;

  const cosponsors = select.cosponsorsOf(state, bill.id);
  const amendments = select.amendmentsFor(state, bill.id);
  const comments = select.commentsFor(state, bill.id);

  return h`
    <div class="stack stack--lg">
      <div>
        <p class="kicker">${bill.number || "Draft"} · ${raw(esc(STAGE_LABEL[bill.stage] || "Drafted"))}</p>
        <h2>${bill.title}</h2>
        <p class="u-muted">Introduced ${fmtDate(bill.introduced)} by ${memberName(state, bill.sponsor)}</p>
      </div>

      <ol class="pipeline" data-stage="${STAGE_INDEX[bill.stage] || 1}">
        <li class="pipeline__step">Drafted</li>
        <li class="pipeline__step">Introduced</li>
        <li class="pipeline__step">Committee</li>
        <li class="pipeline__step">Floor</li>
        <li class="pipeline__step">Enacted</li>
      </ol>

      <div class="cluster">
        ${raw(
          (bill.stage || "drafted") !== "enacted"
            ? h`<button class="btn btn--ghost btn--sm" data-action="advance-stage" data-bill="${bill.id}">
                 🔨 Move it along the pipeline
               </button>`
            : raw("")
        )}
        <button class="btn btn--ghost btn--sm" data-action="share-item" data-type="bill" data-id="${bill.id}" data-cursor="card">
          🔗 Copy read-only link
        </button>
        <button class="btn btn--ghost btn--sm" data-action="share-live" data-type="bill" data-id="${bill.id}">
          👋 Live guest link
        </button>
      </div>

      <div class="engrossment">
        <div class="engrossment__seal" aria-hidden="true">CC</div>
        <p class="engrossment__congress">First Cousin Congress · ${raw(esc(bill.session || "Session I"))}</p>
        <p class="engrossment__number">${bill.number || "Draft"}</p>
        <p class="engrossment__title">${bill.title}</p>
        <p class="engrossment__clause"><strong>Be it enacted by the Cousins in Congress assembled,</strong></p>
        <div class="engrossment__body">${bill.text || bill.summary || ""}</div>
        <div class="engrossment__sig">
          <span>Sponsor — ${memberName(state, bill.sponsor)}</span>
          <span>${fmtDate(bill.introduced)}</span>
        </div>
      </div>

      <section class="stack">
        <h3>Cosponsors</h3>
        <ul class="cosponsors">
          ${raw(
            cosponsors.length
              ? cosponsors
                  .map(
                    (id, i) =>
                      h`<li class="cosponsor ${raw(i === 0 ? "cosponsor--lead" : "")}" data-initials="${initials(
                        memberName(state, id)
                      )}">${memberName(state, id)}</li>`
                  )
                  .join("")
              : h`<li class="u-muted">No sign-ons yet.</li>`
          )}
        </ul>
        <div><button class="btn btn--ghost btn--sm" data-action="cosponsor" data-bill="${bill.id}">Sign on as cosponsor</button></div>
      </section>

      <section class="stack">
        <h3>Amendments</h3>
        ${raw(
          amendments.length
            ? amendments
                .map(
                  (a) => h`<div class="card card--filed" style="--spine:var(--c-yellow-500)">
                    <p class="kicker">${a.number || "Amendment"} · ${memberName(state, a.author)}</p>
                    <p>${a.text}</p>
                  </div>`
                )
                .join("")
            : h`<p class="empty">No amendments filed.</p>`
        )}
        <form class="stack" data-action="file-amendment" data-bill="${bill.id}">
          <div class="field">
            <label class="field__label" for="amend-text">Propose an amendment</label>
            <textarea class="textarea" id="amend-text" name="text" required minlength="10"
              placeholder="Strike section 2 and insert…"></textarea>
            <p class="field__error">An amendment needs at least ten characters.</p>
          </div>
          <div><button class="btn btn--sm" type="submit">File amendment</button></div>
        </form>
      </section>

      <section class="stack">
        <h3>Public comment</h3>
        <ul class="thread">
          ${raw(
            comments.length
              ? comments
                  .map(
                    (c) => h`<li class="comment comment--${raw(esc(c.stance || "neutral"))}">
                      <div class="comment__head">
                        <span class="comment__author">${c.author || "Anonymous cousin"}</span>
                        <span class="comment__meta">${relTime(timeOfStamp(c._hlc))}</span>
                      </div>
                      <p class="comment__body">${c.body}</p>
                    </li>`
                  )
                  .join("")
              : h`<li class="empty">No comments on the record.</li>`
          )}
        </ul>
        <form class="stack" data-action="comment" data-target="${bill.id}">
          <div class="form-grid form-grid--2">
            <div class="field">
              <label class="field__label" for="comment-name">Your name</label>
              <input class="input" id="comment-name" name="author" required maxlength="60">
              <p class="field__error">Please sign your comment.</p>
            </div>
            <div class="field">
              <label class="field__label" for="comment-stance">Position</label>
              <select class="select" id="comment-stance" name="stance">
                <option value="support">Support</option>
                <option value="neutral" selected>Neutral</option>
                <option value="oppose">Oppose</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label class="field__label" for="comment-body">Comment</label>
            <textarea class="textarea" id="comment-body" name="body" required minlength="4" maxlength="600"></textarea>
          </div>
          <div><button class="btn btn--sm" type="submit">Add to the record</button></div>
        </form>
      </section>
    </div>`;
}

/* ==========================================================================
   Newsroom, docket, directory
   ========================================================================== */

const BANNERS = ["--c-blue-600", "--c-red-500", "--c-yellow-500", "--c-blue-800", "--c-green-600"];

function renderNews(state) {
  const items = select.news(state);
  if (!items.length) return h`<p class="empty">No dispatches yet.</p>`;

  return items
    .map(
      (item, i) => h`
      <article class="news-card ${raw(i === 0 && !item.memberNote ? "news-card--feature" : "")}" data-item
               data-text="${item.title} ${item.category || ""}" data-category="${item.category || "notice"}">
        <div class="news-card__banner" style="--banner:var(${raw(item.memberNote ? "--c-green-600" : BANNERS[i % BANNERS.length])})" aria-hidden="true">
          ${raw(item.memberNote ? "📝" : esc((item.category || "Notice").slice(0, 1).toUpperCase()))}
        </div>
        <div class="news-card__body">
          <p class="kicker">${item.memberNote ? raw(h`Note · ${item.author || "A cousin"}`) : item.category || "Notice"}</p>
          <h3 class="news-card__title"><a href="news.html#post-${item.id}" data-cursor="read">${item.title}</a></h3>
          <p class="news-card__excerpt">${item.excerpt || item.body || ""}</p>
          <p class="news-card__meta">${fmtDate(item.published)} · ${item.author || "Office of the Clerk"}</p>
          <button class="btn btn--ghost btn--sm" data-action="share-item" data-type="news" data-id="${item.id}"
                  style="justify-self:start;margin-top:var(--sp-2)">🔗 Share</button>
        </div>
      </article>`
    )
    .join("");
}

function renderDocket(state) {
  const items = select.docket(state);
  if (!items.length) return h`<p class="empty">The docket is clear.</p>`;

  const now = Date.now();
  return items
    .map((item) => {
      const start = new Date(item.starts).getTime();
      const stateClass = Number.isFinite(start)
        ? start + (item.durationMin || 30) * 60000 < now
          ? "timeline__item--done"
          : start <= now
            ? "timeline__item--now"
            : "timeline__item--next"
        : "timeline__item--next";
      return h`
        <li class="timeline__item ${raw(stateClass)}" data-item
            data-text="${item.title} ${item.kind || ""}" data-kind="${item.kind || "session"}">
          <div class="timeline__time">${fmtTime(item.starts)}</div>
          <div class="timeline__body">
            <p class="timeline__title">${item.title}</p>
            <p class="timeline__note">${item.note || ""} ${item.room ? raw(h`· ${item.room}`) : raw("")}</p>
          </div>
        </li>`;
    })
    .join("");
}

function renderCalendar(state) {
  const events = select.docket(state);
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7; // weeks start Monday
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const byDay = new Map();
  for (const event of events) {
    const date = new Date(event.starts);
    if (Number.isNaN(date.getTime())) continue;
    if (date.getFullYear() !== year || date.getMonth() !== month) continue;
    const list = byDay.get(date.getDate()) || [];
    list.push(event);
    byDay.set(date.getDate(), list);
  }

  let cells = "";
  for (let i = 0; i < startOffset; i += 1) cells += h`<div class="calendar__day calendar__day--muted"></div>`;

  for (let day = 1; day <= daysInMonth; day += 1) {
    const isToday = day === today.getDate();
    const events = byDay.get(day) || [];
    cells += h`<div class="calendar__day ${raw(isToday ? "calendar__day--today" : "")}">
      <span class="calendar__num">${day}</span>
      ${raw(
        events
          .map(
            (e) => h`<a class="calendar__event calendar__event--${raw(esc(e.kind || "session"))}"
                 href="docket.html#event-${e.id}" title="${e.title}">${e.title}</a>`
          )
          .join("")
      )}
    </div>`;
  }

  const trailing = (7 - ((startOffset + daysInMonth) % 7)) % 7;
  for (let i = 0; i < trailing; i += 1) cells += h`<div class="calendar__day calendar__day--muted"></div>`;

  return cells;
}

function renderDirectory(state, node) {
  const members = select.members(state);
  if (!members.length) return h`<p class="empty">No members enrolled yet — the Chair's Office below can fix that.</p>`;
  const myId = node?.dataset.member || "";

  return members
    .map((m) => {
      const card = select.scorecard(state, m.id);
      const isMe = m.id === myId;
      return h`
        <article class="scorecard ${raw(isMe ? "scorecard--me" : "")}" id="member-${m.id}" data-item
                 data-text="${m.name} ${m.district || ""} ${m.role || ""}"
                 data-presence="${m.presence || "away"}">
          <div class="scorecard__head">
            ${raw(avatarOf(m))}
            <div>
              <h3 style="font-size:var(--fs-md);font-family:var(--font-body)">${m.name}</h3>
              <p class="profile__role">${m.role || "Representative"} · ${m.district || "At large"}</p>
            </div>
          </div>
          <div class="cluster">
            <span class="badge badge--${raw(
              esc(m.presence === "present" || m.presence === "voting" ? "yea" : m.presence === "remote" ? "present" : "absent")
            )}">${raw(esc(PRESENCE_LABEL[m.presence] || "Away"))}</span>
            <span class="badge badge--bare badge--${raw(m.auth ? "info" : "absent")}">${raw(
              m.auth ? "🔒 password set" : "✨ no password yet"
            )}</span>
            ${raw(m.dnd ? h`<span class="dnd">Do not disturb</span>` : raw(""))}
          </div>
          <dl class="scorecard__metrics">
            <div class="scorecard__metric"><dt>Attendance</dt><dd>${card.attendance}%</dd></div>
            <div class="scorecard__metric"><dt>Votes cast</dt><dd>${card.votesCast}/${card.votesEligible}</dd></div>
            <div class="scorecard__metric"><dt>Sponsored</dt><dd>${card.sponsored}</dd></div>
            <div class="scorecard__metric"><dt>Cosponsored</dt><dd>${card.cosponsored}</dd></div>
          </dl>
          ${raw(
            isMe
              ? h`<div class="cluster">
                   <span class="badge badge--yea">🪑 You're seated here</span>
                   <button class="btn btn--ghost btn--sm" data-action="release-seat">Stand up</button>
                 </div>`
              : h`<button class="btn btn--sm" data-action="claim-seat" data-member="${m.id}">
                   👋 This is my seat
                 </button>`
          )}
        </article>`;
    })
    .join("");
}

/** The Chair's roster editor — the easily editable list of users. */
function renderProvision(state) {
  const members = select.members(state);
  if (!members.length) return h`<p class="empty">Nobody enrolled yet. Add the first cousin above!</p>`;

  return members
    .map(
      (m) => h`
      <div class="row provision-row">
        <span class="row__when" style="font-size:1.4rem" aria-hidden="true">${m.icon || "🪑"}</span>
        <div class="row__what">
          <span class="row__title">${m.name}</span>
          <span class="row__note">${m.district || "At large"} · ${raw(
            m.auth ? "🔒 has a password" : "✨ no password yet"
          )}</span>
        </div>
        <span class="cluster">
          <button class="btn btn--ghost btn--sm" data-action="reset-pin" data-member="${m.id}">
            Reset password
          </button>
          <button class="btn btn--danger btn--sm" data-action="remove-member" data-member="${m.id}">
            Retire
          </button>
        </span>
      </div>`
    )
    .join("");
}

function renderCommittees(state) {
  const committees = select.committees(state);
  if (!committees.length) return h`<p class="empty">No standing committees.</p>`;
  return committees
    .map(
      (c, i) => h`
      <article class="committee" data-item data-text="${c.name} ${c.scope || ""}"
               style="--spine:var(${raw(BANNERS[i % BANNERS.length])})">
        <h3 class="committee__name">${c.name}</h3>
        <p class="committee__chair">Chair: ${memberName(state, c.chair)}</p>
        <p class="committee__scope">${c.scope || ""}</p>
        <p class="u-mono" style="font-size:var(--fs-2xs)">${(c.members || []).length} members</p>
      </article>`
    )
    .join("");
}

/* ==========================================================================
   Dashboards
   ========================================================================== */

function renderKpis(state) {
  const bills = select.bills(state);
  const closed = select.closedVotes(state);
  const quorum = select.quorum(state);
  const enacted = bills.filter((b) => b.stage === "enacted").length;
  const passRate = closed.length
    ? Math.round(
        (closed.filter((v) => (v.result ? v.result === "passed" : select.tally(state, v.id).passing)).length /
          closed.length) *
          100
      )
    : 0;

  const tiles = [
    ["Members enrolled", quorum.total, "--c-blue-600"],
    ["Bills on file", bills.length, "--c-red-500"],
    ["Roll calls held", closed.length, "--c-yellow-600"],
    ["Measures enacted", enacted, "--c-green-600"],
    ["Motions carried", `${passRate}%`, "--c-blue-800"],
  ];

  return tiles
    .map(
      ([label, value, color]) => h`
      <div class="kpi">
        <span class="kpi__value" style="--kpi-color:var(${raw(color)})">${value}</span>
        <span class="kpi__label">${label}</span>
      </div>`
    )
    .join("");
}

/* ==========================================================================
   Option lists — used to hydrate <select> elements in static forms
   ========================================================================== */

function renderMemberOptions(state, node) {
  const placeholder = node.dataset.placeholder || "Choose a member…";
  return h`<option value="">${placeholder}</option>${raw(
    select
      .members(state)
      .map((m) => h`<option value="${m.id}">${m.name}</option>`)
      .join("")
  )}`;
}

function renderCommitteeOptions(state) {
  return h`<option value="">No referral</option>${raw(
    select
      .committees(state)
      .map((c) => h`<option value="${c.id}">${c.name}</option>`)
      .join("")
  )}`;
}

/**
 * Chamber-wide announcements, shown to every device — including ones where
 * nobody has taken a seat. This is the "everyone in the room hears it" channel:
 * the Chair speaks and the whole gallery listens without logging in.
 */
function renderAnnouncements(state) {
  const items = select.announcements(state, 4);
  if (!items.length) return "";
  return items
    .map((a) => {
      const when = timeOfStamp(a._hlc);
      return h`
        <div class="announce announce--${raw(esc(a.tone || "info"))}" role="status">
          <span class="announce__icon" aria-hidden="true">${a.icon || "📣"}</span>
          <div class="announce__body">
            <p class="announce__text">${a.text}</p>
            <p class="announce__meta">${a.by || "The Chair"}${when ? raw(h` · ${relTime(when)}`) : raw("")}</p>
          </div>
        </div>`;
    })
    .join("");
}

function renderTicker(state) {
  const session = state.session || {};
  const quorum = select.quorum(state);
  const open = select.openVotes(state);
  const nextEvent = select
    .docket(state)
    .find((e) => new Date(e.starts).getTime() > Date.now());
  const latest = select.news(state)[0];

  const items = [
    h`<span class="ticker__item ${raw(session.inSession ? "ticker__item--live" : "")}">
       <span class="ticker__label">Chamber</span>
       ${session.inSession ? "In session" : session.recess ? "In recess" : "Adjourned"} · sitting ${session.sitting ?? "—"}
     </span>`,
    h`<span class="ticker__item"><span class="ticker__label">Quorum</span>
       ${quorum.attending}/${quorum.total} attending — ${quorum.met ? "met" : "not met"}</span>`,
    ...open.map(
      (v) => h`<span class="ticker__item ticker__item--live">
        <span class="ticker__label">On the floor</span>${v.number || "Vote"}: ${v.title}</span>`
    ),
    nextEvent
      ? h`<span class="ticker__item"><span class="ticker__label">Up next</span>
          ${nextEvent.title} · ${fmtTime(nextEvent.starts)}</span>`
      : raw(""),
    latest
      ? h`<span class="ticker__item"><span class="ticker__label">Newsroom</span>${latest.title}</span>`
      : raw(""),
  ]
    .map(String)
    .join("");

  // Two copies inside one track make the marquee loop seamless.
  return h`${raw(items)}<span aria-hidden="true" style="display:contents">${raw(items)}</span>`;
}

/* ==========================================================================
   Registry
   ========================================================================== */


/**
 * One line for the Floor's desk card: what the chamber is actually being asked.
 *
 * The card replaced a "Cast your vote" button that said the same thing whether
 * a roll call was open or the chamber had been quiet for a week. A button that
 * cannot tell you there is nothing to vote on is furniture, so this says which
 * question is open, or how many, or that none are.
 */
function renderFloorQuestion(state) {
  // Renderers take the state and RETURN markup — renderAll assigns it. Taking
  // (node, state) and writing textContent instead returns undefined, and the
  // region duly renders the word "undefined".
  if (!state?.votes) return h`See what is before the chamber`;
  const open = select.openVotes(state);
  if (!open.length) return h`Nothing before the chamber right now`;
  if (open.length > 1) return h`${open.length} roll calls open`;
  return h`${open[0].title || "A question is before the chamber"}`;
}

export const VIEWS = {
  session: renderSession,
  quorum: renderQuorum,
  chamber: renderChamber,
  chamberKey: renderChamberKey,
  roster: renderRoster,
  statusFeed: renderStatusFeed,
  openVotes: renderOpenVotes,
  floorQuestion: renderFloorQuestion,
  whip: renderWhip,
  results: renderResults,
  histogram: renderHistogram,
  bills: renderBills,
  billDetail: renderBillDetail,
  news: renderNews,
  docket: renderDocket,
  calendar: renderCalendar,
  directory: renderDirectory,
  committees: renderCommittees,
  kpis: renderKpis,
  memberOptions: renderMemberOptions,
  committeeOptions: renderCommitteeOptions,
  ticker: renderTicker,
  provision: renderProvision,
  announcements: renderAnnouncements,
};

/**
 * Paint every region present on this page. Regions are independent, so a
 * renderer that throws takes out one panel and leaves its static fallback in
 * place rather than blanking the document.
 */
export function renderAll(state, scope = document) {
  for (const node of scope.querySelectorAll("[data-render]")) {
    const view = VIEWS[node.dataset.render];
    if (!view) continue;
    try {
      // A repaint must never eat what the member is typing — but a focused
      // radio or button must not freeze its region either (that would stall
      // the live tally the moment someone casts a ballot). So: skip only for
      // text entry, and re-find focus for everything else after the repaint.
      const ae = document.activeElement;
      const holdsFocus = ae && ae !== document.body && node.contains(ae);
      if (holdsFocus) {
        const typing =
          ae.tagName === "TEXTAREA" ||
          ae.tagName === "SELECT" ||
          ae.isContentEditable ||
          (ae.tagName === "INPUT" && !["radio", "checkbox", "button", "submit"].includes(ae.type));
        if (typing) continue;
      }

      let refocus = null;
      if (holdsFocus) {
        if (ae.id) refocus = `#${CSS.escape(ae.id)}`;
        else if (ae.tagName === "INPUT" && ae.name) {
          refocus = `input[name="${CSS.escape(ae.name)}"][value="${CSS.escape(ae.value)}"]`;
        } else if (ae.dataset?.action) {
          refocus =
            `[data-action="${CSS.escape(ae.dataset.action)}"]` +
            (ae.dataset.member ? `[data-member="${CSS.escape(ae.dataset.member)}"]` : "") +
            (ae.dataset.vote ? `[data-vote="${CSS.escape(ae.dataset.vote)}"]` : "") +
            (ae.dataset.bill ? `[data-bill="${CSS.escape(ae.dataset.bill)}"]` : "");
        }
      }

      const keepValue = node.tagName === "SELECT" ? node.value : null;
      node.innerHTML = view(state, node);
      if (keepValue !== null) node.value = keepValue;
      if (refocus) node.querySelector(refocus)?.focus({ preventScroll: true });
      node.dataset.rendered = "true";
    } catch (error) {
      console.error(`[cousin-congress] view "${node.dataset.render}" failed`, error);
    }
  }
}

export default renderAll;
