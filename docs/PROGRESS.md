# Coast Battle — Build Progress

Live checklist. Update statuses as work proceeds so any session can resume.
Legend: ✅ done · 🔄 in progress · ⬜ todo · ⚠️ needs attention

## How to resume
1. Read `docs/DESIGN.md` (full design + architecture) and this file.
2. Find the first 🔄 / ⬜ item below; continue there.
3. Run `npm install` then `npm run dev` (client on Vite, server on :8787).

## Phases

### P0 — Foundation
- ✅ Env check (node 24, npm 11), empty dir
- ✅ DESIGN.md (design bible)
- ✅ PROGRESS.md (this)
- ✅ Root package.json, tsconfig, .gitignore
- ✅ Folder scaffold (shared/server/client) + vite config + index.html
- ✅ npm install (189 pkgs)

### P1 — Shared engine (the heart) — ✅ ALL SELF-TESTS PASS
- ✅ types.ts
- ✅ constants.ts (balance + building defs)
- ✅ rng.ts (seeded)
- ✅ map.ts (4 archetypes + equal territory partition; verified equal for 2/3/4 players)
- ✅ engine.ts (createGame, applyAction, income/upkeep, combat, fog, win)
- ✅ ai.ts (smart battleship CPU — parity targeting + econ build order)
- ✅ index.ts (barrel) + selftest.ts (`npm run engine:test` → ALL PASS, AI=0 invalid actions, deterministic, no fog leak)

### Build order note (2026-06-03)
Building CLIENT local-playable loop (vs AI / hotseat) FIRST to validate renderer+HUD+engine
integration, THEN the server, THEN wire online (UI is shared; only transport differs).

### P2 — Server — ✅ (typechecks; runtime verify pending)
- ✅ shared/protocol.ts (message types: C2S/S2C/LobbyView)
- ✅ server/rooms.ts (Room + Hub: lobby, fogged broadcasts, server-side bots, disconnect→bot, rejoin)
- ✅ server/index.ts (http+express static+SPA fallback, ws on /ws, routing, sweep)

### P3 — Client core — ✅ (typechecks; runtime verify pending)
- ✅ Vite + React + router + zustand scaffold (main/App)
- ✅ Canvas renderer (terrain cache+territory+fog+buildings+markers+particles/projectiles/rings, shake, pointer map)
- ✅ Audio synth (sfx.ts — SFX + music + mute)
- ✅ sprites.ts (procedural terrain + 12 building sprites)
- ✅ session.ts (LocalSession: vs-AI/hotseat, AI pacing, pass handoff) + net/online.ts (OnlineConnection)
- ✅ stores (settings persisted, game store with tool/click logic)

### P4 — Client UI / screens — ✅ (typechecks; runtime verify pending)
- ✅ Landing page (HeroCanvas attract-mode, features, how-to)
- ✅ Portal/Lobby (mode select ai/hotseat/online, create/join, color/name, map select, war-room lobby)
- ✅ Game HUD (energy/income, build palette w/ icons, arsenal, battle log, turn/phase)
- ✅ Placement + build + targeting interactions (renderer overlays)
- ✅ Endgame screen (victory/defeat, stats, rematch) + Pass screen + Help + Turn banner + Error toast
- ✅ Codex page

### P5 — Verification & ship — ✅ VERIFIED IN BROWSER
- ✅ Fixed: vite needs `--config client/vite.config.ts` (scripts updated); preview injects PORT so run
  ws server separately from the preview-managed client.
- ✅ Landing renders (animated hero, CRT). Portal renders (mode select). Codex renders.
- ✅ vs-AI full game verified: deploy → AI auto-deploy → build (silo, build-sickness) → fire (splash
  marker, cooldown, stats) → turn cycle → AI bombards → base destroyed → elimination → DEFEAT screen.
- ✅ Online verified end-to-end: WS connect via proxy, create room (code), add bot, ready, launch,
  server-side bot deploy + full turns, fogged state sync, turn round-trip. (duel w/ server bot)
- ✅ Territory tint contrast boosted (own teal / enemy red + bright boundary) — reads clearly.
- ✅ `npm run build` succeeds (dist/ 256KB js / 83KB gz). `npm run typecheck` clean. No console errors.
- ✅ README.md (run + deploy + how-to-play + structure).

### Verified working modes
- Skirmish vs AI ✅ (browser) · Online duel + server bot ✅ (browser) · engine selftest ✅ (2/3/4p).
- Hotseat & Online FFA share the same verified code paths (LocalSession pass-screen / Room round-robin).

### P6 — Player feedback round 1 (2026-06-03) — ✅ DONE
- ✅ **Fog leak fixed**: enemy shots no longer reveal the launcher. Renderer makes enemy fire rain in
  from off-board (`launchOrigin`); server `eventsFor` strips `from` for non-attackers AND now hides
  enemy `build` events entirely. Verified: enemy barrage lands with no origin trail.
- ✅ **Bigger/roomier maps**: MIN_TERRITORY 16→30, land coverage boosted across all archetypes. New
  equalized sizes: 2p ~78–96, 3p ~41–55, 4p ~30–44 cells — large buildings (3×2 nuke) have many spots.
- ✅ **Real terrain art**: grass interiors + sandy beaches at shorelines + snow-capped shaded mountains
  + irradiated toxic ground. Rewrote `paintLandTile`.
- ✅ **Animated water**: new `paintSeaTile` (per-frame, not cached) — moving wave bands, sparkles,
  pulsing coastal foam, depth shading. Renderer now draws live sea under a land-only cached layer.
- ✅ **Detailed animated buildings**: all 12 redrawn with shading/windows + idle animation (base flag
  waves, power/nuclear smoke, radar dish rotates, sonar/jammer pulse, nuclear warning light blinks,
  turret sway, repair crane bob, heavy-damage flames).
- ✅ Verified in browser (codex sprites, twin-map terrain w/ beaches+mountains, fog-safe enemy barrage),
  typecheck clean, engine selftest pass, production build clean.

### P7 — Player feedback round 2 (2026-06-03) — ✅ DONE
- ✅ **Hits no longer reveal the building** (type/orientation stay hidden) — only the struck cell is
  marked. Removed `addRevealed` from `damageCell` + the silo-intercept branch; structures are now
  revealed ONLY by detection (radar / sonar). Server hides the `destroyed` event from non-owners (it
  listed the full footprint). Verified: hit the AI's real base, building stayed invisible in my view.
- ✅ **Sonar nerfed 5×5 → 3×3** (constants attackW/H=3; AI scan size 3; renderer ring smaller).
- ✅ **Nuclear is free to fire** (removed `fireCost`; cooldown 5 only).
- ✅ **Power Plant max 1 → 2** (AI build order updated to use a 2nd plant).
- ✅ **≥40 buildable cells/player**: MIN_TERRITORY 30→40 + land coverage boosted. New sizes:
  2p ~83–125, 3p ~54–65, 4p ~47–63 — all comfortably ≥40 (verified via selftest).
- ✅ AI keeps hunt/target intelligence via `AiMemory.hits/destroyed` learned from its own shot events
  (legit intel, no fog cheat). Games now run longer (22–43 turns), less instant-find.
- ✅ Verified in browser; engine selftest, typecheck, production build all clean.

### P8 — Feedback round 3 (2026-06-03)
**Phase A (engine/gameplay) — ✅ DONE & verified (selftest+typecheck):**
- ✅ Base: +2⚡ income; buildable (cost 6, max 1); deploy still free. Win rework: losing base no longer
  instant-death — you can rebuild; eliminated only when `canRebuildBase` is false (no free territory, or
  can't afford & no income). AI rebuilds base as top priority.
- ✅ Napalm Battery: new weapon, 2×1 plot, 7⚡, hits 3 cells in a row, rotatable, CD 2.
- ✅ Engineering Bay nerfed to heal every 3 turns (cooldown 3).
- ✅ Building ROTATION in engine: `rotDims`/`canRotate`; `build`+`fire` actions take `rot?:0|1`.
- ✅ Plot size 60–80: MIN_TERRITORY 60 + MAX_TERRITORY 80 cap; per-count floors (2p 60, 3p 52, 4p 44).
  Verified: 2p=80, 3p 54–65, 4p 47–63.
- ✅ Shield breach event (owner-scoped) emitted on absorb.

**Phase B — REPLACED by THREE.JS low-poly diorama (user showed reference art) — ✅ DONE & verified:**
- ✅ `three` + `@types/three` installed. Old canvas `sprites.ts` DELETED.
- ✅ `client/src/game/three/lowpoly.ts` — model library: flat-shaded primitives, terrain slabs
  (grass top/dirt sides, water boxes w/ bob, snow mountains, toxic crystals), tree/rock decorations,
  PER-TILE building modules for all 13 types (each footprint cell = distinct sub-model), and
  `buildRuin` — a destroyed counterpart per tile (charred pad, rubble, broken wall, rebar, smoke).
- ✅ `renderer.ts` rewritten on three.js: ortho iso camera, sun+shadows (PCFSoft), depth-correct 3D,
  raycaster picking (`cellAt`), territory tint+emissive borders, fog caps, hit-scorch/miss-ring decals,
  ghost building (green/red translucent w/ rotation), valid-cell highlights, selected-weapon ring,
  shield ZONE dome+ring (own gens) + per-cell shield bubbles + breach burst, weapon-ready beacons,
  projectiles/bursts/rings/point-light flashes/nuke smoke column/napalm lingering flames, ambient
  chimney+ruin smoke, water bob, camera shake. Enemy fire still rains from the sky (no origin leak).
- ✅ Camera: fits to ISLAND bbox (not whole sea), `adjustZoom` (mouse wheel ×0.7–3) and ground-locked
  `pan` (middle/right-drag; right-click-no-drag still cancels tool) wired in GameScreen.
- ✅ `three/icons.ts` — offscreen WebGL snapshot factory; BuildingIcon now real 3D thumbnails.
- ✅ HeroCanvas — three.js attract diorama (islands, buildings, arcing missiles, sparks).
- ✅ Verified in browser: diorama board, 3D buildings (base w/ waving flag + red-roof barracks),
  per-tile RUIN with smoke on damaged base (dev-surgery render test), rotation ghost+valid-cell
  recompute (49→41), zoom/pan APIs. No console errors. tsc clean, vite build clean (218KB gz → now
  ~780KB raw incl three), engine selftest ALL PASS.

### P9 — Feedback round 4 (2026-06-03) — ✅ DONE (verified in browser; selftest+tsc+build green)
- ✅ **Border fix**: territory boundary strips had swapped rotations (zigzag mess) — now clean
  continuous lines; each commander's territory tinted/bordered in THEIR color (grey when dead).
- ✅ **Ownership clarity**: floating commander BANNERS over each territory centroid (name in player
  color, "(YOU)" suffix, "✝" + grey when eliminated). Keyed into terrain rebuild.
- ✅ **Dead commanders lose fog**: engine `serializeForPlayer` exposes eliminated players' buildings;
  renderer fog caps skip their territory (no wasted ammo on the dead).
- ✅ **Craters + new build rules**: every shot landing on land marks `blockedUntil = turn + 3·players`
  (engine `markImpact`; unbuildable while fresh — `canPlaceAt`). Destroyed building cells convert
  terrain to permanent `'rubble'` (new TerrainType; never buildable again). 3D crater models (rim
  debris + scorched bowl) on land impacts; ripple rings on water; rubble terrain = charred wreck slab.
- ✅ **Nuke clears trees**: decorations skip irradiated/rubble/cratered cells; deco rebuild keyed on
  terrain+blockedUntil so trees vanish even when no building was hit.
- ✅ **Distinct ordnance models**: missile (white+red finned rocket w/ exhaust), artillery shell (dark
  ball), napalm (tumbling orange barrel w/ flame), nuke (big finned warhead w/ blinking lamp), flak
  tracers — all nose-oriented along flight with per-kind trails (smoke/embers).
- ✅ **Intercept/absorb feedback**: flak kill = mid-air detonation at 62% flight + "INTERCEPTED" text;
  defender additionally sees tracer fire from their turret (turret cell stripped from attacker's event
  server-side). Shield absorb = public `absorbed` event → blue flash + "ABSORBED" (attacker) /
  "SHIELD BREACHED" (owner). Old owner-only 'shield' event removed.
- ✅ **Defense nerfs**: Flak 50%→35% intercept + reloads 1 round after a kill. Shield gens: coverage
  never stacks (max 1), breach overloads ALL gens in range (cooldown 2 — no shield until re-formed).
- ✅ Server fix: napalm event now strips launcher origin like missile/artillery/nuke.

### P10 — Feedback round 5 (2026-06-03) — ✅ DONE (all verified in browser)
- ✅ **Craters expire**: renderer no longer keeps a permanent marker map; craters render purely from
  `blockedUntil > turn`, so they vanish exactly when the cell becomes buildable. (Rubble/irradiated
  keep their permanent terrain look.) Verified 1→0 on expiry.
- ✅ **Impact-synced destruction**: renderer defers `setView` while ordnance is in flight
  (`lockUntil`/`pendingView`, ingest computes batch flight time; server now sends events BEFORE state).
  Ruins/craters/rubble appear when the shell lands, not when the action resolves. Verified mid-flight.
- ✅ **Eliminated → Spectate or Exit**: engine `serializeForPlayer` gives dead viewers FULL vision
  (fog off, all buildings; selftest updated + new spectator check). New "COMMAND BASE LOST" overlay
  with ⏿ Spectate / Exit to Menu. Verified overlay + 0→2 enemy buildings on death.
- ✅ **Banners removed** — territory tint/border (per-player colors) is the ownership signal.
- ✅ **AI no longer shells the dead**: cellValue zeroes any cell in an eliminated commander's
  territory and ignores their known structures.

### P11 — Feedback round 6 (2026-06-03) — ✅ DONE
- ✅ **AI no longer fires at worthless ground** (root cause of "shooting outside territory"): neutral
  land value 1→0, and chooseTarget requires base target value > 0 BEFORE aim-noise is added (noise
  could previously exceed 0 on its own, esp. easy/normal where noise scales up to ~45).
- ✅ **Commanders' fleets die with them**: `eliminate()` destroys every building they own (cells → 0hp
  destroyed, land → permanent rubble, cellDestroyed events) — "their fleet burns!".
- ✅ **Maps 30×30** (MAP_W/H 30, TURN_CAP 60→80, all hardcoded turnCaps now use the constant).
  Territory cap unchanged (60–80) — all archetypes now hit the full 80 with lots of sea/neutral
  between, so layouts finally look distinct. Archetype tuning: twin = wide strait, atolls = scatter,
  ring = crisp lagoon, bay = carved continent. Camera dist 30→46 + sun shadow box ±16→±24 for the
  bigger board. Arsenal coords now numeric (letters broke past col 26).
- ✅ **Pan fixed + camera rotation**: vertical pan was inverted — now true "grab the world" semantics;
  pan vectors are azimuth-relative. NEW: Q/E rotates the camera in smooth 90° steps
  (`rotateCamera`, az/azTarget lerp). resetCamera restores 45°.
- ✅ **Space rotates the building/aim** (alongside R; preventDefault stops page scroll). Help updated.
- ✅ Verified in browser: 30×30 twin map (terr=80), pan direction flag, space-rotate flag, 90° camera
  swing screenshot. tsc + selftest + build green.

### P12 — Feedback round 7 (2026-06-03) — ✅ DONE
- ✅ **Cooldown shown on the board**: weapons & sonar get a floating badge — amber NUMBER = turns of
  reload left, "…" = still powering up, green spinning pip = ready. (buildKey now includes
  cooldownLeft/operationalTurn/turn so badges stay fresh.)
- ✅ **Twin Continents guaranteed two landmasses**: a strait is carved along the perpendicular midline
  (gaussian sea-trench between the blob axis) — can't merge anymore.
- ✅ **MIRRORED MAPS (fairness)**: terrain heightfield is symmetrized (180° point symmetry for 2P,
  90° rotational for 3–4P) and territory is assigned PER ORBIT — every orbit contributes exactly one
  cell to each region, so all player territories are EXACTLY equal and congruent (3P runs on 4-fold
  symmetry with the 4th congruent region neutral). Mountains via symmetric quantile threshold; reefs
  via canonical-orbit hash. New selftest: symmetry x2/x3/x4 → 0 mismatches. map.ts partition rewritten
  (`partitionSymmetric`, old Voronoi+trim removed).
- ✅ **Shield protects exact tiles**: engine was already per-tile; the misleading circular dome visual
  is replaced by tinting the EXACT covered tiles (Chebyshev square per generator cell). The zone
  disappears while a breached generator re-forms (cooldown).
- ✅ **Sonar instant-use bug**: sonar now has build-sickness (operationalTurn+1), engine rejects early
  pings ("still calibrating"), AI filter updated; arsenal shows CHARGING.

### P13 — Render deploy prep + full audit (2026-06-13) — ✅ DEPLOY-READY
Ran a 21-agent workflow audit (assess engine/AI-ML/render-mobile/server-online + Render readiness +
adversarial blocker verification). Result: ONE true deploy blocker, fixed; online reliability hardened.
- ✅ **Dockerfile blocker FIXED** (the only confirmed blocker): old file set NODE_ENV=production before
  `npm ci` → omitted vite/tsx/typescript → build+runtime both failed. Now multi-stage: build stage
  `npm ci` (all deps) → build dist/; runtime stage `npm ci --omit=dev`. Moved `tsx` to dependencies
  (runtime needs it) + re-synced package-lock (tsx now dev:false in lock).
- ✅ **WS keepalive** (server/index.ts): 30s ping/pong heartbeat, reaps dead sockets — survives Render's
  idle-socket proxy drop.
- ✅ **Client auto-reconnect** (net/online.ts): mid-game socket close → backoff reconnect + sends the
  already-server-supported `{t:'rejoin',code,token}` to rehydrate the match (was dead code before).
- ✅ **Security/hardening**: express.json limit 128kb; battle-log `battleId` sanitized (was a path-
  traversal write primitive). `DATA_DIR` env for ratings.json + battle_logs (mkdir -p) so a Render disk
  can persist the leaderboard; defaults to ephemeral app-root.
- ✅ **render.yaml** (Docker web service, healthCheckPath /healthz, free plan, optional disk+DATA_DIR
  commented), **.env.example**, .gitignore += battle_logs/ + ratings.json, README Render section.
- ✅ **Mobile**: `touch-action:none` on board canvas (stops pull-to-refresh fighting drag).
- ✅ VERIFIED: tsc clean, build clean, engine:test pass, AND prod smoke-test (PORT=9099 DATA_DIR=... 
  NODE_ENV=production `tsx server/index.ts`): /healthz ok, serves built index.html, /api/leaderboard ok,
  **/ws → 101 Switching Protocols**, honors injected PORT + DATA_DIR.

### Known NON-blocking items the audit surfaced (deferred — not deploy gates)
- Balance/fairness (engine): shield doesn't recharge between enemies in FFA (one-hit-per-round, not
  per-attacker); crater `blockedUntil` keyed to total not ALIVE players; turn-order first-mover bias is
  uncompensated (seed fully determines initiative); turnCap +1 off-by-one.
- Online polish: a "Reconnecting…" UI banner (reconnect logic works but is silent via error toast);
  optional server grace-window before converting a dropped human to a bot.
- Mobile UX (in progress by user): pinch-to-zoom (two-finger) + on-screen camera zoom/rotate buttons
  (renderer.adjustZoom/rotateCamera/resetCamera already exist; wire them to touch + buttons).
- Persistence: ratings/battle_logs reset on free-tier redeploy (use paid plan + disk + DATA_DIR).

### P14 — Mobile controls + nuclear-threat AI + ML run (2026-06-13)
**Mobile controls (GameScreen.tsx + renderer + game.css):**
- ✅ Fixed mobile place/fire: confirm moved OFF the sidebar into floating ✓/✕ buttons pinned over the
  building ghost (renderer.cellToScreen projects the cell each frame; ✓ commits the STORED hover cell).
- ✅ Multi-touch: 1 finger = aim (set hover), 2 fingers = pan + pinch-zoom, 3 fingers = rotate
  (renderer.rotateCameraBy). `touch-action:none` already on the canvas. Help text updated.

**Nuclear-threat system:**
- ✅ Engine: building a Nuclear Facility now emits a PUBLIC battle-log alert (kind 'threat', pulsing red
  CSS) — "☢ ALERT: <name> is constructing a NUCLEAR FACILITY!". Log isn't fog-filtered, so all players
  + every AI (runs on full state) see WHO is building one (not where).
- ✅ AI reaction (shared/ai.ts): `nukeThreatSet` reads the log alert; under threat the AI (a) focuses
  fire on the builder's whole field (`nukeThreatFocus`), (b) max-priorities a DETECTED enemy nuclear
  facility / research station (`knownNukeVal`/`knownResearchVal`, split out of knownEcoVal), (c) banks
  energy = baseCost+`nukeReserveBonus` so it can instantly rebuild after being nuked, (d) craters the
  builder's open 3×2/2×3 sites (`computeDenyMap` + `nukeDenyVal`) to deny nuke (re)build spots. 5 new
  tunable weights; threat-free play is byte-identical to before (ctx only applied when threats exist).
  `OPTIMIZED_WEIGHTS` now merges over DEFAULT so a partial weights file can't NaN.
- ✅ ML: optimizer (scripts/optimize_ai.ts) now seeds the population from the CURRENT trained weights
  (not DEFAULT), co-evolves the new params (mutate/crossover ranges added), rewards base-rebuild
  resilience (+150 for losing-then-rebuilding a base), GEN/POP via env. **Running GEN=100 in the
  background → optimize.log; checkpoints best to shared/optimized_weights.json each improving gen.**
  Stop anytime with the process; latest checkpoint is always the saved best.
- ✅ Verified: tsc clean, engine selftest 0 invalid AI actions, build clean, optimizer smoke + live run
  (Gen3 fitness 2747, win-rate vs seed 50→67%).
- NOTE: P14 changes are UNCOMMITTED (last push = deploy prep). Commit after the ML run settles (it keeps
  rewriting optimized_weights.json).

### Possible future polish (not blocking review)
- Catch-screenshot of artillery/nuke explosion + radar reveal (effect funcs confirmed via splash + a
  full completed game). Chat UI in online. Spectator. Replays. Difficulty tuning.

### P5 — Polish & ship
- ⬜ CRT post-fx, animations, screen shake, particles
- ⬜ vs-AI difficulty, FFA round-robin
- ⬜ Responsive layout, keyboard shortcuts
- ⬜ README (run + deploy), env config
- ⬜ Run dev, smoke-test (preview/screenshot), fix issues

## Notes / decisions log
- 2026-06-03: Single-npm-project layout (no workspaces) to avoid Vite/TS import friction. Shared TS imported by client (Vite alias `@shared`) + server (tsx). Single deployable (express serves built client + ws).
- Single resource ⚡ (coins=start energy). Sequential turns. Eliminate-all-bases win.
