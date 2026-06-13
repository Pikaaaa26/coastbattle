// Engine self-test: validates map generation + simulates full AI-vs-AI games.
// Run with: npm run engine:test
import { generateMap, ARCHETYPES, ARCHETYPE_NAMES } from './map';
import { createGame } from './engine';
import { applyAction, serializeForPlayer, makeBuilding } from './engine';
import { decideDeploy, decideTurn, newAiMemory } from './ai';
import type { GameSettings, GameState, MapArchetype } from './types';
import { TURN_CAP } from './constants';

let failures = 0;
function check(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error('  ✗ FAIL:', msg);
  } else {
    console.log('  ✓', msg);
  }
}

function countTerrain(map: ReturnType<typeof generateMap>) {
  const c: Record<string, number> = {};
  for (const t of map.terrain) c[t] = (c[t] || 0) + 1;
  return c;
}

function landComponents(map: ReturnType<typeof generateMap>) {
  const landLike = (t: string) => t === 'land' || t === 'mountain';
  const seen = new Set<number>();
  const sizes: number[] = [];
  for (let i = 0; i < map.width * map.height; i++) {
    if (seen.has(i) || !landLike(map.terrain[i])) continue;
    const q = [i];
    seen.add(i);
    let size = 0;
    while (q.length) {
      const j = q.pop() as number;
      size++;
      const x = j % map.width;
      const y = Math.floor(j / map.width);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        const ni = ny * map.width + nx;
        if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
        if (seen.has(ni) || !landLike(map.terrain[ni])) continue;
        seen.add(ni);
        q.push(ni);
      }
    }
    sizes.push(size);
  }
  return sizes.sort((a, b) => b - a);
}

function waterTiles(map: ReturnType<typeof generateMap>, x0: number, x1: number, y0: number, y1: number) {
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = map.terrain[y * map.width + x];
      if (t === 'deep' || t === 'reef') total++;
    }
  }
  return total;
}

function normalizedTerritoryShape(map: ReturnType<typeof generateMap>, player: number) {
  const cells: Array<[number, number]> = [];
  for (let i = 0; i < map.territory.length; i++) {
    if (map.territory[i] === player) cells.push([i % map.width, Math.floor(i / map.width)]);
  }
  const minX = Math.min(...cells.map(([x]) => x));
  const minY = Math.min(...cells.map(([, y]) => y));
  return cells.map(([x, y]) => `${x - minX},${y - minY}`).sort().join('|');
}

function territoriesIdentical(map: ReturnType<typeof generateMap>) {
  const shapes = Array.from({ length: map.numPlayers }, (_, p) => normalizedTerritoryShape(map, p));
  return shapes.every((shape) => shape === shapes[0]);
}

console.log('=== MAP GENERATION ===');
for (const arch of ARCHETYPES) {
  for (const np of [2, 3, 4]) {
    const map = generateMap(12345, arch, np);
    const terr = countTerrain(map);
    const comps = landComponents(map);
    const territoryCounts = new Array(np).fill(0);
    for (const o of map.territory) if (o >= 0) territoryCounts[o]++;
    const equal = territoryCounts.every((v) => v === map.territorySize);
    check(
      map.territorySize >= 6 && equal,
      `${ARCHETYPE_NAMES[arch]} x${np}: land=${terr.land} mtn=${terr.mountain || 0} reef=${terr.reef || 0} components=${comps.length} territory/player=${map.territorySize} (${territoryCounts.join('/')})`,
    );
  }
}

console.log('\n=== TERRITORY IDENTITY (buildable areas) ===');
for (const arch of ARCHETYPES) {
  for (const np of [2, 3, 4]) {
    const map = generateMap(777, arch, np);
    check(territoriesIdentical(map), `${ARCHETYPE_NAMES[arch]} x${np}: every player has the same buildable mask (${map.territorySize} cells)`);
  }
}

console.log('\n=== ARCHETYPE SHAPES ===');
for (const np of [2, 3, 4]) {
  let comps = landComponents(generateMap(12345, 'twin', np));
  check(comps.length === 2, `Twin Continents x${np}: two primary landmasses (${comps.join('/')})`);

  comps = landComponents(generateMap(12345, 'atolls', np));
  check(comps.length >= 1 && comps[0] <= 450, `Scattered Atolls x${np}: many separated atolls (${comps.slice(0, 8).join('/')})`);

  const ring = generateMap(12345, 'ring', np);
  comps = landComponents(ring);
  check(comps.length === 1 && waterTiles(ring, 11, 18, 11, 18) >= 40, `The Ring x${np}: one ring with a wet center (${comps.join('/')})`);

  const bay = generateMap(12345, 'bay', np);
  check(waterTiles(bay, 8, 22, 10, 26) >= 100, `Fractured Bay x${np}: wide central bay stays open (${waterTiles(bay, 8, 22, 10, 26)} water tiles)`);

  comps = landComponents(generateMap(12345, 'archipelago', np));
  check(comps.length >= 4 && comps[0] <= 180, `Archipelago x${np}: many islands without one dominant slab (${comps.slice(0, 8).join('/')})`);
}

// determinism: same seed/arch/players -> identical map
{
  const a = generateMap(999, 'twin', 2);
  const b = generateMap(999, 'twin', 2);
  check(JSON.stringify(a) === JSON.stringify(b), 'map generation is deterministic for same seed');
  const c = generateMap(1000, 'twin', 2);
  check(JSON.stringify(a) !== JSON.stringify(c), 'different seed -> different map');
}

function simulate(seed: number, arch: MapArchetype, np: number, verbose = false): GameState {
  const settings: GameSettings = {
    numPlayers: np,
    mode: np === 2 ? 'duel' : 'ffa',
    turnCap: TURN_CAP,
    fogOfWar: true,
    mapArchetype: arch,
    difficulty: 'hard',
  };
  const seeds = Array.from({ length: np }, (_, i) => ({
    id: `p${i}`,
    name: `CPU-${i}`,
    isAI: true,
  }));
  let state = createGame(settings, seed, seeds);

  // deploy
  let dguard = 0;
  while (state.phase === 'deploy' && dguard++ < 50) {
    const ai = state.currentPlayer;
    const a = decideDeploy(state, ai);
    if (!a) throw new Error('AI could not deploy base');
    const r = applyAction(state, state.players[ai].id, a);
    if (!r.ok) throw new Error('deploy failed: ' + r.error);
    state = r.state;
  }
  check(state.phase === 'playing', `sim seed=${seed} ${arch} x${np}: entered play phase`);

  const mem = seeds.map(() => newAiMemory());
  let safety = 0;
  let actionErrors = 0;
  let shieldLeak = false;
  while (state.phase === 'playing' && safety++ < 5000) {
    const ai = state.currentPlayer;
    const plan = decideTurn(state, ai, mem[ai]);
    for (const act of plan) {
      const r = applyAction(state, state.players[ai].id, act);
      if (!r.ok) actionErrors++;
      else state = r.state;
      if (state.phase === 'ended') break;
    }
    // invariant: a cell may only hold a shield while its owner has a live, ENABLED shield generator.
    // Destroying the Research Station disables the gens, so their coverage must drop the same turn.
    for (const p of state.players) {
      const hasReadyGen = state.buildings.some(
        (b) => b.owner === p.index && b.type === 'shield' && !b.destroyed && !b.disabled && state.turn >= b.operationalTurn,
      );
      if (
        !hasReadyGen &&
        state.buildings.some((b) => b.owner === p.index && !b.destroyed && b.cells.some((c) => !c.destroyed && c.shield > 0))
      ) {
        shieldLeak = true;
      }
    }
  }
  check(!shieldLeak, `sim seed=${seed} ${arch} x${np}: shields never linger without a live shield generator`);
  if (verbose) {
    console.log(`    ended at turn ${state.turn}, winner=${state.winner != null ? state.players[state.winner].name : 'draw'}, actionErrors=${actionErrors}`);
    console.log(`    buildings: ${state.buildings.filter((b) => !b.destroyed).length} alive / ${state.buildings.length} total`);
  }
  check(actionErrors === 0, `sim seed=${seed} ${arch} x${np}: AI produced only valid actions (${actionErrors} errors)`);
  check(state.phase === 'ended', `sim seed=${seed} ${arch} x${np}: game reached an end state (turn ${state.turn}, winner ${state.winner})`);
  return state;
}

console.log('\n=== GAME SIMULATION (AI vs AI) ===');
simulate(1, 'twin', 2, true);
simulate(2, 'atolls', 2, true);
simulate(3, 'ring', 2, true);
simulate(4, 'bay', 2, true);
simulate(7, 'twin', 3, true);
simulate(8, 'atolls', 4, true);

console.log('\n=== DETERMINISM (full game) ===');
{
  const a = simulate(42, 'twin', 2);
  const b = simulate(42, 'twin', 2);
  check(
    a.winner === b.winner && a.turn === b.turn && a.buildings.length === b.buildings.length,
    `same seed -> same outcome (winner ${a.winner}/${b.winner}, turns ${a.turn}/${b.turn})`,
  );
}

console.log('\n=== FOG OF WAR ===');
{
  const state = simulate(5, 'twin', 2);
  // check from a LIVING player's perspective (dead viewers are spectators with full vision by design)
  const aliveViewer = state.players.find((p) => p.alive)?.index ?? 0;
  const view = serializeForPlayer(state, aliveViewer);
  let leak = 0;
  for (const b of view.buildings) {
    if (b.owner !== aliveViewer) {
      // buildings of eliminated commanders are public by design
      if (!state.players[b.owner].alive) continue;
      const revealed = state.players[aliveViewer].revealed;
      const seen = b.cells.some((c) => revealed.includes(c.y * state.map.width + c.x));
      if (!seen) leak++;
    }
  }
  check(leak === 0, `fog: living viewer sees no un-scouted living-enemy buildings (${leak} leaks)`);
  const enemyAlive = state.players.find((p) => p.index !== aliveViewer && p.alive);
  if (enemyAlive) check(view.players[enemyAlive.index].energy === 0, 'fog: living enemy energy is hidden');
  // dead viewer = spectator: sees everything
  const deadViewer = state.players.find((p) => !p.alive)?.index;
  if (deadViewer !== undefined) {
    const spec = serializeForPlayer(state, deadViewer);
    check(
      spec.buildings.length === state.buildings.length && spec.settings.fogOfWar === false,
      'spectator: eliminated viewer sees all buildings (fog off)',
    );
  }
}

console.log('\n=== RESEARCH LOSS → ADVANCED OFFLINE + SHIELDS DROP ===');
{
  const settings: GameSettings = {
    numPlayers: 2,
    mode: 'ffa',
    turnCap: TURN_CAP,
    fogOfWar: false,
    mapArchetype: 'twin',
    difficulty: 'hard',
  };
  const state = createGame(settings, 123, [
    { id: 'p0', name: 'Defender', isAI: true },
    { id: 'p1', name: 'Attacker', isAI: true },
  ]);
  const W = state.map.width;
  const t = state.map.territory;
  // a 2x2 block fully inside player 0's territory → legal artillery target + research footprint
  let rx = -1;
  let ry = -1;
  for (let y = 0; y < state.map.height - 1 && rx < 0; y++) {
    for (let x = 0; x < W - 1; x++) {
      const i = y * W + x;
      if (t[i] === 0 && t[i + 1] === 0 && t[i + W] === 0 && t[i + W + 1] === 0) {
        rx = x;
        ry = y;
        break;
      }
    }
  }
  const p0far: { x: number; y: number }[] = [];
  const p1cells: { x: number; y: number }[] = [];
  for (let i = 0; i < t.length; i++) {
    const x = i % W;
    const y = Math.floor(i / W);
    if (t[i] === 0 && Math.abs(x - rx) + Math.abs(y - ry) > 3) p0far.push({ x, y }); // clear of the blast
    if (t[i] === 1) p1cells.push({ x, y });
  }
  check(rx >= 0 && p0far.length >= 3 && p1cells.length >= 2, 'research-test: scenario cells available');

  if (rx >= 0 && p0far.length >= 3 && p1cells.length >= 2) {
    state.phase = 'playing';
    state.turn = 5;
    state.round = 2;
    state.currentPlayer = 1;
    state.players[1].energy = 99;

    const research = makeBuilding('research', 0, rx, ry, 0);
    for (const c of research.cells) {
      c.hp = 1;
      c.maxHp = 1; // a single artillery volley flattens it
    }
    research.disabled = false;
    const gen = makeBuilding('shield', 0, p0far[0].x, p0far[0].y, 0);
    gen.disabled = false; // online while research stands
    const guarded = makeBuilding('silo', 0, p0far[1].x, p0far[1].y, 0);
    for (const c of guarded.cells) c.shield = 1; // shields currently up
    const base0 = makeBuilding('base', 0, p0far[2].x, p0far[2].y, 0);
    const base1 = makeBuilding('base', 1, p1cells[0].x, p1cells[0].y, 0);
    const arty = makeBuilding('artillery', 1, p1cells[1].x, p1cells[1].y, 0);
    arty.operationalTurn = 0;
    state.buildings.push(research, gen, guarded, base0, base1, arty);

    check(
      guarded.cells.every((c) => c.shield === 1) && !gen.disabled,
      'research-test: shields up + generator online before the strike',
    );

    const r = applyAction(state, 'p1', { type: 'fire', buildingId: arty.id, x: rx, y: ry, rot: 0 });
    check(r.ok, `research-test: artillery strike accepted${r.ok ? '' : ' — ' + r.error}`);
    if (r.ok) {
      const research2 = r.state.buildings.find((b) => b.id === research.id)!;
      const gen2 = r.state.buildings.find((b) => b.id === gen.id)!;
      const guarded2 = r.state.buildings.find((b) => b.id === guarded.id)!;
      check(research2.destroyed, 'research-test: research station destroyed');
      check(gen2.disabled, 'research-test: shield generator goes offline when research is lost');
      check(
        guarded2.cells.every((c) => c.shield === 0),
        'research-test: shield coverage drops the same turn the research dies',
      );
    }
  }
}

console.log('\n=== RESULT ===');
if (failures === 0) {
  console.log('ALL CHECKS PASSED ✓');
  process.exit(0);
} else {
  console.error(`${failures} CHECK(S) FAILED ✗`);
  process.exit(1);
}
