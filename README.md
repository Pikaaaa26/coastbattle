# ⚓ Coast Battle

**Build · Bombard · Rule the Tide.**

A retro/pixel **naval base-building war game** — a Battleship reimagining. Two-to-four commanders
share one procedurally generated 20×20 **archipelago**, each owning an equal-sized island
territory. Start with a Command Base and a trickle of energy, raise power/research/detection/defense
and weapons turn by turn, scout enemy structures hidden in the fog, and **bombard their base into the
sea**. Last commander standing wins.

Built on an **authoritative shared TypeScript engine** used by both the client (vs-AI / hotseat) and
the multiplayer server — so the rules are identical everywhere and impossible to cheat online.

![Coast Battle](docs/DESIGN.md)

---

## ✨ Features

- **4 procedural island maps** — Twin Continents, Scattered Atolls, The Ring, Fractured Bay. 20×20,
  with mountains (block radar), reefs, and impassable sea. Both players get the *same* map (seeded).
- **Equal territory** for every commander (verified equal for 2/3/4 players) — satisfies the
  "one map, multiple players, equal buildable cells" mode.
- **Living economy** — no fixed fleet. Energy ⚡ per turn; spend it to build:
  - **Core:** Command Base (HQ), Power Plant, Missile Silo, Artillery, Research Station, Nuclear Facility
  - **Advanced (need Research):** Radar, Sonar, Signal Jammer, Shield Generator, Flak Turret, Engineering Bay
- **Fog of war + detection** — enemy structures hidden until revealed by radar, sonar, or a direct hit.
- **Escalation to nukes** — 3×3 obliteration that *irradiates* terrain permanently.
- **Smart CPU commander** — probability-density + hunt/target parity targeting (real battleship AI), plus
  an economy build order. Easy/Normal/Hard.
- **4 modes:** Skirmish vs AI · Hotseat (pass-and-play) · Online Duel 1v1 · Online Free-for-All (3–4).
- **Pixel/CRT presentation** — canvas renderer with procedural sprites, particle explosions, missile arcs,
  radar sweeps, nuke flash + screen shake, animated water, scanline CRT filter, and fully synthesized
  chiptune SFX (no audio assets).

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full rules, balance table, and architecture.

---

## 🚀 Run it

Requires **Node 18+** (built/tested on Node 24).

```bash
npm install

# Dev: runs the Vite client (:5173) + the WebSocket server (:8787) together
npm run dev
```

Open **http://localhost:5173**. Skirmish vs AI and Hotseat work entirely in the browser. Online modes
talk to the WS server (the Vite dev server proxies `/ws` → `:8787`).

Other scripts:

```bash
npm run dev:client    # Vite client only
npm run dev:server    # WS server only (:8787)
npm run engine:test   # headless engine self-test (map gen + AI-vs-AI sims + fog + determinism)
npm run typecheck     # tsc --noEmit over the whole project
npm run build         # production client build -> dist/
npm start             # run the server; it serves dist/ + handles /ws on one port
```

---

## 📦 Deploy (single service)

`npm run build` outputs the client to `dist/`. The Node server **serves `dist/` as static files and
handles WebSockets on the same `PORT`**, so the whole game (client + online) is ONE deployable:

```bash
npm run build
PORT=8080 npm start      # serves the game + /ws on :8080
```

The client auto-derives `wss://<host>/ws` and same-origin `/api`, so no client config is needed.

### Deploy to Render (recommended)

A **`render.yaml`** blueprint and a multi-stage **`Dockerfile`** are included.

1. Push this repo to GitHub/GitLab.
2. On Render → **New + → Blueprint** → select the repo. It reads `render.yaml` and creates a Docker
   web service that builds the client and runs the server.
3. Render injects `PORT` (the server reads `process.env.PORT`); health check is `/healthz`.

It runs on the **free** plan. Notes:

- **WebSocket keepalive** is built in (30 s server ping/pong) and the client **auto-reconnects + rejoins**
  on a dropped socket, so matches survive Render's idle-socket proxy and brief network blips.
- **Leaderboard/battle-logs are ephemeral on free** (the filesystem resets on every deploy). To persist
  the ELO leaderboard, use a paid plan and uncomment the `disk:` + `DATA_DIR=/var/data` blocks in
  `render.yaml` — the server writes ratings/logs under `DATA_DIR` (default = app root).

**Native Node alternative** (no Docker): Build Command `npm ci --include=dev && npm run build`
(Render sets `NODE_ENV=production`, which would otherwise skip the dev deps Vite needs), Start Command
`npm start`, Health Check Path `/healthz`.

To host the **client separately** (Netlify/Vercel) from the server, set `VITE_WS_URL=wss://your-server/ws`
at client build time. See `.env.example` for all env vars.

---

## 🎮 How to play

1. **Deploy** — click a glowing 2×2 block in your territory to plant your Command Base.
2. **Build** — each turn you gain ⚡ (Base +1, Power Plant +1). Pick a structure from the Build Yard
   and click a valid cell in your territory. Weapons can't fire the turn they're built.
3. **Scout & Bombard** — click a weapon in the Arsenal, then click a target. Radar/Sonar reveal hidden
   enemy structures; every hit reveals what you struck. Right-click cancels a tool.
4. **Win** — destroy *every* enemy Base. Lose your Research Station and all advanced tech goes dark.

---

## 🏗️ Project structure

```
shared/     framework-agnostic game engine (used by client AND server)
  types · constants · rng · map · engine · ai · protocol · selftest
server/     authoritative WebSocket server (rooms, lobby, fogged broadcasts, server-side bots)
client/     Vite + React + zustand; canvas renderer; synthesized audio; routes/HUD
docs/       DESIGN.md (design bible) · PROGRESS.md (build log)
```

The engine is deterministic and pure: `applyAction(state, playerId, action) → {state, events}` is the
single source of truth. The server runs it as the authority and sends each client a fog-filtered view;
local modes run the same engine in the browser.

---

*No two tides are the same.* ⚓
