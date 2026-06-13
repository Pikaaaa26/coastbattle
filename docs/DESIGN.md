# Coast Battle — Design & Architecture Bible

> Retro/pixel naval base-building war game on a shared archipelago.
> Battleship reimagined: build economy + military installations on island cells, scout through fog of war, and bombard the enemy HQ into the sea.

This document is the **single source of truth** for design + architecture. It exists so any
session can resume mid-build without losing context. Keep it updated. See `PROGRESS.md` for the
live build checklist.

---

## 1. Pitch

Two-to-four commanders share one procedurally generated 20×20 archipelago. Each owns an equal-sized
**territory** of habitable land. You start with a **Base (HQ)** and a trickle of **Energy ⚡**. Spend
energy to build power, research, detection, defense, and weapons. The sea hides enemy structures
(fog of war) — scout with radar, then bombard. **Destroy every enemy Base to win.**

Title: **Coast Battle** · Tagline: *Build. Bombard. Rule the tide.*

---

## 2. Modes

All modes run on the **same shared engine** (`shared/`). Online modes use the authoritative WS server.

- **vs AI (Skirmish)** — single player vs CPU commander. Runs fully client-side. (Great for instant demo + testing.)
- **Local Hotseat** — pass-and-play on one device. Client-side.
- **Online Duel (1v1)** — WS server, two territories, alternating turns.
- **Online FFA (3–4)** — one shared map, N equal territories, round-robin, last HQ standing.

Requirement satisfied: *"2-player multiplayer"* (Duel) + *"one-map, multiple-player mode, each player equal buildable cells"* (FFA with equal territories).

---

## 3. The Map

- **20×20** grid (`WIDTH=HEIGHT=20`). Flat row-major arrays, index = `y*W + x`.
- **Deterministic**: generated from a `seed` (seeded RNG). Both/all players get the **same** map.
- **4 archetypes** (chosen at random unless host picks):
  1. `twin` — Twin Continents: two large landmasses (natural 1v1 sides).
  2. `atolls` — Scattered Atolls: many small islands (spread-out building).
  3. `ring` — The Ring: land ring around a central lagoon.
  4. `bay` — Fractured Bay: a central island carved by channels.
- **Terrain types** (`TerrainType`):
  - `deep` — open sea. Not buildable. Shots that land here = **MISS / splash**.
  - `land` — habitable. Buildable (if in your territory).
  - `reef` — shallow water decoration; not buildable, blocks nothing (visual variety; counts as water for misses).
  - `mountain` — not buildable; **blocks radar line-of-sight** (tactical cover).
  - `irradiated` — created by nukes; permanently unusable (no build, structures there are gone).

### Territories (fair partition)
- Each player gets a **territory**: the set of `land` cells they may build on.
- Partition = balanced Voronoi from spawn points, then **trimmed so every territory has the same cell count** (`territory[]: number = playerIndex | -1`). Leftover land = **neutral** (no one builds; can be hit/irradiated; acts as no-man's-land).
- You may build **only** on your own territory's land cells. You may **attack anywhere**.

---

## 4. Resources

Single primary currency keeps the economy crisp:

- **Energy ⚡** — used to **construct** buildings and **fuel** super-weapons.
  - Start: **2 ⚡** (the "2 coins").
  - Base: **+1 ⚡ / turn**. Power Plant: **+1 ⚡ / turn** (max 1). (Advanced generators may add more.)
  - Basic weapons (Silo, Artillery) are **free to fire** (cooldown-limited) to keep tempo.
  - Super-weapons (Nuclear) cost ⚡ **and** have cooldown.

> Terminology note: the brief's "coins" = starting Energy; "energy"/"power" = the same ⚡ resource.

---

## 5. Buildings

Plot sizes & core effects honor the brief exactly; extras are clearly marked **[EXT]**.

### Core
| Key | Name | Plot (w×h) | Cost ⚡ | Effect |
|---|---|---|---|---|
| `base` | Base (HQ) | 2×2 | free (start, 1 only) | +1⚡/turn. **Lose all Bases → eliminated.** Armored (cell HP 2). |
| `silo` | Missile Silo | 1×1 | 3 | 1× single-cell attack / turn. |
| `artillery` | Artillery | 2×2 | 6 | 1× **2×2** area attack / **2 turns**. |
| `powerplant` | Power Plant | 3×1 | 5 | +1⚡/turn. **Max 2.** |
| `research` | Research Station | 2×1 | 5 | Unlocks advanced tree (detection/protection). **Max 1.** **If destroyed, all advanced buildings stop working.** |
| `nuclear` | Nuclear Facility | 3×2 | 15 | Launch nuke: **3×3 (9-cell)** damage, **irradiates** those cells (permanently unusable), **5-turn cooldown**, **free to fire**. |

### Advanced — require a **living** Research Station **[EXT]**
| Key | Name | Plot | Cost ⚡ | Category | Effect |
|---|---|---|---|---|---|
| `radar` | Radar Station | 2×2 | 6 | detection | Reveals enemy cells within radius 3 each of your turns (blocked by mountains). |
| `sonar` | Sonar Array | 2×1 | 5 | detection | Active ability: ping a chosen 3×3 area once per 2 turns (reveals structures there). |
| `shield` | Shield Generator | 2×2 | 8 | protection | Grants +1 temp cell-HP to friendly buildings within radius 2 (regenerates each turn). |
| `turret` | Flak Turret | 1×1 | 5 | protection | % chance to **intercept** an incoming single-cell missile within radius 2. |
| `repair` | Engineering Bay | 2×1 | 7 | protection | Repairs 1 cell-HP/turn to the most-damaged friendly building in radius 3. |
| `jammer` | Jammer | 1×1 | 4 | detection-denial | Hides friendly buildings within radius 2 from enemy radar; emits decoy blips. |

> If Research Station dies, every advanced building is flagged `disabled` and produces no effect until a new Research Station is built. (Honors the brief's "losing it means all related to it cease to work.")

### Building stats helpers
- **Cell HP**: most buildings 1 HP/cell; `base` 2; `shield`-boosted cells +1 temp. A building is destroyed when **all** its cells are destroyed; destroyed cells clear from the grid.
- **Build sickness**: weapons can't fire the turn they're built (`operationalTurn = builtTurn + 1`). Economy/detection/protection are active immediately.

---

## 6. Combat & Damage

- **Single-cell missile** (Silo): 1 dmg to the targeted cell's building (if any). Water → MISS.
- **Artillery**: 2×2 footprint anchored at target; 1 dmg to each covered cell.
- **Nuclear**: 3×3 footprint; destroys all cells (massive dmg) and converts terrain to `irradiated`.
- **Reveal on contact**: a hit marks ONLY the struck cell (hit/miss marker). It does **not** reveal the
  building's type or orientation. Structures are revealed exclusively by **detection** (Radar passive
  radius, Sonar 3×3 ping). The launcher's position is never shown to the defender (enemy fire arcs in
  from off-board).
- **Craters**: any shot that lands on land cratered it — that cell is **unbuildable for 3 full rounds**
  (`blockedUntil`). Destroyed building cells become permanent **`rubble`** terrain — nothing can ever
  be built there again.
- **Interception [EXT]**: Flak Turret may shoot down a single-cell missile (35%) if in range; after a
  successful intercept it reloads for a round. Attacker sees a mid-air detonation ("INTERCEPTED");
  only the defender sees which turret fired.
- **Shields [EXT]**: absorb one hit per covered cell (public "ABSORBED" feedback). A breach overloads
  every generator covering that cell (2-turn re-form). Coverage from multiple generators does NOT stack.
- **Elimination intel**: a dead commander's whole field loses its fog for everyone.

---

## 7. Fog of War & Intel

- Terrain is fully visible to everyone (shared map). **Enemy buildings are hidden.**
- You learn enemy cells via: **hits** (permanent reveal), **Radar** (per-turn radius reveal), **Sonar** (one-shot area), spotting destruction.
- Per-player **intel**: `revealed: Set<cellIndex>` + `knownBuildings`. The server sends each player a **fogged** state (`serializeForPlayer`). Local modes fog client-side per active player.

---

## 8. Turn Structure (sequential / WeGo-lite)

Sequential turns (clean netcode, classic battleship cadence). On your turn:
1. **Income** — gain ⚡ from Base + Power Plant + generators.
2. **Upkeep** — radars ping (reveal), repair bays heal, shields recharge, cooldowns tick down, build-sickness clears.
3. **Build** — spend ⚡ to place buildings on your territory (multiple allowed; ⚡ + space are the limits).
4. **Act** — fire ready weapons / use abilities (each weapon = 1 action when off cooldown).
5. **End turn** — pass to next living player.

Optional per-turn timer (settings). Off-turn players watch attacks animate (drama).

### Initial placement
- Turn 0: each player places their **Base** anywhere in their territory (`placeBase`). Then normal turns begin.
- (FFA: simultaneous base placement during lobby/"deploy" phase, then round-robin.)

---

## 9. Win / Loss

- A player is **eliminated** when **all their Base cells are destroyed**. Their remaining buildings go inert (neutral wreckage).
- **Last commander with a living Base wins.**
- **Turn cap** (e.g. 60) with tiebreak by total surviving building value, to prevent stalls.

---

## 10. AI (CPU Commander) — "smart battleship"

Lives in `shared/ai.ts`. Given the AI player's fogged state, returns an action list for its turn.
- **Economy curve**: Base → Power Plant → Research → Radar(s) → Silos/Artillery → escalate to Nuclear.
- **Targeting**: probability-density + Hunt/Target with **parity** (checkerboard) over **enemy territory** (AI knows where enemy *can* build → competent). On a hit, switch to **target mode**, finishing neighbors. Radar reveals bias the heatmap.
- Difficulty scales build aggression + intercept/▒ usage.

---

## 11. Visual Design (pixel / retro / "voxel-ish")

- **Renderer**: HTML5 Canvas 2D, `imageSmoothingEnabled=false`, integer scaling. Layers: cached terrain → buildings (faux-iso chunky sprites with elevation) → fog → effects → (React DOM HUD overlay).
- **Procedural pixel sprites** authored in code (no external art deps): water shimmer (palette-cycle), coastlines/dither, building sprites (silo tower, radar dish, reactor dome, etc.).
- **Effects**: missile arcs, pixel explosion bursts, radar sweep, nuke flash + screen shake, miss splashes.
- **CRT post-fx** (toggle): scanlines, vignette, subtle chromatic aberration.
- **Audio**: Web Audio API synth SFX (no asset files) — beeps, launches, explosions; optional chiptune loop. Mute toggle.
- **Type/Palette**: pixel display font ("Press Start 2P" for headers) + readable mono body; dark-navy sea, teal, amber/green CRT text, warning reds. Command-console UI.

---

## 12. Site / Portal

- **Landing** (`/`): animated Coast Battle title, tagline, PLAY NOW, feature strip, how-to, building codex teaser, footer. Arcade vibe.
- **Portal/Lobby** (`/play`): mode select (vs AI / Hotseat / Create / Join by code), commander name + color/faction, room code share, player list, map preview, ready/start.
- **Game** (`/game/:id` or state-driven): board + HUD (resources, build palette, intel log, turn indicator, actions) + endgame (victory/defeat, stats, rematch).
- **Codex** (`/codex`): buildings, economy, rules.

---

## 13. Tech Stack & Architecture

```
/ (root, single npm project — no workspace complexity)
  package.json            # all deps + scripts (concurrently runs client+server)
  tsconfig.base.json
  shared/                 # framework-agnostic game engine (imported by BOTH)
    types.ts  constants.ts  rng.ts  map.ts  engine.ts  ai.ts  index.ts
  server/                 # authoritative WS server
    index.ts  rooms.ts  protocol.ts
  client/                 # Vite + React + TS
    index.html  vite.config.ts
    src/  (routes, canvas renderer, hud, audio, store)
  docs/                   # DESIGN.md (this), PROGRESS.md
```

- **Shared engine**: pure TS, deterministic, no DOM/node deps. `applyAction(state, playerId, action) → {state, events}` is authoritative validation+mutation. Used by server (truth) + client (vs-AI/hotseat + optimistic UI).
- **Server**: Node `http` + `ws` (+ `express` to serve the built client → **single deployable**). Holds rooms in memory (`Map<code, Room>`), validates via engine, broadcasts per-player fogged state + events. Reconnect via player token. `nanoid` for ids/codes.
- **Client**: React + react-router + **zustand** store. Canvas renderer. Web Audio synth. Vite dev proxies WS to node; prod = node serves static + WS on one port. `VITE_WS_URL` env to point online modes at the server.
- **No DB** for MVP (in-memory rooms). Deploy: one Node service (Render/Railway/Fly) serves client + WS. Client can also deploy static-only with `VITE_WS_URL` → remote server.

### Protocol (client ↔ server), JSON over WS
- C→S: `create` (mode, name, color, settings), `join` (code, name, color), `ready`, `action` (engine Action), `chat`, `rematch`, `leave`.
- S→C: `lobby` (room state), `state` (fogged GameState), `events` (animation events), `error`, `assigned` (playerId/token), `ended`.

---

## 14. Balance constants (initial; tune later) — see `shared/constants.ts`
- Start energy 2; Base +1; PowerPlant +1; cell HP base 2 / others 1.
- Costs: silo 3, artillery 6, powerplant 5, research 5, nuclear 15, radar 6, sonar 5, shield 8, turret 5, repair 7, jammer 4.
- Cooldowns: silo 1 (per turn), artillery 2, nuclear 5, sonar 2. Nuke is **free to fire**.
- Max counts: powerplant **2**, research 1, base 1. Sonar/Nuke footprint **3×3**.
- Radar radius 3, shield radius 2, turret radius 2/intercept 50%, repair radius 3.
- Turn cap 60. Map 20×20. **MIN_TERRITORY = 40** equalized buildable cells/player; land coverage tuned
  so 2–4 players all get ≥40.

---

## 15. Open creative extensions (nice-to-have, post-core)
- Weather/tide events that shift water; faction passives; spectator mode; replays; emotes; leaderboard.
