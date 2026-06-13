import type { GameMap, MapArchetype, TerrainType } from './types';
import { MAP_H, MAP_W, MAX_TERRITORY, MIN_TERRITORY } from './constants';
import { makeRng, type Rng } from './rng';

export const ARCHETYPES: MapArchetype[] = ['twin', 'atolls', 'ring', 'bay', 'archipelago'];
export const ARCHETYPE_NAMES: Record<MapArchetype, string> = {
  twin: 'Twin Continents',
  atolls: 'Scattered Atolls',
  ring: 'The Ring',
  bay: 'Fractured Bay',
  archipelago: 'Archipelago',
};

export const idx = (w: number, x: number, y: number) => y * w + x;
const inB = (w: number, h: number, x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;

function fade(t: number) {
  return t * t * (3 - 2 * t);
}

// Bilinear value noise over a coarse random grid.
function valueNoise(rng: Rng, w: number, h: number, cell: number): number[] {
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const grid = new Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
  const out = new Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = x / cell;
      const gy = y / cell;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const tx = fade(gx - x0);
      const ty = fade(gy - y0);
      const v00 = grid[y0 * gw + x0];
      const v10 = grid[y0 * gw + x0 + 1];
      const v01 = grid[(y0 + 1) * gw + x0];
      const v11 = grid[(y0 + 1) * gw + x0 + 1];
      const a = v00 + (v10 - v00) * tx;
      const b = v01 + (v11 - v01) * tx;
      out[y * w + x] = a + (b - a) * ty;
    }
  }
  return out;
}

function fbm(rng: Rng, w: number, h: number, octaves: number, startCell: number): number[] {
  const out = new Array(w * h).fill(0);
  let amp = 1;
  let tot = 0;
  let cell = startCell;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise(rng, w, h, cell);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    tot += amp;
    amp *= 0.5;
    cell = Math.max(2, cell / 2);
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}

function gauss(dx: number, dy: number, sigma: number) {
  return Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
}

function egauss(dx: number, dy: number, sx: number, sy: number) {
  return Math.exp(-((dx * dx) / (2 * sx * sx) + (dy * dy) / (2 * sy * sy)));
}

function hash01(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 1013904223) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

// ---------------- terrain ----------------
function generateTerrain(rng: Rng, w: number, h: number, archetype: MapArchetype): TerrainType[] {
  const noise = fbm(rng, w, h, 4, 7);
  const detail = fbm(rng, w, h, 3, 3);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const maxR = Math.min(w, h) / 2;

  const archipelagoCenters = [
    [5.5, 5.3, 3.2, 2.6],
    [14.5, 4.7, 2.8, 2.2],
    [23.4, 5.8, 3.2, 2.5],
    [8.4, 11.8, 3.4, 2.6],
    [20.6, 11.1, 3.5, 2.7],
    [4.7, 17.3, 2.8, 2.2],
    [13.4, 17.6, 3.3, 2.5],
    [24.1, 17.8, 2.9, 2.3],
    [8.1, 24.1, 3.1, 2.4],
    [18.5, 24.8, 3.2, 2.5],
    [25.3, 25.1, 2.5, 2],
    [2.9, 24.8, 2.3, 1.8],
    [11.4, 8.2, 1.9, 1.5],
    [17.6, 8.7, 2.1, 1.6],
    [22.2, 22.5, 1.8, 1.4],
  ] as const;

  const atollCenters = [
    [5.8, 5.8, 2.7],
    [15, 5.2, 2.6],
    [24.1, 6.8, 2.5],
    [8.1, 15.5, 2.8],
    [21.7, 15.4, 2.8],
    [5.8, 24.1, 2.5],
    [15.3, 23.4, 2.7],
    [24.1, 24.1, 2.5],
  ] as const;

  // raw heightfield
  const v = new Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const n = noise[i];
      const d = detail[i];
      const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
      const edgeFactor = Math.min(1, edge / 1.7);

      let shape = 0;
      let seaLevel = 0.5;
      let noiseW = 0.45;

      if (archetype === 'twin') {
        const left = egauss(x - w * 0.28, y - h * 0.5, w * 0.18, h * 0.34);
        const right = egauss(x - w * 0.72, y - h * 0.5, w * 0.18, h * 0.34);
        const strait = Math.exp(-((x - cx) * (x - cx)) / (2 * (w * 0.055) * (w * 0.055)));
        shape = Math.max(left, right) - strait * 0.42;
        seaLevel = 0.31;
        noiseW = 0.24;
      } else if (archetype === 'atolls') {
        let rings = 0;
        for (const [ax, ay, radius] of atollCenters) {
          const dist = Math.hypot(x - ax, y - ay);
          const ring = Math.exp(-((dist - radius) * (dist - radius)) / (2 * 0.85 * 0.85));
          const cap = gauss(x - ax, y - ay, radius * 0.72);
          rings = Math.max(rings, ring + cap * 0.04);
        }
        shape = rings;
        seaLevel = 0.62;
        noiseW = 0.06;
      } else if (archetype === 'ring') {
        const dn = Math.hypot(x - cx, y - cy) / maxR;
        const ring = 1 - Math.abs(dn - 0.68) / 0.38;
        shape = Math.max(0, ring);
        seaLevel = 0.34;
        noiseW = 0.34;
      } else if (archetype === 'archipelago') {
        let islands = 0;
        for (let k = 0; k < archipelagoCenters.length; k++) {
          const [ix, iy, sx, sy] = archipelagoCenters[k];
          const jx = (hash01(k, 3, 19) - 0.5) * 0.9;
          const jy = (hash01(k, 7, 23) - 0.5) * 0.9;
          islands = Math.max(islands, egauss(x - ix - jx, y - iy - jy, sx, sy));
        }
        shape = islands;
        seaLevel = 0.63;
        noiseW = 0.1;
      } else {
        // Horseshoe coastal strip around a wide central bay
        const armW = w * 0.14; // width of the coastal arms
        const topY = h * 0.22; // where the top strip sits
        const botY = h * 0.92; // how far the arms reach
        // top connecting strip
        const topStrip = egauss(x - cx, y - topY, w * 0.38, h * 0.08);
        // left arm
        const leftArm = egauss(x - w * 0.18, y - h * 0.55, armW, h * 0.34);
        // right arm
        const rightArm = egauss(x - w * 0.82, y - h * 0.55, armW, h * 0.34);
        // rounded corners linking top strip to arms
        const tlCorner = gauss(x - w * 0.26, y - h * 0.3, w * 0.1);
        const trCorner = gauss(x - w * 0.74, y - h * 0.3, w * 0.1);
        // bottom tips of arms get wider for territory space
        const blTip = egauss(x - w * 0.22, y - h * 0.82, w * 0.12, h * 0.1);
        const brTip = egauss(x - w * 0.78, y - h * 0.82, w * 0.12, h * 0.1);
        shape = Math.max(topStrip, leftArm, rightArm, tlCorner, trCorner, blTip, brTip);
        seaLevel = 0.38;
        noiseW = 0.2;
      }
      v[i] = (n * noiseW + shape * (1 - noiseW)) * edgeFactor - seaLevel;
    }
  }

  const terrain: TerrainType[] = new Array(w * h);
  for (let i = 0; i < w * h; i++) terrain[i] = v[i] > 0 ? 'land' : 'deep';

  // mountains: highest interior land via quantile threshold
  const landVals: number[] = [];
  for (let i = 0; i < w * h; i++) if (terrain[i] === 'land') landVals.push(v[i]);
  landVals.sort((a, b) => b - a);
  const mtnThreshold = landVals[Math.max(0, Math.floor(landVals.length * 0.05) - 1)] ?? Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (terrain[i] !== 'land' || v[i] < mtnThreshold) continue;
      let interior = true;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        if (!inB(w, h, x + dx, y + dy) || terrain[idx(w, x + dx, y + dy)] === 'deep') {
          interior = false;
          break;
        }
      }
      if (interior) terrain[i] = 'mountain';
    }
  }

  // reefs: shallow water near coasts
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(w, x, y);
      if (terrain[i] !== 'deep') continue;
      let nearLand = false;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [-1, -1],
        [1, -1],
        [-1, 1],
      ]) {
        if (inB(w, h, x + dx, y + dy)) {
          const t = terrain[idx(w, x + dx, y + dy)];
          if (t === 'land' || t === 'mountain') {
            nearLand = true;
            break;
          }
        }
      }
      if (!nearLand) continue;
      const reefChance = archetype === 'atolls' || archetype === 'archipelago' ? 0.72 : archetype === 'bay' ? 0.58 : 0.45;
      if (hash01(x, y, 431) < reefChance) terrain[i] = 'reef';
    }
  }

  return terrain;
}

// Does a region contain at least one fully-owned 2×2 land block (so a Base can deploy)?
function hasBaseSpot(terrain: TerrainType[], territory: number[], w: number, h: number, player: number) {
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      let ok = true;
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const i = idx(w, x + dx, y + dy);
        if (terrain[i] !== 'land' || territory[i] !== player) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
  }
  return false;
}

type MaskCell = { x: number; y: number };
type TerritoryAnchor = { x: number; y: number };

function generateOrganicMask(rng: Rng, targetSize: number, isIsland: boolean): MaskCell[] {
  const mask = new Set<string>();
  const out: MaskCell[] = [];
  
  const add = (x: number, y: number) => {
    const k = `${x},${y}`;
    if (!mask.has(k)) {
      mask.add(k);
      out.push({ x, y });
    }
  };
  
  add(0, 0); add(1, 0); add(0, 1); add(1, 1);
  const dirs = [[1,0], [-1,0], [0,1], [0,-1]];
  
  while (out.length < targetSize) {
    let bestX = 0, bestY = 0, bestScore = -Infinity;
    // Island mode evaluates fewer candidates (more branchy/random), Compact mode evaluates more (rounder)
    const attempts = isIsland ? 3 : 8;
    
    for (let i = 0; i < attempts; i++) {
      const c = out[Math.floor(rng.next() * out.length)];
      const d = dirs[Math.floor(rng.next() * dirs.length)];
      const nx = c.x + d[0];
      const ny = c.y + d[1];
      const k = `${nx},${ny}`;
      
      if (!mask.has(k)) {
        const distSq = nx * nx + ny * ny;
        // Compact: penalize distance from center heavily. Island: add more noise, penalize distance less.
        let score = isIsland 
          ? hash01(nx, ny, 42) * 20 - distSq * 0.5 
          : hash01(nx, ny, 42) * 5 - distSq;
        
        if (score > bestScore) {
          bestScore = score;
          bestX = nx;
          bestY = ny;
        }
      }
    }
    if (bestScore !== -Infinity) {
      add(bestX, bestY);
    }
  }
  return out;
}

function territoryAnchors(archetype: MapArchetype, numPlayers: number): TerritoryAnchor[] {
  if (archetype === 'twin') {
    if (numPlayers === 2) return [{ x: 8, y: 15 }, { x: 21, y: 15 }];
    if (numPlayers === 3) return [{ x: 8, y: 8 }, { x: 8, y: 21 }, { x: 21, y: 15 }];
    return [{ x: 8, y: 8 }, { x: 8, y: 21 }, { x: 21, y: 21 }, { x: 21, y: 8 }];
  }

  if (archetype === 'ring') {
    if (numPlayers === 2) return [{ x: 8, y: 8 }, { x: 21, y: 21 }];
    if (numPlayers === 3) return [{ x: 8, y: 8 }, { x: 21, y: 8 }, { x: 15, y: 22 }];
    return [{ x: 8, y: 8 }, { x: 21, y: 8 }, { x: 21, y: 21 }, { x: 8, y: 21 }];
  }

  if (archetype === 'archipelago' || archetype === 'atolls') {
    if (numPlayers === 2) return [{ x: 6, y: 6 }, { x: 23, y: 23 }];
    if (numPlayers === 3) return [{ x: 6, y: 6 }, { x: 23, y: 6 }, { x: 14, y: 23 }];
    return [{ x: 6, y: 6 }, { x: 23, y: 6 }, { x: 23, y: 23 }, { x: 6, y: 23 }];
  }

  if (archetype === 'bay') {
    // All territories along the horseshoe strip
    if (numPlayers === 2) return [{ x: 5, y: 16 }, { x: 24, y: 16 }];
    if (numPlayers === 3) return [{ x: 15, y: 6 }, { x: 5, y: 22 }, { x: 24, y: 22 }];
    return [{ x: 9, y: 6 }, { x: 20, y: 6 }, { x: 24, y: 22 }, { x: 5, y: 22 }];
  }

  if (numPlayers === 2) return [{ x: 8, y: 11 }, { x: 21, y: 11 }];
  if (numPlayers === 3) return [{ x: 8, y: 8 }, { x: 21, y: 8 }, { x: 15, y: 22 }];
  return [{ x: 8, y: 8 }, { x: 21, y: 8 }, { x: 21, y: 21 }, { x: 8, y: 21 }];
}

function partitionIdentical(
  terrain: TerrainType[],
  w: number,
  h: number,
  archetype: MapArchetype,
  numPlayers: number,
  rng: Rng,
): { territory: number[]; size: number } {
  const territory = new Array(w * h).fill(-1);
  const isIsland = archetype === 'archipelago' || archetype === 'atolls';
  const mask = generateOrganicMask(rng, MAX_TERRITORY - 4, isIsland);
  const anchors = territoryAnchors(archetype, numPlayers);
  const occupied = new Set<number>();
  const stamped: number[][] = [];

  for (let p = 0; p < numPlayers; p++) {
    const anchor = anchors[p];
    if (!anchor) return { territory, size: 0 };
    const cells: number[] = [];

    for (const c of mask) {
      const x = anchor.x + c.x;
      const y = anchor.y + c.y;
      if (!inB(w, h, x, y)) return { territory, size: 0 };
      const i = idx(w, x, y);
      if (occupied.has(i)) return { territory, size: 0 };
      occupied.add(i);
      cells.push(i);
    }
    stamped.push(cells);
  }

  for (let p = 0; p < stamped.length; p++) {
    for (const i of stamped[p]) {
      territory[i] = p;
      terrain[i] = 'land';
    }
  }

  return { territory, size: mask.length };
}

function buildOnce(seed: number, archetype: MapArchetype, numPlayers: number, minTerr: number): GameMap | null {
  const rng = makeRng(seed);
  const terrain = generateTerrain(rng, MAP_W, MAP_H, archetype);
  const { territory, size } = partitionIdentical(terrain, MAP_W, MAP_H, archetype, numPlayers, rng);
  if (size < minTerr) return null;
  for (let p = 0; p < numPlayers; p++) {
    if (!hasBaseSpot(terrain, territory, MAP_W, MAP_H, p)) return null;
  }
  return {
    width: MAP_W,
    height: MAP_H,
    seed,
    archetype,
    terrain,
    territory,
    numPlayers,
    territorySize: size,
  };
}

// Deterministic: identical (seed, archetype, numPlayers) -> identical map for every player.
export function generateMap(
  seed: number,
  archetypeIn: MapArchetype | 'random',
  numPlayers: number,
): GameMap {
  const archetype: MapArchetype =
    archetypeIn === 'random' ? ARCHETYPES[seed % ARCHETYPES.length] : archetypeIn;

  const minTerr = numPlayers <= 2 ? MIN_TERRITORY : numPlayers === 3 ? 52 : 44;
  const relaxed = numPlayers <= 2 ? 44 : numPlayers === 3 ? 38 : 30;

  for (let attempt = 0; attempt < 48; attempt++) {
    const s = (seed + attempt * 0x9e3779b1) >>> 0 || 1;
    const map = buildOnce(s, archetype, numPlayers, minTerr);
    if (map) {
      map.seed = seed;
      return map;
    }
  }
  for (let attempt = 0; attempt < 64; attempt++) {
    const s = (seed + attempt * 0x85ebca77) >>> 0 || 1;
    const map = buildOnce(s, archetype, numPlayers, relaxed);
    if (map) {
      map.seed = seed;
      return map;
    }
  }
  // absolute fallback (should never hit)
  const rng = makeRng(seed);
  const terrain = generateTerrain(rng, MAP_W, MAP_H, 'twin');
  const { territory, size } = partitionIdentical(terrain, MAP_W, MAP_H, 'twin', numPlayers, rng);
  return { width: MAP_W, height: MAP_H, seed, archetype, terrain, territory, numPlayers, territorySize: size };
}

export function isLand(t: TerrainType) {
  return t === 'land';
}
export function isWater(t: TerrainType) {
  return t === 'deep' || t === 'reef';
}
