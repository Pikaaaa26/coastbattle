import type { Action, Building, BuildingType, GameEvent, GameState, Vec } from './types';
import { buildingDef } from './constants';
import {
  applyAction,
  buildingAt,
  canRotate,
  canTargetAt,
  cellIndex,
  incomePreview,
  serializeForPlayer,
  terrainAt,
  territoryAt,
  validPlacements,
} from './engine';
import { makeRng, type Rng } from './rng';
import OPTIMIZED_AI_WEIGHTS from './optimized_weights.json';

export interface AiMemory {
  misses: number[]; // cells we've shot and found empty
  hits: number[]; // cells confirmed occupied by a hit (but not yet destroyed)
  destroyed: number[]; // cells we've confirmed destroyed / irradiated
  targetBuilding?: BuildingType | null;
}

export function newAiMemory(): AiMemory {
  return { misses: [], hits: [], destroyed: [], targetBuilding: null };
}

export interface AiWeights {
  baseScanVal: number;
  parityBonus: number;
  adjacentHitBonus: number;
  hitCellVal: number;
  knownBaseVal: number;
  knownEcoVal: number;
  knownRadarVal: number;
  energyReserve: number;

  wBase_economy: number;
  wEnergy_economy: number;
  wEnergyGen_economy: number;
  wBaseHp_economy: number;

  wBase_tech: number;
  wEnergy_tech: number;
  wEnergyGen_tech: number;
  wBaseHp_tech: number;

  wBase_defense: number;
  wEnergy_defense: number;
  wEnergyGen_defense: number;
  wBaseHp_defense: number;

  wBase_military: number;
  wEnergy_military: number;
  wEnergyGen_military: number;
  wBaseHp_military: number;
}

export const DEFAULT_AI_WEIGHTS: AiWeights = {
  baseScanVal: 14,
  parityBonus: 4,
  adjacentHitBonus: 10,
  hitCellVal: 96,
  knownBaseVal: 137,
  knownEcoVal: 97,
  knownRadarVal: 80,
  energyReserve: 6,

  wBase_economy: 15,
  wEnergy_economy: -0.2,
  wEnergyGen_economy: -1.0,
  wBaseHp_economy: 0,

  wBase_tech: 8,
  wEnergy_tech: 0.1,
  wEnergyGen_tech: 0.2,
  wBaseHp_tech: 0,

  wBase_defense: 5,
  wEnergy_defense: 0.1,
  wEnergyGen_defense: 0.1,
  wBaseHp_defense: -0.5,

  wBase_military: 12,
  wEnergy_military: 0.2,
  wEnergyGen_military: 0.5,
  wBaseHp_military: 0,
};

function pushUniq(arr: number[], v: number) {
  if (!arr.includes(v)) arr.push(v);
}

// Update memory from the legitimate results of our own shots (hit/miss/destroyed via events).
function recordShotResults(events: GameEvent[], memory: AiMemory, W: number) {
  for (const e of events) {
    if (e.type === 'cellDestroyed') {
      pushUniq(memory.destroyed, e.y * W + e.x);
    } else if (e.type === 'missile') {
      const ci = e.to.y * W + e.to.x;
      if (e.intercepted) continue;
      if (e.hit) pushUniq(memory.hits, ci);
      else pushUniq(memory.misses, ci);
    } else if (e.type === 'artillery' || e.type === 'napalm') {
      const hitSet = new Set(e.hits.map((h) => h.y * W + h.x));
      for (const c of e.cells) {
        const ci = c.y * W + c.x;
        if (hitSet.has(ci)) pushUniq(memory.hits, ci);
        else pushUniq(memory.misses, ci);
      }
    } else if (e.type === 'nuke') {
      for (const c of e.cells) pushUniq(memory.destroyed, c.y * W + c.x);
    }
  }
}

function ownBase(s: GameState, ai: number): Building | undefined {
  return s.buildings.find((b) => b.owner === ai && b.type === 'base' && !b.destroyed);
}

function centroidOf(s: GameState, predicate: (territory: number) => boolean): Vec {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < s.map.height; y++) {
    for (let x = 0; x < s.map.width; x++) {
      if (terrainAt(s, x, y) !== 'land') continue;
      if (predicate(territoryAt(s, x, y))) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  return n ? { x: sx / n, y: sy / n } : { x: s.map.width / 2, y: s.map.height / 2 };
}

function nearestPlacement<T extends Vec>(spots: T[], to: Vec, rng: Rng): T | null {
  if (!spots.length) return null;
  let best = spots[0];
  let bestD = Infinity;
  for (const p of spots) {
    const d = (p.x - to.x) ** 2 + (p.y - to.y) ** 2 + rng.next() * 0.5;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

// -------------------- deployment --------------------
export function decideDeploy(state: GameState, ai: number): Action | null {
  const spots = validPlacements(state, ai, 'base');
  if (!spots.length) return null;
  const rng = makeRng(`${state.seed}:deploy:${ai}`);
  const c = centroidOf(state, (t) => t === ai);
  const spot = nearestPlacement(spots, c, rng)!;
  return { type: 'placeBase', x: spot.x, y: spot.y };
}

// -------------------- per-turn planning --------------------
const BUILD_PRIORITY: { type: BuildingType; want: (s: GameState, ai: number, turn: number) => boolean }[] = [
  { type: 'base', want: (s, ai) => count(s, ai, 'base') === 0 }, // top priority: never stay baseless
  { type: 'powerplant', want: (s, ai) => count(s, ai, 'powerplant') === 0 },
  { type: 'research', want: (s, ai, t) => count(s, ai, 'powerplant') > 0 && count(s, ai, 'research') === 0 && t >= 2 },
  { type: 'silo', want: (s, ai) => count(s, ai, 'powerplant') > 0 && count(s, ai, 'silo') < 1 },
  { type: 'radar', want: (s, ai) => count(s, ai, 'powerplant') > 0 && hasResearch(s, ai) && count(s, ai, 'radar') < 1 },
  { type: 'powerplant', want: (s, ai) => count(s, ai, 'powerplant') < 2 },
  { type: 'artillery', want: (s, ai) => count(s, ai, 'powerplant') > 0 && count(s, ai, 'artillery') < 1 },
  { type: 'napalm', want: (s, ai) => count(s, ai, 'powerplant') > 0 && count(s, ai, 'napalm') < 1 },
  { type: 'silo', want: (s, ai) => count(s, ai, 'powerplant') > 0 && count(s, ai, 'silo') < 3 },
  { type: 'turret', want: (s, ai) => count(s, ai, 'powerplant') > 0 && hasResearch(s, ai) && count(s, ai, 'turret') < 1 },
  { type: 'radar', want: (s, ai) => count(s, ai, 'powerplant') > 0 && hasResearch(s, ai) && count(s, ai, 'radar') < 2 },
  { type: 'jammer', want: (s, ai) => count(s, ai, 'powerplant') > 0 && hasResearch(s, ai) && count(s, ai, 'jammer') < 1 },
  { type: 'artillery', want: (s, ai) => count(s, ai, 'powerplant') > 0 && count(s, ai, 'artillery') < 2 },
  { type: 'silo', want: (s, ai) => count(s, ai, 'powerplant') > 0 && count(s, ai, 'silo') < 6 },
];

function count(s: GameState, owner: number, type: BuildingType): number {
  return s.buildings.filter((b) => b.owner === owner && b.type === type && !b.destroyed).length;
}
function hasResearch(s: GameState, owner: number): boolean {
  return count(s, owner, 'research') > 0;
}

export function decideTurn(state: GameState, ai: number, memory: AiMemory, weights?: AiWeights): Action[] {
  const plan: Action[] = [];
  let w: GameState = structuredClone(state);
  const id = w.players[ai].id;
  const rng = makeRng(`${state.seed}:turn${state.turn}:${ai}`);
  const difficulty = state.settings.difficulty;
  const aggressive = difficulty === 'hard';
  // difficulty scaling: aim accuracy, fire frequency, build pace
  const skill = difficulty === 'easy' ? 0.4 : difficulty === 'normal' ? 0.78 : 1;
  const fireProb = difficulty === 'easy' ? 0.55 : difficulty === 'normal' ? 0.9 : 1;
  const maxBuilds = difficulty === 'easy' ? 1 : difficulty === 'normal' ? 3 : 24;

  const actualWeights = weights ?? (difficulty === 'hard' ? OPTIMIZED_AI_WEIGHTS : DEFAULT_AI_WEIGHTS);

  let lastEvents: GameEvent[] = [];
  const apply = (a: Action): boolean => {
    const r = applyAction(w, id, a);
    if (r.ok) {
      w = r.state;
      plan.push(a);
      lastEvents = r.events;
      return true;
    }
    lastEvents = [];
    return false;
  };

  // ---- BUILD PHASE ----
  let guard = 0;
  while (guard++ < maxBuilds) {
    // 1. If base is destroyed, our target is ALWAYS 'base' (emergency rebuild)
    if (count(w, ai, 'base') === 0) {
      memory.targetBuilding = 'base';
    }

    // 2. If targetBuilding is null/empty/not allowed anymore, select a new target
    if (!memory.targetBuilding || 
        (buildingDef(memory.targetBuilding).requiresResearch && !hasResearch(w, ai)) ||
        (buildingDef(memory.targetBuilding).maxCount !== undefined && count(w, ai, memory.targetBuilding) >= buildingDef(memory.targetBuilding).maxCount!)) {
      
      const currentEnergy = w.players[ai].energy;
      const energyIncome = incomePreview(w, ai);
      const baseObj = w.buildings.find((b) => b.owner === ai && b.type === 'base' && !b.destroyed);
      const baseHp = baseObj ? baseObj.cells.reduce((sum, c) => sum + (c.destroyed ? 0 : c.hp), 0) : 0;

      const getCategoryCandidates = (cat: string): BuildingType[] => {
        let types: BuildingType[] = [];
        if (cat === 'economy') types = ['powerplant'];
        else if (cat === 'tech') types = ['research', 'radar', 'sonar', 'jammer'];
        else if (cat === 'defense') types = ['shield', 'turret', 'repair'];
        else if (cat === 'military') types = ['silo', 'artillery', 'napalm', 'nuclear'];

        return types.filter((type) => {
          const def = buildingDef(type);
          if (def.maxCount && count(w, ai, type) >= def.maxCount) return false;
          if (def.requiresResearch && !hasResearch(w, ai)) return false;
          return true;
        });
      };

      const categories = ['economy', 'tech', 'defense', 'military'] as const;
      const catUtilities: { cat: typeof categories[number]; utility: number; candidates: BuildingType[] }[] = [];

      for (const cat of categories) {
        const candidates = getCategoryCandidates(cat);
        if (candidates.length === 0) continue;

        let wBase = 0;
        let wEnergy = 0;
        let wEnergyGen = 0;
        let wBaseHp = 0;

        if (cat === 'economy') {
          wBase = actualWeights.wBase_economy;
          wEnergy = actualWeights.wEnergy_economy;
          wEnergyGen = actualWeights.wEnergyGen_economy;
          wBaseHp = actualWeights.wBaseHp_economy;
        } else if (cat === 'tech') {
          wBase = actualWeights.wBase_tech;
          wEnergy = actualWeights.wEnergy_tech;
          wEnergyGen = actualWeights.wEnergyGen_tech;
          wBaseHp = actualWeights.wBaseHp_tech;
        } else if (cat === 'defense') {
          wBase = actualWeights.wBase_defense;
          wEnergy = actualWeights.wEnergy_defense;
          wEnergyGen = actualWeights.wEnergyGen_defense;
          wBaseHp = actualWeights.wBaseHp_defense;
        } else if (cat === 'military') {
          wBase = actualWeights.wBase_military;
          wEnergy = actualWeights.wEnergy_military;
          wEnergyGen = actualWeights.wEnergyGen_military;
          wBaseHp = actualWeights.wBaseHp_military;
        }

        const utility = wBase + wEnergy * currentEnergy + wEnergyGen * energyIncome + wBaseHp * baseHp;
        catUtilities.push({ cat, utility, candidates });
      }

      if (catUtilities.length > 0) {
        const maxUtil = Math.max(...catUtilities.map((c) => c.utility));
        const exps = catUtilities.map((c) => Math.exp(c.utility - maxUtil));
        const sumExps = exps.reduce((a, b) => a + b, 0);
        
        let r = rng.next() * sumExps;
        let selectedIdx = 0;
        for (let i = 0; i < catUtilities.length; i++) {
          r -= exps[i];
          if (r <= 0) {
            selectedIdx = i;
            break;
          }
        }
        const selectedCat = catUtilities[selectedIdx];
        const bIndex = Math.floor(rng.next() * selectedCat.candidates.length);
        memory.targetBuilding = selectedCat.candidates[bIndex];
      } else {
        memory.targetBuilding = null;
      }
    }

    // 3. If targetBuilding is null, it means there are no valid choices left (e.g. all max counts reached)
    if (!memory.targetBuilding) {
      break;
    }

    // 4. Try to build the target building
    const targetType = memory.targetBuilding;
    const def = buildingDef(targetType);
    const energy = w.players[ai].energy;

    if (energy < def.cost) {
      // Cannot afford target -> PASS
      break;
    }

    const spots0 = validPlacements(w, ai, targetType, 0).map(s => ({ ...s, rot: 0 as 0 | 1 }));
    const spots1 = canRotate(targetType) ? validPlacements(w, ai, targetType, 1).map(s => ({ ...s, rot: 1 as 0 | 1 })) : [];
    const spots = [...spots0, ...spots1];
    if (!spots.length) {
      // Cannot build due to no spots -> PASS
      break;
    }

    // Determine target location to build toward
    const ownC = (() => {
      const b = ownBase(w, ai);
      return b ? { x: b.x + 0.5, y: b.y + 0.5 } : centroidOf(w, (t) => t === ai);
    })();
    const enemyC = centroidOf(w, (t) => t !== ai && t >= 0);

    const toward = targetType === 'radar' || targetType === 'sonar' ? enemyC : ownC;
    let buildTarget = toward;
    if (targetType !== 'radar' && targetType !== 'sonar') {
      const dx = (rng.next() - 0.5) * 12;
      const dy = (rng.next() - 0.5) * 12;
      buildTarget = { x: toward.x + dx, y: toward.y + dy };
    }

    const spot = nearestPlacement(spots, buildTarget, rng)!;
    if (apply({ type: 'build', building: targetType, x: spot.x, y: spot.y, rot: spot.rot })) {
      memory.targetBuilding = null; // Clear target after successful build
    } else {
      // If action failed for some other reason (e.g. invalid spot), PASS
      break;
    }
  }

  // ---- SONAR (scout) ----
  for (const son of w.buildings.filter((b) => b.owner === ai && b.type === 'sonar' && !b.destroyed && !b.disabled && b.cooldownLeft === 0 && w.turn >= b.operationalTurn)) {
    void son;
    const target = bestScanAnchor(w, ai, memory, 3, actualWeights);
    if (target) apply({ type: 'sonar', buildingId: son.id, x: target.x, y: target.y });
  }

  // ---- FIRE PHASE ----
  // snapshot of ready weapons (ids are stable across the engine's internal clones)
  const ready = w.buildings
    .filter((b) => {
      const def = buildingDef(b.type);
      return (
        b.owner === ai &&
        def.category === 'weapon' &&
        !b.destroyed &&
        !b.disabled &&
        w.turn >= b.operationalTurn &&
        b.cooldownLeft === 0
      );
    })
    .map((b) => ({ id: b.id, type: b.type }));

  for (const wpn of ready) {
    if (wpn.type !== 'nuclear' && rng.next() > fireProb) continue; // lower difficulties hold fire sometimes
    const know = serializeForPlayer(w, ai);
    const def = buildingDef(wpn.type);
    const aw = def.attackW ?? 1;
    const ah = def.attackH ?? 1;
    void aw;
    void ah;
    const target = chooseTarget(w, know, ai, wpn.type, memory, rng, aggressive, skill, actualWeights);
    if (!target) continue; // no worthwhile target for this weapon; try the next
    if (apply({ type: 'fire', buildingId: wpn.id, x: target.x, y: target.y, rot: target.rot })) {
      // learn from our own shots (hit/miss/destroyed) — legitimate intel, no fog cheat
      recordShotResults(lastEvents, memory, w.map.width);
    }
  }

  plan.push({ type: 'endTurn' });
  return plan;
}

// choose the highest-value 3x3 or 5x5 anchor for scans
function bestScanAnchor(
  s: GameState,
  ai: number,
  memory: AiMemory,
  size: number,
  weights: AiWeights = DEFAULT_AI_WEIGHTS,
): Vec | null {
  const know = serializeForPlayer(s, ai);
  let best: Vec | null = null;
  let bestV = 0;
  for (let y = 0; y <= s.map.height - size; y++) {
    for (let x = 0; x <= s.map.width - size; x++) {
      let v = 0;
      for (let dy = 0; dy < size; dy++)
        for (let dx = 0; dx < size; dx++) v += cellValue(s, know, ai, x + dx, y + dy, memory, weights);
      if (v > bestV) {
        bestV = v;
        best = { x, y };
      }
    }
  }
  return best;
}

function cellValue(
  s: GameState,
  know: GameState,
  ai: number,
  x: number,
  y: number,
  memory: AiMemory,
  weights: AiWeights = DEFAULT_AI_WEIGHTS,
): number {
  const W = s.map.width;
  if (x < 0 || y < 0 || x >= W || y >= s.map.height) return 0;
  const ci = y * W + x;
  if (memory.destroyed.includes(ci)) return -100;
  if (memory.misses.includes(ci)) return -100;
  const t = terrainAt(s, x, y);
  if (t === 'irradiated' || t === 'deep' || t === 'reef' || t === 'rubble') return 0;

  const terr = territoryAt(s, x, y);
  // never waste ammo on an eliminated commander's field
  if (terr >= 0 && terr !== ai && !s.players[terr]?.alive) return 0;
  const isEnemyTerr = terr >= 0 && terr !== ai;

  // a cell we already struck (occupied, not yet destroyed) — finish it off
  if (memory.hits.includes(ci)) return weights.hitCellVal;

  // structure detected by our own radar/sonar
  const known = buildingAt(know, x, y);
  if (known && known.b.owner !== ai && !known.cell.destroyed && s.players[known.b.owner]?.alive) {
    if (known.b.type === 'base') return weights.knownBaseVal;
    if (known.b.type === 'powerplant' || known.b.type === 'research' || known.b.type === 'nuclear') return weights.knownEcoVal;
    if (known.b.type === 'radar') return weights.knownRadarVal;
    return 60;
  }
  if (!isEnemyTerr) return 0; // neutral / own land: never worth a shell

  // unknown enemy-territory land: parity search + adjacency to detected/struck cells (target mode)
  let v = weights.baseScanVal;
  if ((x + y) % 2 === 0) v += weights.parityBonus;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= s.map.height) continue;
    const nb = buildingAt(know, nx, ny);
    if ((nb && nb.b.owner !== ai && !nb.cell.destroyed) || memory.hits.includes(ny * W + nx)) v += weights.adjacentHitBonus;
  }
  return v;
}

// pick the best footprint anchor for a weapon, or null if nothing is worth shooting
function chooseTarget(
  w: GameState,
  know: GameState,
  ai: number,
  type: BuildingType,
  memory: AiMemory,
  rng: Rng,
  aggressive: boolean,
  skill = 1,
  weights: AiWeights = DEFAULT_AI_WEIGHTS,
): { x: number; y: number; rot?: 0 | 1 } | null {
  const def = buildingDef(type);
  const rawW = def.attackW ?? 1;
  const rawH = def.attackH ?? 1;

  if (type === 'nuclear') {
    let best: { x: number; y: number; rot?: 0 | 1 } | null = null;
    let bestV = 0;
    for (let y = 0; y <= w.map.height - 3; y++) {
      for (let x = 0; x <= w.map.width - 3; x++) {
        if (!canTargetAt(w, ai, x, y, 3, 3)) continue;
        let v = 0;
        let knownHits = 0;
        for (let dy = 0; dy < 3; dy++)
          for (let dx = 0; dx < 3; dx++) {
            const cv = cellValue(w, know, ai, x + dx, y + dy, memory, weights);
            v += cv;
            if (cv >= 60) knownHits++;
          }
        // only spend a nuke on a confirmed structure (or, late & aggressive, a hot guess)
        if ((knownHits >= 1 || (aggressive && w.turn > 20 && v > 100)) && v > bestV) {
          bestV = v;
          best = { x, y, rot: 0 };
        }
      }
    }
    return best;
  }

  const canRot = rawW !== rawH;
  const rots: (0 | 1)[] = canRot ? [0, 1] : [0];

  let best: { x: number; y: number; rot?: 0 | 1 } | null = null;
  let bestV = 0;

  for (const r of rots) {
    const aw = r === 1 ? rawH : rawW;
    const ah = r === 1 ? rawW : rawH;

    for (let y = 0; y <= w.map.height - ah; y++) {
      for (let x = 0; x <= w.map.width - aw; x++) {
        if (!canTargetAt(w, ai, x, y, aw, ah)) continue;
        let base = 0;
        for (let dy = 0; dy < ah; dy++)
          for (let dx = 0; dx < aw; dx++) base += Math.max(0, cellValue(w, know, ai, x + dx, y + dy, memory, weights));
        // never fire at worthless ground (neutral land, dead fields, known-empty cells).
        // Aim-noise (lower skill = sloppier) only scrambles the ranking among REAL candidates.
        if (base <= 0) continue;
        const noisy = base + rng.next() * (0.4 + (1 - skill) * 45);
        if (noisy > bestV) {
          bestV = noisy;
          best = { x, y, rot: r };
        }
      }
    }
  }
  return best;
}

function collectMissCandidates(s: GameState, x: number, y: number, w: number, h: number): Vec[] {
  const out: Vec[] = [];
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++) {
      if (x + dx < s.map.width && y + dy < s.map.height) out.push({ x: x + dx, y: y + dy });
    }
  return out;
}
