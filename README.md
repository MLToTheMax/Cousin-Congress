# Cousin Congress

**The People's Living Room.** A full working legislature for a family that takes
its fun seriously: floor presence, roll-call voting, bill drafting, committees,
a docket, a newsroom, and an append-only public record — built as a static site
that runs entirely in the browser, keeps working offline, and syncs
cousin-to-cousin with no server required.

## What's inside

| Area | Features |
| --- | --- |
| **The Floor** (`floor.html`) | Live presence board, seating chart on an arc, location + status updates, quorum meter, one-tap check-in, do-not-disturb, running docket |
| **Voting** (`voting.html`) | Cast Yea/Nay/Present with shape-morphing ballots, live tallies with majority lines, countdown windows, whip board, call & close roll calls, Rule 9 proxy delegation |
| **Results** (`results.html`) | Roll-call archive, member-by-member ballots, division histograms, transparency KPIs |
| **Legislation** (`bills.html`, `draft.html`) | Bill tracker with 5-stage pipeline, cosponsor sign-on, amendments, public comment record, drafting studio with live engrossed-parchment preview and autosave |
| **Docket** (`docket.html`) | Month calendar, filterable schedule, Clerk's desk for new entries |
| **Newsroom** (`news.html`) | Dispatch feed, press office composer, bulletin signup |
| **Members** (`members.html`) | Directory with scorecards (attendance, votes cast, sponsorship), committees, leadership, seat claiming |
| **Devices** (`sync.html`) | Replication console: transports, version vector, peer pairing, export/import, recovery |

## Architecture: local-first, peer-to-peer

The entire chamber state is a fold over an **append-only log of operations**
(a CRDT). Every device is a full replica:

1. **Every action applies locally first** — votes, bills, statuses land in
   IndexedDB and paint instantly. The network is an optimization, never a
   requirement.
2. **Ops carry hybrid logical clocks** and merge deterministically, so replicas
   that sync in any order converge on identical state. A member's ballot on a
   question is keyed `(vote, member)` — last cast wins, never double-counted.
3. **Three transports, one protocol** (`hello / vv / ops / signal / peers`):
   - `BroadcastChannel` between tabs on one device,
   - **WebRTC data channels** directly between browsers,
   - an optional **Cloudflare Worker relay** (WebSocket, with HTTP polling
     fallback).
4. **Anti-entropy**: replicas periodically exchange version vectors and
   backfill exactly what the other is missing. Ops gossip onward across the
   mesh, so pairing with *one* online peer recovers *everything* —
   **as long as any single replica survives, all state is recoverable.**
   Belt-and-braces: the console exports the full log as a file, and importing
   that file into a fresh browser rebuilds the chamber byte-for-byte.

Peer pairing works two ways:

- **Brokered** — with the Worker deployed, browsers discover each other through
  the relay and pair automatically (the relay only carries the handshake).
- **Direct invite codes** — with no server at all, one cousin generates a code
  on `sync.html`, the other pastes back an answer. The codes carry the WebRTC
  handshake by hand; afterwards the connection is browser-to-browser.

`data/seed.json` is the genesis snapshot: every replica deterministically
derives identical genesis ops from it, so the seed never duplicates on merge.

## CSS-first by design

JavaScript is kept to data plumbing. The presentation layer is CSS:

- **Scroll choreography** via native scroll-driven animations
  (`animation-timeline: scroll()/view()`) — scrubbed reveals, parallax,
  reading-progress bar, condensing header — with an IntersectionObserver
  fallback and full `prefers-reduced-motion` support.
- **The custom cursor**: JS publishes two coordinates; every morph (ring →
  circle on buttons, tilted yellow square on cards, crimson triangle on
  ballots, I-bar on text) is a CSS `:has()` rule. Touch devices keep native
  behavior; keyboard focus rings are never suppressed.
- **CSS-only interaction**: mobile nav (checkbox), tabs (radios), dropdowns
  (`:focus-within`), dialogs (`:target`), counters (`@property` +
  `counter()`), validation styling (`:user-invalid`), filtering visibility,
  vote meters, pipelines, quorum gauges.
- **Theming**: the whole palette is `light-dark()` tokens; the night-session
  toggle just pins `color-scheme`. Primary blue / crimson / brass yellow on
  paper, with primary-shape furniture (circle / square / triangle) throughout.

Stylesheets are split by role: `tokens` → `base` → `layout` → `components` →
`features` → `pages` → `motion` → `cursor`.

## Hosting on GitHub Pages

The repo root **is** the site — no build step.

1. Push to `main`.
2. Repo **Settings → Pages → Source: GitHub Actions** (the included
   `.github/workflows/pages.yml` deploys on every push), or choose
   "Deploy from a branch" and pick `main` / root.
3. Done. Everything — including offline use, tab sync, and invite-code
   peer-to-peer sync — works on Pages with no server.

Any other static host (Cloudflare Pages, Netlify, a USB stick) works the same.

## Optional: the Cloudflare Worker

Adds an always-on relay (members needn't be online simultaneously), durable
off-device custody of the log, automatic peer pairing, and the two private
flows (constituent mail, bulletin signups).

```bash
cd worker
npx wrangler deploy          # prints https://cousin-congress.<you>.workers.dev
```

Then set it in `js/config.js`:

```js
apiBase: "https://cousin-congress.<you>.workers.dev",
```

Optional hardening / extras (see `worker/wrangler.toml`):

- `ALLOWED_ORIGIN` — lock CORS to your Pages origin.
- `npx wrangler secret put WRITE_KEY` — gate writes on a shared secret.
- Bind **D1** (`DB`, schema in `worker/schema.sql`) or **KV** (`MAILBOX`) to
  store constituent messages and subscriptions.

The Worker is a dumb, durable pipe: it validates shape and size, stores ops in
a per-room Durable Object, relays deltas, and never interprets chamber state.

### API surface

| Route | Purpose |
| --- | --- |
| `GET /room/:room/ws?actor=…` | WebSocket: sync protocol + WebRTC signaling + peer roster |
| `POST /api/ops` | HTTP fallback: append ops `{room, actor, ops}` |
| `POST /api/ops/since` | HTTP fallback: delta pull `{room, actor, vv}` |
| `GET /room/:room/info` | Room stats: replicas, online actors, version vector |
| `POST /api/messages` | Private constituent mail |
| `POST /api/subscribe` | Bulletin signup |
| `GET /api/health` | Liveness |

## Repository layout

```
├── index.html            # Home: hero, seal, KPIs, histogram, process, news
├── floor.html …          # The other ten pages (static, complete without JS)
├── css/                  # tokens, base, layout, components, features,
│                         # pages, motion, cursor — in cascade order
├── js/
│   ├── config.js         # Deployment config (apiBase, room, transports)
│   ├── crdt.js           # HLC, version vectors, reducers, log, selectors
│   ├── store.js          # IndexedDB persistence, identity, genesis seeding
│   ├── sync.js           # Coordinator: one protocol over three transports
│   ├── sync-tabs.js      # BroadcastChannel transport
│   ├── sync-server.js    # Worker relay transport (WS + HTTP fallback)
│   ├── sync-peers.js     # WebRTC mesh + invite-code pairing
│   ├── views.js          # State → markup renderers for [data-render] regions
│   ├── actions.js        # Delegated click/form handlers (all writes)
│   ├── ui.js             # Escaping, formatting, toasts, reveal fallback
│   ├── cursor.js         # Pointer coordinates only; morphs live in CSS
│   └── app.js            # Boot order: chrome → log → paint → sync
├── data/seed.json        # Genesis snapshot (members, bills, votes, …)
└── worker/               # Optional Cloudflare Worker (DO + D1/KV)
```

## Local development

Any static file server works:

```bash
python3 -m http.server 8080
# or: npx serve
```

Open two different browsers (or a normal + private window) on `sync.html` and
pair them with invite codes to watch peer-to-peer sync converge locally.
`window.CousinCongress` in the console exposes the store, sync coordinator,
and selectors.
