import type {
  Action,
  ApplyResult,
  Building,
  BuildingCell,
  BuildingType,
  GameEvent,
  GameSettings,
  GameState,
  PlayerState,
  TerrainType,
  Vec,
} from './types';
import { BUILDINGS, FACTIONS, START_ENERGY, TURN_CAP } from './constants';
import { generateMap } from './map';
import { makeRng } from './rng';

// ----------------------------- grid helpers -----------------------------
export const cellIndex = (s: GameState, x: number, y: number) => y * s.map.width + x;
export const inBounds = (s: GameState, x: number, y: number) =>
  x >= 0 && y >= 0 && x < s.map.width && y < s.map.height;
export const terrainAt = (s: GameState, x: number, y: number): TerrainType =>
  s.map.terrain[cellIndex(s, x, y)];
export const territoryAt = (s: GameState, x: number, y: number): number =>
  s.map.territory[cellIndex(s, x, y)];

export function footprint(x: number, y: number, w: number, h: number): Vec[] {
  const cells: Vec[] = [];
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) cells.push({ x: x + dx, y: y + dy });
  return cells;
}

export function canTargetAt(s: GameState, owner: number, x: number, y: number, w: number, h: number): boolean {
  for (const c of footprint(x, y, w, h)) {
    if (!inBounds(s, c.x, c.y)) return false;
    if (territoryAt(s, c.x, c.y) === owner) return false;
  }
  return true;
}

export function defOf(type: BuildingType) {
  return BUILDINGS[type];
}

// rotation 0 = as-defined, 1 = quarter-turn (swap w/h). Square footprints are unaffected.
export function rotDims(type: BuildingType, rot: 0 | 1): { w: number; h: number } {
  const d = BUILDINGS[type];
  return rot ? { w: d.h, h: d.w } : { w: d.w, h: d.h };
}
export function canRotate(type: BuildingType): boolean {
  const d = BUILDINGS[type];
  return d.w !== d.h;
}

// non-destroyed building cell occupying (x,y)
export function buildingAt(s: GameState, x: number, y: number): { b: Building; cell: BuildingCell } | null {
  for (const b of s.buildings) {
    if (b.destroyed) continue;
    for (const c of b.cells) {
      if (!c.destroyed && c.x === x && c.y === y) return { b, cell: c };
    }
  }
  return null;
}

export function buildingById(s: GameState, id: string): Building | undefined {
  return s.buildings.find((b) => b.id === id);
}

export function playerIndexOf(s: GameState, playerId: string): number {
  return s.players.findIndex((p) => p.id === playerId);
}

function chebToBuilding(b: Building, x: number, y: number): number {
  let m = Infinity;
  for (const c of b.cells) {
    if (c.destroyed) continue;
    const d = Math.max(Math.abs(c.x - x), Math.abs(c.y - y));
    if (d < m) m = d;
  }
  return m;
}

function buildingCenter(b: Building): Vec {
  return { x: b.x + (b.w - 1) / 2, y: b.y + (b.h - 1) / 2 };
}

function hasLivingResearch(s: GameState, owner: number): boolean {
  return s.buildings.some((b) => b.owner === owner && b.type === 'research' && !b.destroyed);
}

function countLiving(s: GameState, owner: number, type: BuildingType): number {
  return s.buildings.filter((b) => b.owner === owner && b.type === type && !b.destroyed).length;
}

function hasIncomeSource(s: GameState, owner: number): boolean {
  return s.buildings.some((b) => b.owner === owner && !b.destroyed && !b.disabled && (defOf(b.type).energy ?? 0) > 0);
}

// You can still recover a lost Base if there's free territory to place it AND you can pay for it
// (now, or eventually via remaining energy income). Otherwise the war is lost.
export function canRebuildBase(s: GameState, owner: number): boolean {
  if (countLiving(s, owner, 'base') > 0) return true;
  if (validPlacements(s, owner, 'base', 0).length === 0) return false;
  let income = 0;
  for (const b of s.buildings) {
    if (b.owner !== owner || b.destroyed) continue;
    if (defOf(b.type).energy) {
      if (b.type === 'powerplant') continue; // powerplant cannot work without a base
      income += defOf(b.type).energy!;
    }
  }
  return s.players[owner].energy + income >= defOf('base').cost;
}

// line-of-sight: false if a mountain sits between (exclusive of endpoints)
function lineOfSight(s: GameState, x0: number, y0: number, x1: number, y1: number): boolean {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  if (steps <= 1) return true;
  for (let k = 1; k < steps; k++) {
    const t = k / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    if (inBounds(s, x, y) && terrainAt(s, x, y) === 'mountain') return false;
  }
  return true;
}

// is a cell hidden from enemy detection by its owner's jammer?
function isJammed(s: GameState, x: number, y: number, owner: number): boolean {
  for (const b of s.buildings) {
    if (b.owner !== owner || b.type !== 'jammer' || b.destroyed || b.disabled) continue;
    if (chebToBuilding(b, x, y) <= (defOf('jammer').range ?? 0)) return true;
  }
  return false;
}

function addRevealed(s: GameState, p: PlayerState, idx: number) {
  if (!p.revealed.includes(idx)) p.revealed.push(idx);
  p.revealedAt ||= {};
  p.revealedAt[idx] = s.round;
}

// ----------------------------- game creation -----------------------------
let _localSeq = 0;
function genId(prefix: string): string {
  _localSeq = (_localSeq + 1) % 1e9;
  return `${prefix}${_localSeq}`;
}

export interface PlayerSeed {
  id: string;
  name: string;
  color?: string;
  faction?: string;
  isAI?: boolean;
}

export function createGame(
  settings: GameSettings,
  seed: number,
  players: PlayerSeed[],
  gameId?: string,
): GameState {
  const map = generateMap(seed, settings.mapArchetype, settings.numPlayers);
  const ps: PlayerState[] = players.map((pl, i) => {
    const f = FACTIONS[i % FACTIONS.length];
    return {
      id: pl.id,
      index: i,
      name: pl.name || f.name,
      color: pl.color || f.color,
      faction: pl.faction || f.id,
      energy: START_ENERGY,
      alive: true,
      isAI: !!pl.isAI,
      connected: true,
      hasPlacedBase: false,
      readyShots: 0,
      revealed: [],
      stats: {
        shotsFired: 0,
        hits: 0,
        buildingsBuilt: 0,
        buildingsLost: 0,
        energyEarned: 0,
        nukesLaunched: 0,
      },
    };
  });

  const turnOrder = ps.map((p) => p.index);
  const rng = makeRng(seed);
  for (let i = turnOrder.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [turnOrder[i], turnOrder[j]] = [turnOrder[j], turnOrder[i]];
  }

  return {
    id: gameId || genId('game_'),
    seed,
    map,
    players: ps,
    buildings: [],
    blockedUntil: new Array(map.width * map.height).fill(0),
    turn: 0,
    round: 0,
    turnOrder,
    currentPlayer: turnOrder[0],
    phase: 'deploy',
    winner: null,
    settings,
    log: [{ turn: 0, player: -1, text: 'Commanders, deploy your Command Base.', kind: 'system' }],
  };
}

function makeBuilding(
  type: BuildingType,
  owner: number,
  x: number,
  y: number,
  turn: number,
  rot: 0 | 1 = 0,
): Building {
  const def = defOf(type);
  const { w: bw, h: bh } = rotDims(type, rot);
  const cells: BuildingCell[] = footprint(x, y, bw, bh).map((c) => ({
    x: c.x,
    y: c.y,
    hp: def.hpPerCell,
    maxHp: def.hpPerCell,
    shield: 0,
    destroyed: false,
  }));
  // weapons AND active abilities (sonar) need a turn to power up after construction
  const isWeapon = def.category === 'weapon' || type === 'sonar';
  return {
    id: genId('bld'),
    type,
    owner,
    x,
    y,
    w: bw,
    h: bh,
    cells,
    cooldownLeft: 0,
    builtTurn: turn,
    operationalTurn: isWeapon ? turn + 1 : turn,
    disabled: def.requiresResearch && !false, // recomputed in refreshDisabled
    destroyed: false,
  };
}

// ----------------------------- placement validation -----------------------------
export function canPlaceAt(
  s: GameState,
  player: number,
  type: BuildingType,
  x: number,
  y: number,
  rot: 0 | 1 = 0,
): boolean {
  const def = defOf(type);
  const { w, h } = rotDims(type, rot);
  for (const c of footprint(x, y, w, h)) {
    if (!inBounds(s, c.x, c.y)) return false;
    if (terrainAt(s, c.x, c.y) !== 'land') return false; // rubble/irradiated/water all unbuildable
    if (territoryAt(s, c.x, c.y) !== player) return false;
    if (buildingAt(s, c.x, c.y)) return false;
    if ((s.blockedUntil?.[cellIndex(s, c.x, c.y)] ?? 0) > s.turn) return false; // fresh crater
  }
  if (def.maxCount && countLiving(s, player, type) >= def.maxCount) return false;
  if (def.requiresResearch && !hasLivingResearch(s, player)) return false;
  return true;
}

export function validPlacements(s: GameState, player: number, type: BuildingType, rot: 0 | 1 = 0): Vec[] {
  const def = defOf(type);
  if (def.maxCount && countLiving(s, player, type) >= def.maxCount) return [];
  if (def.requiresResearch && !hasLivingResearch(s, player)) return [];

  const out: Vec[] = [];
  const { w, h } = rotDims(type, rot);

  const occupied = new Uint8Array(s.map.width * s.map.height);
  for (const b of s.buildings) {
    if (b.destroyed) continue;
    for (const c of b.cells) {
      if (!c.destroyed) {
        occupied[c.y * s.map.width + c.x] = 1;
      }
    }
  }

  const canPlaceFast = (x: number, y: number) => {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const cx = x + dx;
        const cy = y + dy;
        const ci = cy * s.map.width + cx;
        if (terrainAt(s, cx, cy) !== 'land') return false;
        if (territoryAt(s, cx, cy) !== player) return false;
        if (occupied[ci]) return false;
        if ((s.blockedUntil?.[ci] ?? 0) > s.turn) return false;
      }
    }
    return true;
  };

  for (let y = 0; y <= s.map.height - h; y++) {
    for (let x = 0; x <= s.map.width - w; x++) {
      if (canPlaceFast(x, y)) out.push({ x, y });
    }
  }
  return out;
}

export function validBasePlacements(s: GameState, player: number): Vec[] {
  return validPlacements(s, player, 'base');
}

// ----------------------------- turn machinery -----------------------------
function refreshDisabled(s: GameState) {
  for (const b of s.buildings) {
    if (b.destroyed) continue;
    const def = defOf(b.type);
    const hasBase = s.buildings.some((o) => o.owner === b.owner && o.type === 'base' && !o.destroyed);
    b.disabled = (def.requiresResearch && !hasLivingResearch(s, b.owner)) || (b.type === 'powerplant' && !hasBase);
  }
}

function recomputeShields(s: GameState, owner: number) {
  // reset this player's building cell shields, then apply coverage from READY shield gens.
  // Buff: coverage never stacks (max 1), and a breached cell has its own cooldown rather than disabling the generator.
  const gens = s.buildings.filter(
    (b) =>
      b.owner === owner &&
      b.type === 'shield' &&
      !b.destroyed &&
      !b.disabled &&
      s.turn >= b.operationalTurn,
  );
  for (const b of s.buildings) {
    if (b.owner !== owner || b.destroyed) continue;
    for (const c of b.cells) {
      if (c.destroyed) continue;
      let cover = 0;
      for (const g of gens) {
        if (chebToBuilding(g, c.x, c.y) <= (defOf('shield').range ?? 0)) cover++;
      }
      c.shield = (c.shieldCooldown && c.shieldCooldown > 0) ? 0 : Math.min(1, cover);
    }
  }
}

function runRepairs(s: GameState, owner: number, events: GameEvent[]) {
  const bays = s.buildings.filter(
    (b) => b.owner === owner && b.type === 'repair' && !b.destroyed && !b.disabled,
  );
  const healed: Vec[] = [];
  for (const bay of bays) {
    if (s.turn < bay.operationalTurn) continue;
    if (bay.cooldownLeft > 0) continue; // nerfed: heals only every 3 turns
    // find most-damaged friendly cell in range
    let target: BuildingCell | null = null;
    let worst = 0;
    for (const b of s.buildings) {
      if (b.owner !== owner || b.destroyed || b.type === 'repair') continue;
      for (const c of b.cells) {
        if (c.destroyed) continue;
        const miss = c.maxHp - c.hp;
        if (miss > worst && chebToBuilding(bay, c.x, c.y) <= (defOf('repair').range ?? 0)) {
          worst = miss;
          target = c;
        }
      }
    }
    if (target) {
      target.hp = Math.min(target.maxHp, target.hp + 1);
      bay.cooldownLeft = defOf('repair').cooldown ?? 3;
      healed.push({ x: target.x, y: target.y });
    }
  }
  if (healed.length) events.push({ type: 'repair', cells: healed });
}

function runRadar(s: GameState, owner: number, events: GameEvent[]) {
  const radars = s.buildings.filter(
    (b) => b.owner === owner && b.type === 'radar' && !b.destroyed && !b.disabled,
  );
  if (!radars.length) return;
  const player = s.players[owner];
  const range = defOf('radar').range ?? 3;
  const swept = new Set<number>();
  const revealedStructures: number[] = [];
  for (const r of radars) {
    if (s.turn < r.operationalTurn) continue;
    const cen = buildingCenter(r);
    for (let y = 0; y < s.map.height; y++) {
      for (let x = 0; x < s.map.width; x++) {
        if (chebToBuilding(r, x, y) > range) continue;
        if (!lineOfSight(s, Math.round(cen.x), Math.round(cen.y), x, y)) continue;
        swept.add(cellIndex(s, x, y));
        const hit = buildingAt(s, x, y);
        if (hit && hit.b.owner !== owner && !isJammed(s, x, y, hit.b.owner)) {
          const ci = cellIndex(s, x, y);
          addRevealed(s, player, ci);
          revealedStructures.push(ci);
        }
      }
    }
  }
  if (swept.size) events.push({ type: 'radar', player: owner, cells: [...swept] });
  if (revealedStructures.length)
    events.push({ type: 'reveal', player: owner, cells: revealedStructures });
}

function startTurn(s: GameState, owner: number, events: GameEvent[]) {
  const p = s.players[owner];
  if (!p.alive) return;

  // Clean up expired vision (expires after 2 rounds)
  if (p.revealedAt) {
    p.revealed = p.revealed.filter((idx) => {
      const revRound = p.revealedAt![idx] ?? 0;
      if (s.round - revRound >= 2) {
        delete p.revealedAt![idx];
        return false;
      }
      return true;
    });
  }

  refreshDisabled(s);

  // tick cooldowns for this player's buildings and cell shield cooldowns
  for (const b of s.buildings) {
    if (b.owner === owner && b.cooldownLeft > 0) b.cooldownLeft--;
    if (b.owner === owner) {
      for (const c of b.cells) {
        if (c.shieldCooldown && c.shieldCooldown > 0) {
          c.shieldCooldown--;
        }
      }
    }
  }

  // income
  let income = 0;
  for (const b of s.buildings) {
    if (b.owner !== owner || b.destroyed || b.disabled) continue;
    const def = defOf(b.type);
    if (def.energy) {
      if (b.type === 'powerplant') {
        income += hasLivingResearch(s, owner) ? 2 : 1;
      } else {
        income += def.energy;
      }
    }
  }
  if (income > 0) {
    p.energy += income;
    p.stats.energyEarned += income;
    events.push({ type: 'income', player: owner, amount: income, total: p.energy });
  }

  runRepairs(s, owner, events);
  recomputeShields(s, owner);
  runRadar(s, owner, events);

  events.push({ type: 'turn', player: owner, turn: s.turn });
}

function nextAlive(s: GameState, from: number): number {
  const currentTurnIdx = s.turnOrder.indexOf(from);
  for (let k = 1; k <= s.turnOrder.length; k++) {
    const idx = s.turnOrder[(currentTurnIdx + k) % s.turnOrder.length];
    if (s.players[idx].alive) return idx;
  }
  return from;
}

function buildingValue(s: GameState, owner: number): number {
  let v = 0;
  for (const b of s.buildings) {
    if (b.owner !== owner || b.destroyed) continue;
    const base = b.type === 'base' ? 3 : 1;
    for (const c of b.cells) if (!c.destroyed) v += base;
  }
  return v;
}

function checkWin(s: GameState, events: GameEvent[]) {
  // Check for players who cannot rebuild their base
  for (const p of s.players) {
    if (p.alive && !canRebuildBase(s, p.index)) {
      s.log.push({
        turn: s.turn,
        player: -1,
        text: `${p.name} has no Command Base and no way to rebuild it, and is eliminated!`,
        kind: 'elim',
      });
      eliminate(s, p.index, events);
    }
  }

  const alive = s.players.filter((p) => p.alive);
  if (alive.length <= 1 && s.phase !== 'ended') {
    s.phase = 'ended';
    s.winner = alive.length === 1 ? alive[0].index : null;
    events.push({ type: 'win', winner: s.winner });
    s.log.push({
      turn: s.turn,
      player: -1,
      text: s.winner != null ? `${s.players[s.winner].name} rules the tide!` : 'Mutual annihilation.',
      kind: 'win',
    });
  }
}

function endByCap(s: GameState, events: GameEvent[]) {
  let best = -1;
  let bestV = -1;
  let tie = false;
  for (const p of s.players) {
    if (!p.alive) continue;
    const v = buildingValue(s, p.index);
    if (v > bestV) {
      bestV = v;
      best = p.index;
      tie = false;
    } else if (v === bestV) tie = true;
  }
  s.phase = 'ended';
  s.winner = tie ? null : best;
  events.push({ type: 'win', winner: s.winner });
}

// advance to the next living player's turn
function advanceTurn(s: GameState, events: GameEvent[]) {
  if (s.phase === 'ended') return;
  const next = nextAlive(s, s.currentPlayer);
  const curIdx = s.turnOrder.indexOf(s.currentPlayer);
  const nextIdx = s.turnOrder.indexOf(next);
  if (nextIdx <= curIdx) s.round++;
  s.currentPlayer = next;
  s.turn++;
  if (s.turn > s.settings.turnCap) {
    endByCap(s, events);
    return;
  }
  startTurn(s, next, events);
}

// ----------------------------- combat -----------------------------
function eliminate(s: GameState, owner: number, events: GameEvent[]) {
  const p = s.players[owner];
  if (!p.alive) return;
  p.alive = false;
  // the commander's war machine dies with them — every structure collapses to rubble
  for (const b of s.buildings) {
    if (b.owner !== owner || b.destroyed) continue;
    b.destroyed = true;
    for (const c of b.cells) {
      if (c.destroyed) continue;
      c.destroyed = true;
      c.hp = 0;
      const i = cellIndex(s, c.x, c.y);
      if (s.map.terrain[i] === 'land') s.map.terrain[i] = 'rubble';
      events.push({ type: 'cellDestroyed', x: c.x, y: c.y, owner });
    }
  }
  events.push({ type: 'eliminated', player: owner });
  s.log.push({ turn: s.turn, player: -1, text: `${p.name} has been eliminated — their fleet burns!`, kind: 'elim' });
}

function onBuildingDestroyed(s: GameState, b: Building, events: GameEvent[]) {
  b.destroyed = true;
  s.players[b.owner].stats.buildingsLost++;
  events.push({
    type: 'destroyed',
    buildingId: b.id,
    buildingType: b.type,
    owner: b.owner,
    cells: b.cells.map((c) => ({ x: c.x, y: c.y })),
  });
  refreshDisabled(s); // Update disabled states immediately (e.g. power plants if base is destroyed)
  if (b.type === 'base') {
    const anyBase = s.buildings.some((o) => o.owner === b.owner && o.type === 'base' && !o.destroyed);
    if (!anyBase) {
      if (canRebuildBase(s, b.owner)) {
        s.log.push({
          turn: s.turn,
          player: -1,
          text: `${s.players[b.owner].name}'s Command Base was destroyed — rebuild it before it's too late!`,
          kind: 'elim',
        });
      } else {
        eliminate(s, b.owner, events);
      }
    }
  }
}

// apply `dmg` to a cell; returns true if a building was struck. `nuke` destroys outright + irradiates.
function damageCell(
  s: GameState,
  attacker: number,
  x: number,
  y: number,
  dmg: number,
  events: GameEvent[],
  nuke = false,
): boolean {
  if (!inBounds(s, x, y)) return false;
  if (nuke) {
    const t = terrainAt(s, x, y);
    if (t !== 'deep') s.map.terrain[cellIndex(s, x, y)] = 'irradiated';
  }
  const hit = buildingAt(s, x, y);
  if (!hit) return false;
  const { b, cell } = hit;
  // NOTE: a hit does NOT reveal the building (its type/orientation stay hidden). The attacker
  // only learns the struck cell, surfaced via the missile/artillery/cellDestroyed events as a
  // marker. Structures are revealed exclusively by detection (radar / sonar).

  let remaining = nuke ? 999 : dmg;
  while (remaining > 0 && !cell.destroyed) {
    if (cell.shield > 0 && !nuke) {
      cell.shield--;
      remaining--;
      events.push({ type: 'absorbed', x, y, owner: b.owner });
      cell.shieldCooldown = 2; // only the absorbed tile goes on cooldown (2 rounds)
    } else {
      cell.hp--;
      remaining--;
      if (cell.hp <= 0) {
        cell.destroyed = true;
        events.push({ type: 'cellDestroyed', x, y, owner: b.owner });
      }
    }
  }
  if (nuke && !cell.destroyed) {
    cell.destroyed = true;
    events.push({ type: 'cellDestroyed', x, y, owner: b.owner });
  }
  // a destroyed building cell becomes permanent rubble — nothing can ever be built there again
  if (cell.destroyed && terrainAt(s, x, y) === 'land') {
    s.map.terrain[cellIndex(s, x, y)] = 'rubble';
  }
  s.players[attacker].stats.hits++;
  if (b.cells.every((c) => c.destroyed) && !b.destroyed) onBuildingDestroyed(s, b, events);
  return true;
}

// a shot landing on land cratered it: nothing can be built there for 2 full rounds
function markImpact(s: GameState, x: number, y: number) {
  if (!inBounds(s, x, y)) return;
  if (terrainAt(s, x, y) !== 'land') return;
  const i = cellIndex(s, x, y);
  s.blockedUntil[i] = Math.max(s.blockedUntil[i] ?? 0, s.turn + 2 * s.players.length);
}

// returns the intercepting turret's cell, or null. Nerf: a turret reloads for a round after a kill.
function tryIntercept(s: GameState, attacker: number, x: number, y: number): Vec | null {
  const hit = buildingAt(s, x, y);
  if (!hit || hit.b.owner === attacker) return null;
  const defender = hit.b.owner;
  const turrets = s.buildings.filter(
    (b) =>
      b.owner === defender &&
      b.type === 'turret' &&
      !b.destroyed &&
      !b.disabled &&
      b.cooldownLeft === 0 &&
      s.turn >= b.operationalTurn,
  );
  for (const t of turrets) {
    if (chebToBuilding(t, x, y) <= (defOf('turret').range ?? 0)) {
      const rng = makeRng(`${s.seed}:${s.turn}:${attacker}:${x},${y}:${t.id}`);
      if (rng.chance(defOf('turret').interceptChance ?? 0)) {
        t.cooldownLeft = 1; // reloads at the defender's next turn start (≈ one round)
        return { x: t.x, y: t.y };
      }
    }
  }
  return null;
}

// ----------------------------- action dispatch -----------------------------
function err(s: GameState, message: string): ApplyResult {
  return { ok: false, error: message, state: s, events: [] };
}

export function applyAction(stateIn: GameState, playerId: string, action: Action): ApplyResult {
  const s: GameState = structuredClone(stateIn);
  const events: GameEvent[] = [];
  const pi = playerIndexOf(s, playerId);
  if (pi < 0) return err(stateIn, 'Unknown player');
  const player = s.players[pi];
  if (s.phase === 'ended') return err(stateIn, 'Game is over');

  if (action.type === 'surrender') {
    if (!player.alive) return err(stateIn, 'You are already eliminated');
    eliminate(s, pi, events);
    if (s.phase === 'deploy') {
      player.hasPlacedBase = true;
      if (s.players.every((p) => p.hasPlacedBase)) {
        s.phase = 'playing';
        s.currentPlayer = s.turnOrder[0];
        s.turn = 1;
        s.round = 1;
        s.log.push({ turn: 1, player: -1, text: 'Battle stations! The bombardment begins.', kind: 'system' });
        startTurn(s, s.turnOrder[0], events);
      } else {
        s.currentPlayer = nextDeployer(s);
      }
    } else {
      checkWin(s, events);
      if (s.phase === 'playing' && s.currentPlayer === pi) {
        advanceTurn(s, events);
      }
    }
    return { ok: true, state: s, events };
  }

  // ---- deploy phase ----
  if (s.phase === 'deploy') {
    if (action.type !== 'placeBase') return err(stateIn, 'Deploy your Base first');
    if (s.currentPlayer !== pi) return err(stateIn, 'Not your turn to deploy');
    if (player.hasPlacedBase) return err(stateIn, 'Base already placed');
    if (!canPlaceAt(s, pi, 'base', action.x, action.y))
      return err(stateIn, 'Base must sit on a 2×2 block of your territory');
    const b = makeBuilding('base', pi, action.x, action.y, 0);
    s.buildings.push(b);
    player.hasPlacedBase = true;
    player.stats.buildingsBuilt++;
    events.push({ type: 'build', player: pi, building: 'base', x: action.x, y: action.y, w: 2, h: 2 });
    s.log.push({ turn: 0, player: pi, text: `${player.name} deployed their Command Base.`, kind: 'build' });

    if (s.players.every((p) => p.hasPlacedBase)) {
      s.phase = 'playing';
      s.currentPlayer = s.turnOrder[0];
      s.turn = 1;
      s.round = 1;
      s.log.push({ turn: 1, player: -1, text: 'Battle stations! The bombardment begins.', kind: 'system' });
      startTurn(s, s.turnOrder[0], events);
    } else {
      s.currentPlayer = nextDeployer(s);
    }
    return { ok: true, state: s, events };
  }

  // ---- playing phase ----
  if (s.currentPlayer !== pi) return err(stateIn, 'Not your turn');
  if (!player.alive) return err(stateIn, 'You are eliminated');

  switch (action.type) {
    case 'build': {
      const def = defOf(action.building);
      const rot: 0 | 1 = action.rot === 1 && canRotate(action.building) ? 1 : 0;
      if (!canPlaceAt(s, pi, action.building, action.x, action.y, rot)) {
        if (def.requiresResearch && !hasLivingResearch(s, pi))
          return err(stateIn, `${def.name} needs a living Research Station`);
        if (def.maxCount && countLiving(s, pi, action.building) >= def.maxCount)
          return err(
            stateIn,
            action.building === 'base' ? 'You already have a Command Base' : `Only ${def.maxCount} ${def.name} allowed`,
          );
        return err(stateIn, 'Invalid placement (must be free land in your territory)');
      }
      if (player.energy < def.cost) return err(stateIn, 'Not enough ⚡ energy');
      player.energy -= def.cost;
      const b = makeBuilding(action.building, pi, action.x, action.y, s.turn, rot);
      refreshDisabledOne(s, b);
      s.buildings.push(b);
      player.stats.buildingsBuilt++;
      if (action.building === 'research') refreshDisabled(s); // re-enable advanced buildings
      const d2 = rotDims(action.building, rot);
      events.push({
        type: 'build',
        player: pi,
        building: action.building,
        x: action.x,
        y: action.y,
        w: d2.w,
        h: d2.h,
      });
      s.log.push({ turn: s.turn, player: pi, text: `${player.name} built a ${def.name}.`, kind: 'build' });
      return { ok: true, state: s, events };
    }

    case 'fire': {
      const b = buildingById(s, action.buildingId);
      if (!b || b.owner !== pi || b.destroyed) return err(stateIn, 'Invalid weapon');
      const def = defOf(b.type);
      if (def.category !== 'weapon') return err(stateIn, 'Not a weapon');
      if (b.disabled) return err(stateIn, 'Weapon offline');
      if (s.turn < b.operationalTurn) return err(stateIn, 'Weapon is still powering up');
      if (b.cooldownLeft > 0) return err(stateIn, `Reloading (${b.cooldownLeft} turn(s))`);
      const rot: 0 | 1 = action.rot === 1 ? 1 : 0;
      const aw = rot ? def.attackH ?? 1 : def.attackW ?? 1;
      const ah = rot ? def.attackW ?? 1 : def.attackH ?? 1;
      const cells = footprint(action.x, action.y, aw, ah);
      for (const c of cells) if (!inBounds(s, c.x, c.y)) return err(stateIn, 'Target out of bounds');
      if (!canTargetAt(s, pi, action.x, action.y, aw, ah)) return err(stateIn, 'Cannot target your own territory');
      if (def.fireCost && player.energy < def.fireCost) return err(stateIn, 'Not enough ⚡ to fire');

      if (def.fireCost) player.energy -= def.fireCost;
      b.cooldownLeft = def.cooldown ?? 0;
      player.stats.shotsFired++;
      const fromC = buildingCenter(b);

      if (b.type === 'silo') {
        const t = cells[0];
        const interceptor = tryIntercept(s, pi, t.x, t.y);
        const intercepted = !!interceptor;
        let hitB = false;
        if (!intercepted) {
          hitB = damageCell(s, pi, t.x, t.y, 1, events);
          markImpact(s, t.x, t.y);
        }
        events.push({
          type: 'missile',
          player: pi,
          from: fromC,
          to: { x: t.x, y: t.y },
          hit: hitB,
          intercepted,
          interceptedBy: interceptor,
        });
        s.log.push({
          turn: s.turn,
          player: pi,
          text: intercepted
            ? `${player.name}'s missile was intercepted!`
            : hitB
              ? `${player.name} struck a structure at (${t.x},${t.y})!`
              : `${player.name} fired at (${t.x},${t.y}) — splash.`,
          kind: 'fire',
        });
      } else if (b.type === 'artillery') {
        const hits: Vec[] = [];
        for (const c of cells) {
          if (damageCell(s, pi, c.x, c.y, 1, events)) hits.push(c);
          markImpact(s, c.x, c.y);
        }
        events.push({ type: 'artillery', player: pi, from: fromC, cells, hits });
        s.log.push({
          turn: s.turn,
          player: pi,
          text: `${player.name}'s artillery hit ${hits.length}/${cells.length} cells.`,
          kind: 'fire',
        });
      } else if (b.type === 'napalm') {
        const hits: Vec[] = [];
        for (const c of cells) {
          if (damageCell(s, pi, c.x, c.y, 1, events)) hits.push(c);
          markImpact(s, c.x, c.y);
        }
        events.push({ type: 'napalm', player: pi, from: fromC, cells, hits });
        s.log.push({
          turn: s.turn,
          player: pi,
          text: `🔥 ${player.name}'s napalm scorched ${hits.length}/${cells.length} cells.`,
          kind: 'fire',
        });
      } else if (b.type === 'nuclear') {
        for (const c of cells) damageCell(s, pi, c.x, c.y, 999, events, true);
        player.stats.nukesLaunched++;
        events.push({
          type: 'nuke',
          player: pi,
          from: fromC,
          center: { x: action.x + 1, y: action.y + 1 },
          cells,
        });
        s.log.push({ turn: s.turn, player: pi, text: `☢ ${player.name} launched a NUCLEAR strike!`, kind: 'nuke' });
      }

      checkWin(s, events);
      return { ok: true, state: s, events };
    }

    case 'sonar': {
      const b = buildingById(s, action.buildingId);
      if (!b || b.owner !== pi || b.destroyed || b.type !== 'sonar') return err(stateIn, 'Invalid sonar');
      if (b.disabled) return err(stateIn, 'Sonar offline (needs Research Station)');
      if (s.turn < b.operationalTurn) return err(stateIn, 'Sonar is still calibrating');
      if (b.cooldownLeft > 0) return err(stateIn, `Sonar recharging (${b.cooldownLeft})`);
      const def = defOf('sonar');
      const cells = footprint(action.x, action.y, def.attackW ?? 5, def.attackH ?? 5);
      b.cooldownLeft = def.cooldown ?? 0;
      const revealed: number[] = [];
      const area: number[] = [];
      for (const c of cells) {
        if (!inBounds(s, c.x, c.y)) continue;
        area.push(cellIndex(s, c.x, c.y));
        const hit = buildingAt(s, c.x, c.y);
        if (hit && hit.b.owner !== pi && !isJammed(s, c.x, c.y, hit.b.owner)) {
          const ci = cellIndex(s, c.x, c.y);
          addRevealed(s, player, ci);
          revealed.push(ci);
        }
      }
      events.push({ type: 'sonar', player: pi, center: { x: action.x + 1, y: action.y + 1 }, cells: area });
      if (revealed.length) events.push({ type: 'reveal', player: pi, cells: revealed });
      s.log.push({ turn: s.turn, player: pi, text: `${player.name} pinged a sonar sweep.`, kind: 'detect' });
      return { ok: true, state: s, events };
    }

    case 'demolish': {
      const b = buildingById(s, action.buildingId);
      if (!b || b.owner !== pi || b.destroyed) return err(stateIn, 'Invalid building');
      if (b.type === 'base') return err(stateIn, 'You cannot demolish your Base');
      for (const c of b.cells) c.destroyed = true;
      b.destroyed = true;
      refreshDisabled(s);
      s.log.push({ turn: s.turn, player: pi, text: `${player.name} scrapped a ${defOf(b.type).name}.`, kind: 'build' });
      return { ok: true, state: s, events };
    }

    case 'endTurn': {
      // Check for base elimination rule
      if (!s.buildings.some((b) => b.owner === pi && b.type === 'base' && !b.destroyed)) {
        s.log.push({ turn: s.turn, player: -1, text: `${player.name} failed to rebuild their Command Base and is eliminated!`, kind: 'elim' });
        eliminate(s, pi, events);
        checkWin(s, events);
      } else {
        s.log.push({ turn: s.turn, player: pi, text: `${player.name} ended their turn.`, kind: 'turn' });
      }
      advanceTurn(s, events);
      return { ok: true, state: s, events };
    }

    default:
      return err(stateIn, 'Unknown action');
  }
}

function refreshDisabledOne(s: GameState, b: Building) {
  const def = defOf(b.type);
  const hasBase = s.buildings.some((o) => o.owner === b.owner && o.type === 'base' && !o.destroyed);
  b.disabled = (def.requiresResearch && !hasLivingResearch(s, b.owner)) || (b.type === 'powerplant' && !hasBase);
}

function nextDeployer(s: GameState): number {
  for (let i = 0; i < s.players.length; i++) {
    if (!s.players[i].hasPlacedBase) return i;
  }
  return s.currentPlayer;
}

// ----------------------------- fog of war serialization -----------------------------
export function serializeForPlayer(state: GameState, viewer: number): GameState {
  const s: GameState = structuredClone(state);

  for (const p of s.players) {
    p.readyShots = 0;
  }
  for (const b of state.buildings) {
    if (b.destroyed) continue;
    const def = defOf(b.type);
    if ((def.category === 'weapon' || b.type === 'sonar') && !b.disabled && state.turn >= b.operationalTurn && b.cooldownLeft === 0) {
      if (s.players[b.owner]) s.players[b.owner].readyShots++;
    }
  }

  if (!s.settings.fogOfWar) {
    s.fogged = false;
    s.viewerIndex = viewer;
    return s;
  }
  const me = s.players[viewer];
  // eliminated commanders become spectators: full vision of every field
  if (me && !me.alive) {
    s.settings.fogOfWar = false;
    s.fogged = false;
    s.viewerIndex = viewer;
    return s;
  }
  const seen = new Set(me?.revealed ?? []);
  s.buildings = s.buildings.map((b) => {
    if (b.owner === viewer) return b;
    // eliminated commanders lose their fog — their whole field is exposed (don't waste ammo there)
    if (!s.players[b.owner]?.alive) return b;
    const visibleCells = b.cells.filter((c) => seen.has(c.y * s.map.width + c.x));
    if (visibleCells.length === 0) return null;
    return {
      ...b,
      cells: visibleCells,
    };
  }).filter((b): b is Building => b !== null);

  // hide opponents' private info
  for (const p of s.players) {
    if (p.index !== viewer) {
      p.energy = 0;
      p.revealed = [];
    }
  }

  // Collect all cell indices belonging to the viewer that any alive opponent has in their revealed list
  const visibleToEnemy = new Set<number>();
  for (const p of state.players) {
    if (p.index !== viewer && p.alive) {
      for (const idx of p.revealed) {
        if (state.map.territory[idx] === viewer) {
          visibleToEnemy.add(idx);
        }
      }
    }
  }
  s.visibleToEnemy = [...visibleToEnemy];

  s.fogged = true;
  s.viewerIndex = viewer;
  return s;
}

// ----------------------------- misc public helpers -----------------------------
export function currentPlayer(s: GameState): PlayerState {
  return s.players[s.currentPlayer];
}

export function aliveCount(s: GameState): number {
  return s.players.filter((p) => p.alive).length;
}

export function weaponReady(s: GameState, b: Building): boolean {
  const def = defOf(b.type);
  return (
    def.category === 'weapon' &&
    !b.destroyed &&
    !b.disabled &&
    s.turn >= b.operationalTurn &&
    b.cooldownLeft === 0
  );
}

export function incomePreview(s: GameState, owner: number): number {
  let income = 0;
  for (const b of s.buildings) {
    if (b.owner !== owner || b.destroyed || b.disabled) continue;
    const def = defOf(b.type);
    if (def.energy) {
      if (b.type === 'powerplant') {
        income += hasLivingResearch(s, owner) ? 2 : 1;
      } else {
        income += def.energy;
      }
    }
  }
  return income;
}
