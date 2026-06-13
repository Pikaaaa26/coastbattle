// Engine self-test: validates map generation + simulates full AI-vs-AI games.
// Run with: npm run engine:test
import { generateMap, ARCHETYPES, ARCHETYPE_NAMES } from './map';
import { createGame } from './engine';
import { applyAction, serializeForPlayer } from './engine';
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
  while (state.phase === 'playing' && safety++ < 5000) {
    const ai = state.currentPlayer;
    const plan = decideTurn(state, ai, mem[ai]);
    for (const act of plan) {
      const r = applyAction(state, state.players[ai].id, act);
      if (!r.ok) actionErrors++;
      else state = r.state;
      if (state.phase === 'ended') break;
    }
  }
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

console.log('\n=== RESULT ===');
if (failures === 0) {
  console.log('ALL CHECKS PASSED ✓');
  process.exit(0);
} else {
  console.error(`${failures} CHECK(S) FAILED ✗`);
  process.exit(1);
}
