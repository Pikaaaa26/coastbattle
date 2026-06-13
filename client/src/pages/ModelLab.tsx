import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { Building, BuildingCell, BuildingType, GameEvent, GameMap, GameState, MapArchetype, TerrainType, Vec } from '@shared/types';
import { BUILDINGS, FACTIONS, PALETTE } from '@shared/constants';
import { serializeForPlayer } from '@shared/engine';
import { ARCHETYPE_NAMES, ARCHETYPES, generateMap } from '@shared/map';
import { BoardRenderer } from '../game/renderer';
import { BuildingIcon } from '../components/BuildingIcon';
import { sfx } from '../audio/sfx';

type StrikeTool = 'missile' | 'artillery' | 'napalm' | 'nuke' | 'sonar';
type LabMapId = 'testRange' | MapArchetype;

const STRIKES: Record<StrikeTool, { label: string; w: number; h: number; desc: string; source?: BuildingType }> = {
  missile: { label: 'Missile', w: 1, h: 1, desc: 'Single-cell impact', source: 'silo' },
  artillery: { label: 'Artillery', w: 2, h: 2, desc: '2x2 blast test', source: 'artillery' },
  napalm: { label: 'Napalm', w: 3, h: 1, desc: 'Rotatable fire line', source: 'napalm' },
  nuke: { label: 'Nuke', w: 3, h: 3, desc: '3x3 irradiating strike', source: 'nuclear' },
  sonar: { label: 'Sonar', w: 3, h: 3, desc: 'Non-destructive ping' },
};

type LabBuildingSpec = { type: BuildingType; x: number; y: number; owner: 0 | 1 };
const LAB_SEED = 424242;
const LAB_MAP_OPTIONS: { id: LabMapId; label: string }[] = [
  { id: 'testRange', label: 'Lab Test Range' },
  ...ARCHETYPES.map((id) => ({ id, label: ARCHETYPE_NAMES[id] })),
];
const TEST_RANGE_BOUNDS: Record<0 | 1, { minX: number; maxX: number; minY: number; maxY: number }> = {
  0: { minX: 2, maxX: 14, minY: 2, maxY: 15 },
  1: { minX: 17, maxX: 27, minY: 2, maxY: 15 },
};

const LAB_BUILDINGS: LabBuildingSpec[] = ([
  { type: 'base', x: 3, y: 3 },
  { type: 'powerplant', x: 6, y: 3 },
  { type: 'research', x: 10, y: 3 },
  { type: 'radar', x: 11, y: 5 },
  { type: 'silo', x: 3, y: 7 },
  { type: 'napalm', x: 5, y: 7 },
  { type: 'artillery', x: 8, y: 7 },
  { type: 'shield', x: 11, y: 8 },
  { type: 'turret', x: 13, y: 8 },
  { type: 'sonar', x: 11, y: 11 },
  { type: 'repair', x: 8, y: 11 },
  { type: 'jammer', x: 3, y: 12 },
  { type: 'nuclear', x: 4, y: 11 },
] as { type: BuildingType; x: number; y: number }[]).map((b) => ({ ...b, owner: 0 as const }));

const ENEMY_LAB_BUILDINGS: LabBuildingSpec[] = [
  { type: 'base', x: 21, y: 3, owner: 1 },
  { type: 'powerplant', x: 18, y: 3, owner: 1 },
  { type: 'research', x: 24, y: 6, owner: 1 },
  { type: 'shield', x: 19, y: 7, owner: 1 },
  { type: 'jammer', x: 23, y: 8, owner: 1 },
  { type: 'radar', x: 25, y: 9, owner: 1 },
  { type: 'repair', x: 21, y: 9, owner: 1 },
  { type: 'turret', x: 20, y: 10, owner: 1 },
  { type: 'sonar', x: 24, y: 11, owner: 1 },
  { type: 'silo', x: 18, y: 11, owner: 1 },
  { type: 'artillery', x: 21, y: 12, owner: 1 },
  { type: 'napalm', x: 18, y: 13, owner: 1 },
];

const ALL_LAB_BUILDINGS = [...LAB_BUILDINGS, ...ENEMY_LAB_BUILDINGS];

function cellIndex(w: number, x: number, y: number) {
  return y * w + x;
}

function inBounds(state: GameState, x: number, y: number) {
  return x >= 0 && y >= 0 && x < state.map.width && y < state.map.height;
}

function footprint(x: number, y: number, w: number, h: number): Vec[] {
  const cells: Vec[] = [];
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) cells.push({ x: x + dx, y: y + dy });
  return cells;
}

function labMapLabel(id: LabMapId) {
  return id === 'testRange' ? 'Lab Test Range' : ARCHETYPE_NAMES[id];
}

function labIntroText(id: LabMapId) {
  return `${labMapLabel(id)} loaded. Enemy test range is fogged; sonar can reveal unjammed structures.`;
}

function makeTestRangeMap(): GameMap {
  const width = 30;
  const height = 18;
  const terrain = new Array<TerrainType>(width * height).fill('deep');

  for (let y = 2; y <= 15; y++) {
    for (let x = 2; x <= 14; x++) {
      terrain[cellIndex(width, x, y)] = 'land';
    }
    for (let x = 17; x <= 27; x++) {
      terrain[cellIndex(width, x, y)] = 'land';
    }
  }

  // Harbor cut, shallow edges, and a small mountain/ridge section for environmental read.
  for (let y = 2; y <= 15; y++) for (let x = 15; x <= 16; x++) terrain[cellIndex(width, x, y)] = 'deep';
  for (let y = 11; y <= 15; y++) for (let x = 25; x <= 27; x++) terrain[cellIndex(width, x, y)] = 'mountain';
  terrain[cellIndex(width, 24, 13)] = 'mountain';
  terrain[cellIndex(width, 24, 14)] = 'mountain';
  terrain[cellIndex(width, 15, 13)] = 'reef';
  terrain[cellIndex(width, 15, 14)] = 'reef';
  terrain[cellIndex(width, 16, 14)] = 'reef';

  const copy = [...terrain];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = cellIndex(width, x, y);
      if (copy[i] !== 'deep') continue;
      const nearLand = footprint(x - 1, y - 1, 3, 3).some((c) => {
        if (c.x === x && c.y === y) return false;
        const t = copy[cellIndex(width, c.x, c.y)];
        return t === 'land' || t === 'mountain';
      });
      if (nearLand) terrain[i] = 'reef';
    }
  }

  for (const p of ALL_LAB_BUILDINGS) {
    const def = BUILDINGS[p.type];
    for (const c of footprint(p.x, p.y, def.w, def.h)) terrain[cellIndex(width, c.x, c.y)] = 'land';
  }

  const territory = terrain.map((t, i) => {
    if (t !== 'land') return -1;
    const x = i % width;
    if (x <= 14) return 0;
    if (x >= 17) return 1;
    return -1;
  });
  for (const p of ALL_LAB_BUILDINGS) {
    const def = BUILDINGS[p.type];
    for (const c of footprint(p.x, p.y, def.w, def.h)) territory[cellIndex(width, c.x, c.y)] = p.owner;
  }
  return {
    width,
    height,
    seed: LAB_SEED,
    archetype: 'bay',
    terrain,
    territory,
    numPlayers: 2,
    territorySize: territory.filter((t) => t === 0).length,
  };
}

function terrainBounds(map: GameMap, owner: 0 | 1) {
  let minX = map.width;
  let maxX = 0;
  let minY = map.height;
  let maxY = 0;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (map.territory[cellIndex(map.width, x, y)] !== owner) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return minX <= maxX ? { minX, maxX, minY, maxY } : { minX: 0, maxX: map.width - 1, minY: 0, maxY: map.height - 1 };
}

function placementTarget(map: GameMap, spec: LabBuildingSpec) {
  const source = TEST_RANGE_BOUNDS[spec.owner];
  const target = terrainBounds(map, spec.owner);
  const relX = (spec.x - source.minX) / Math.max(1, source.maxX - source.minX);
  const relY = (spec.y - source.minY) / Math.max(1, source.maxY - source.minY);
  return {
    x: Math.round(target.minX + relX * Math.max(0, target.maxX - target.minX)),
    y: Math.round(target.minY + relY * Math.max(0, target.maxY - target.minY)),
  };
}

function canPlaceLabBuilding(map: GameMap, occupied: Set<number>, spec: LabBuildingSpec, x: number, y: number) {
  const def = BUILDINGS[spec.type];
  for (const c of footprint(x, y, def.w, def.h)) {
    if (c.x < 0 || c.y < 0 || c.x >= map.width || c.y >= map.height) return false;
    const i = cellIndex(map.width, c.x, c.y);
    if (occupied.has(i) || map.terrain[i] !== 'land' || map.territory[i] !== spec.owner) return false;
  }
  return true;
}

function placeLabBuildings(map: GameMap, specs: LabBuildingSpec[]) {
  const occupied = new Set<number>();
  const placed: LabBuildingSpec[] = [];
  for (const spec of specs) {
    const def = BUILDINGS[spec.type];
    const target = placementTarget(map, spec);
    const candidates: { x: number; y: number; score: number }[] = [];
    for (let y = 0; y <= map.height - def.h; y++) {
      for (let x = 0; x <= map.width - def.w; x++) {
        if (!canPlaceLabBuilding(map, occupied, spec, x, y)) continue;
        const cx = x + (def.w - 1) / 2;
        const cy = y + (def.h - 1) / 2;
        candidates.push({ x, y, score: (cx - target.x) ** 2 + (cy - target.y) ** 2 });
      }
    }
    candidates.sort((a, b) => a.score - b.score || a.y - b.y || a.x - b.x);
    const best = candidates[0];
    if (!best) continue;
    const next = { ...spec, x: best.x, y: best.y };
    placed.push(next);
    for (const c of footprint(best.x, best.y, def.w, def.h)) occupied.add(cellIndex(map.width, c.x, c.y));
  }
  return placed;
}

function makeLabMap(id: LabMapId) {
  if (id === 'testRange') {
    return { map: makeTestRangeMap(), specs: ALL_LAB_BUILDINGS };
  }
  const map = generateMap(LAB_SEED, id, 2);
  return { map, specs: placeLabBuildings(map, ALL_LAB_BUILDINGS) };
}

function makeBuilding(type: BuildingType, x: number, y: number, owner: number, id: number): Building {
  const def = BUILDINGS[type];
  const cells: BuildingCell[] = footprint(x, y, def.w, def.h).map((c) => ({
    x: c.x,
    y: c.y,
    hp: def.hpPerCell,
    maxHp: def.hpPerCell,
    shield: 0,
    destroyed: false,
  }));
  return {
    id: `lab_${type}_${id}`,
    type,
    owner,
    x,
    y,
    w: def.w,
    h: def.h,
    cells,
    cooldownLeft: 0,
    builtTurn: 0,
    operationalTurn: 0,
    disabled: false,
    destroyed: false,
  };
}

function makeLabState(mapId: LabMapId = 'testRange'): GameState {
  const { map, specs } = makeLabMap(mapId);
  const f = FACTIONS[0];
  const e = FACTIONS[1];
  const state: GameState = {
    id: 'model-lab',
    seed: LAB_SEED,
    map,
    players: [
      {
        id: 'lab-player',
        index: 0,
        name: 'Model Lab',
        color: f.color,
        faction: f.id,
        energy: 99,
        alive: true,
        isAI: false,
        connected: true,
        hasPlacedBase: true,
        readyShots: 0,
        revealed: [],
        stats: {
          shotsFired: 0,
          hits: 0,
          buildingsBuilt: specs.filter((b) => b.owner === 0).length,
          buildingsLost: 0,
          energyEarned: 0,
          nukesLaunched: 0,
        },
      },
      {
        id: 'lab-enemy',
        index: 1,
        name: 'Enemy Test Range',
        color: e.color,
        faction: e.id,
        energy: 99,
        alive: true,
        isAI: true,
        connected: true,
        hasPlacedBase: true,
        readyShots: 0,
        revealed: [],
        stats: {
          shotsFired: 0,
          hits: 0,
          buildingsBuilt: specs.filter((b) => b.owner === 1).length,
          buildingsLost: 0,
          energyEarned: 0,
          nukesLaunched: 0,
        },
      },
    ],
    buildings: specs.map((b, i) => makeBuilding(b.type, b.x, b.y, b.owner, i)),
    blockedUntil: new Array(map.width * map.height).fill(0),
    turn: 1,
    round: 1,
    turnOrder: [0, 1],
    currentPlayer: 0,
    phase: 'playing',
    winner: null,
    settings: { numPlayers: 2, mode: 'hotseat', turnCap: 999, fogOfWar: true, mapArchetype: map.archetype, difficulty: 'normal' },
    log: [{ turn: 1, player: -1, text: labIntroText(mapId), kind: 'system' }],
    viewerIndex: 0,
    fogged: true,
  };
  applyLabSystems(state);
  return state;
}

function livingCellAt(state: GameState, x: number, y: number): { b: Building; cell: BuildingCell } | null {
  for (const b of state.buildings) {
    if (b.destroyed) continue;
    for (const cell of b.cells) {
      if (!cell.destroyed && cell.x === x && cell.y === y) return { b, cell };
    }
  }
  return null;
}

function chebToBuilding(b: Building, x: number, y: number): number {
  let d = Infinity;
  for (const cell of b.cells) {
    if (cell.destroyed) continue;
    d = Math.min(d, Math.max(Math.abs(cell.x - x), Math.abs(cell.y - y)));
  }
  return d;
}

function applyLabSystems(state: GameState) {
  for (const b of state.buildings) {
    for (const cell of b.cells) cell.shield = 0;
  }
  for (const owner of [0, 1]) {
    const gens = state.buildings.filter(
      (b) => b.owner === owner && b.type === 'shield' && !b.destroyed && !b.disabled,
    );
    for (const b of state.buildings) {
      if (b.owner !== owner || b.destroyed) continue;
      for (const cell of b.cells) {
        if (cell.destroyed) continue;
        if (cell.shieldCooldown && cell.shieldCooldown > 0) continue;
        const covered = gens.some((g) => chebToBuilding(g, cell.x, cell.y) <= (BUILDINGS.shield.range ?? 0));
        cell.shield = covered ? 1 : 0;
      }
    }
  }
}

function labJammed(state: GameState, x: number, y: number, owner: number): boolean {
  return state.buildings.some(
    (b) =>
      b.owner === owner &&
      b.type === 'jammer' &&
      !b.destroyed &&
      !b.disabled &&
      chebToBuilding(b, x, y) <= (BUILDINGS.jammer.range ?? 0),
  );
}

function sourceFor(state: GameState, tool: StrikeTool): Vec {
  const sourceType = STRIKES[tool].source;
  if (!sourceType) return { x: -1, y: -1 };
  const b = state.buildings.find((candidate) => candidate.type === sourceType && !candidate.destroyed);
  return b ? { x: b.x, y: b.y } : { x: -1, y: -1 };
}

function strikeDims(tool: StrikeTool, rot: 0 | 1) {
  const s = STRIKES[tool];
  return rot ? { w: s.h, h: s.w } : { w: s.w, h: s.h };
}

function applyLabStrike(state: GameState, tool: StrikeTool, target: Vec, rot: 0 | 1): { next: GameState; events: GameEvent[]; summary: string } {
  const dims = strikeDims(tool, rot);
  const cells = footprint(target.x, target.y, dims.w, dims.h).filter((c) => inBounds(state, c.x, c.y));
  const hits = cells.filter((c) => livingCellAt(state, c.x, c.y)).map((c) => ({ x: c.x, y: c.y }));
  const from = sourceFor(state, tool);
  const events: GameEvent[] = [];

  if (tool === 'missile') {
    const to = cells[0] ?? target;
    events.push({ type: 'missile', player: 0, from, to, hit: hits.length > 0 });
  } else if (tool === 'artillery' || tool === 'napalm') {
    events.push({ type: tool, player: 0, from, cells, hits });
  } else if (tool === 'nuke') {
    events.push({ type: 'nuke', player: 0, from, center: { x: target.x + 1, y: target.y + 1 }, cells });
  } else {
    events.push({
      type: 'sonar',
      player: 0,
      center: { x: target.x + dims.w / 2, y: target.y + dims.h / 2 },
      cells: cells.map((c) => cellIndex(state.map.width, c.x, c.y)),
    });
  }

  if (tool === 'sonar') {
    const next = structuredClone(state) as GameState;
    next.turn++;
    const revealed: number[] = [];
    let jammed = 0;
    for (const c of cells) {
      const hit = livingCellAt(next, c.x, c.y);
      if (!hit || hit.b.owner === 0) continue;
      if (labJammed(next, c.x, c.y, hit.b.owner)) {
        jammed++;
        continue;
      }
      const ci = cellIndex(next.map.width, c.x, c.y);
      if (!next.players[0].revealed.includes(ci)) next.players[0].revealed.push(ci);
      revealed.push(ci);
    }
    if (revealed.length) events.push({ type: 'reveal', player: 0, cells: revealed });
    next.log = [
      ...next.log.slice(-18),
      { turn: next.turn, player: -1, text: `Sonar revealed ${revealed.length} cell(s); ${jammed} jammed.`, kind: 'detect' },
    ];
    return { next, events, summary: `Sonar revealed ${revealed.length} cell(s); ${jammed} jammed.` };
  }

  const next = structuredClone(state) as GameState;
  next.turn++;
  for (const b of next.buildings) {
    for (const cell of b.cells) {
      if (cell.shieldCooldown && cell.shieldCooldown > 0) {
        cell.shieldCooldown--;
      }
    }
  }
  for (const c of cells) {
    const i = cellIndex(next.map.width, c.x, c.y);
    if (tool === 'nuke' && next.map.terrain[i] !== 'deep') next.map.terrain[i] = 'irradiated';

    const hit = livingCellAt(next, c.x, c.y);
    if (hit) {
      if (hit.cell.shield > 0 && tool !== 'nuke') {
        hit.cell.shield = 0;
        events.push({ type: 'absorbed', x: c.x, y: c.y, owner: hit.b.owner });
        hit.cell.shieldCooldown = 2; // only the absorbed tile goes on cooldown
      } else {
        hit.cell.hp = 0;
        hit.cell.destroyed = true;
        if (tool !== 'nuke' && next.map.terrain[i] === 'land') next.map.terrain[i] = 'rubble';
        if (hit.b.cells.every((cell) => cell.destroyed)) {
          hit.b.destroyed = true;
          next.players[hit.b.owner].stats.buildingsLost++;
        }
      }
      next.players[0].stats.hits++;
    } else if (next.map.terrain[i] === 'land') {
      next.blockedUntil[i] = next.turn + 999;
    }
  }
  applyLabSystems(next);
  next.players[0].stats.shotsFired++;
  if (tool === 'nuke') next.players[0].stats.nukesLaunched++;
  next.log = [
    ...next.log.slice(-18),
    { turn: next.turn, player: -1, text: `${STRIKES[tool].label}: ${hits.length}/${cells.length} hits.`, kind: tool === 'nuke' ? 'nuke' : 'fire' },
  ];
  return { next, events, summary: `${STRIKES[tool].label}: ${hits.length}/${cells.length} hits.` };
}

export default function ModelLab() {
  const isMobile = window.innerWidth <= 760;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<BoardRenderer | null>(null);
  const panRef = useRef<{ x: number; y: number; moved: number; btn: number } | null>(null);
  const [mapId, setMapId] = useState<LabMapId>('testRange');
  const [truth, setTruth] = useState<GameState>(() => makeLabState());
  const [tool, setTool] = useState<StrikeTool>('missile');
  const [rot, setRot] = useState<0 | 1>(0);
  const [hover, setHover] = useState<Vec | null>(null);
  const [lastResult, setLastResult] = useState(labIntroText('testRange'));
  const view = useMemo(() => serializeForPlayer(truth, 0), [truth]);

  // Mobile: pick initial recommended position in enemy territory when tool changes
  useEffect(() => {
    if (isMobile && tool) {
      setHover({ x: 22, y: 8 });
    }
  }, [tool, rot, isMobile]);

  const dims = strikeDims(tool, rot);
  const rotatable = STRIKES[tool].w !== STRIKES[tool].h;
  const buildingStats = useMemo(
    () =>
      PALETTE.map((type) => {
        const b = truth.buildings.find((candidate) => candidate.owner === 0 && candidate.type === type);
        const live = b ? b.cells.filter((cell) => !cell.destroyed).length : 0;
        return { type, def: BUILDINGS[type], live, total: b?.cells.length ?? 0, destroyed: !b || b.destroyed };
      }),
    [truth],
  );

  useEffect(() => {
    if (!canvasRef.current) return;
    const renderer = new BoardRenderer(canvasRef.current);
    rendererRef.current = renderer;
    renderer.start();
    renderer.setView(view);
    return () => {
      renderer.stop();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setView(view);
  }, [view]);

  useEffect(() => {
    rendererRef.current?.setInteraction({
      mode: tool === 'sonar' ? 'sonar' : 'fire',
      attackW: dims.w,
      attackH: dims.h,
      rot,
      hover,
      myIndex: 0,
    });
  }, [dims.h, dims.w, hover, rot, tool]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'r' || e.key === 'R') setRot((r) => (r ? 0 : 1));
      else if (e.key === 'q' || e.key === 'Q') rendererRef.current?.rotateCamera(1);
      else if (e.key === 'e' || e.key === 'E') rendererRef.current?.rotateCamera(-1);
      else if (e.key === 'Escape') setHover(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const fireAt = (cell: Vec) => {
    const result = applyLabStrike(truth, tool, cell, rot);
    rendererRef.current?.ingest(result.events);
    setTruth(result.next);
    setLastResult(result.summary);
  };

  const onCanvasMove = (e: MouseEvent) => {
    if (panRef.current) {
      const dx = e.clientX - panRef.current.x;
      const dy = e.clientY - panRef.current.y;
      panRef.current.x = e.clientX;
      panRef.current.y = e.clientY;
      panRef.current.moved += Math.abs(dx) + Math.abs(dy);
      rendererRef.current?.pan(dx, dy);
      return;
    }
    setHover(rendererRef.current?.cellAt(e.clientX, e.clientY) ?? null);
  };

  const onPointerDown = (e: MouseEvent) => {
    if (e.button === 1 || e.button === 2) {
      panRef.current = { x: e.clientX, y: e.clientY, moved: 0, btn: e.button };
      e.preventDefault();
    }
  };

  const isOverElement = (clientX: number, clientY: number, selector: string) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  };

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      panRef.current = { x: touch.clientX, y: touch.clientY, moved: 0, btn: 0 };
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (panRef.current && e.touches.length === 1) {
      const touch = e.touches[0];
      const dx = touch.clientX - panRef.current.x;
      const dy = touch.clientY - panRef.current.y;
      panRef.current.x = touch.clientX;
      panRef.current.y = touch.clientY;
      panRef.current.moved += Math.abs(dx) + Math.abs(dy);
      if (isMobile) {
        if (
          isOverElement(touch.clientX, touch.clientY, '.lab-sidebar') ||
          isOverElement(touch.clientX, touch.clientY, '.lab-topbar') ||
          isOverElement(touch.clientX, touch.clientY, '.topnav')
        ) {
          return;
        }
        const c = rendererRef.current?.cellAt(touch.clientX, touch.clientY);
        if (c) {
          setHover(c);
        }
      } else {
        rendererRef.current?.pan(dx, dy);
      }
    }
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    if (panRef.current) {
      const wasDrag = panRef.current.moved > 10;
      panRef.current = null;
      if (!wasDrag && e.changedTouches.length === 1) {
        const touch = e.changedTouches[0];
        if (
          isOverElement(touch.clientX, touch.clientY, '.lab-sidebar') ||
          isOverElement(touch.clientX, touch.clientY, '.lab-topbar') ||
          isOverElement(touch.clientX, touch.clientY, '.topnav')
        ) {
          return;
        }
        const cell = rendererRef.current?.cellAt(touch.clientX, touch.clientY);
        if (cell) {
          if (isMobile) {
            setHover(cell);
          } else {
            fireAt(cell);
          }
        }
      }
    }
  };

  const changeMap = (nextMap: LabMapId) => {
    const fresh = makeLabState(nextMap);
    setMapId(nextMap);
    setTruth(fresh);
    setHover(null);
    setLastResult(labIntroText(nextMap));
    rendererRef.current?.resetCamera();
  };

  const resetLab = () => {
    const fresh = makeLabState(mapId);
    setTruth(fresh);
    setHover(null);
    setLastResult(`${labMapLabel(mapId)} reset. All models restored.`);
  };

  return (
    <div className="model-lab">
      <section className="lab-stage">
        <div className="lab-topbar">
          <div>
            <h1>Model Test Lab</h1>
            <p>Preview the low-poly map, inspect every building, and test bomb impacts before promoting changes deeper into play.</p>
          </div>
          <div className="lab-result">{lastResult}</div>
        </div>
        <div className="lab-canvas-wrap">
          <canvas
            ref={canvasRef}
            onMouseMove={onCanvasMove}
            onClick={(e) => {
              const cell = rendererRef.current?.cellAt(e.clientX, e.clientY);
              if (cell) {
                if (isMobile) {
                  setHover(cell);
                } else {
                  fireAt(cell);
                }
              }
            }}
            onMouseDown={onPointerDown}
            onMouseUp={() => {
              panRef.current = null;
            }}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            onMouseLeave={() => {
              panRef.current = null;
              setHover(null);
            }}
            onWheel={(e) => rendererRef.current?.adjustZoom(e.deltaY < 0 ? 1.12 : 0.9)}
            onContextMenu={(e) => e.preventDefault()}
          />
        </div>
      </section>

      <aside className="lab-sidebar">
        <div className="panel">
          <div className="panel-head">Map Preview</div>
          <div className="lab-map-picker">
            <label htmlFor="lab-map-select">Map</label>
            <select id="lab-map-select" className="select" value={mapId} onChange={(e) => changeMap(e.target.value as LabMapId)}>
              {LAB_MAP_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <small>
              {truth.map.width}x{truth.map.height} - {truth.map.territorySize} build cells per side
            </small>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">Strike Tools</div>
          <div className="lab-tool-grid">
            {(Object.keys(STRIKES) as StrikeTool[]).map((key) => (
              <button key={key} className={`lab-tool ${tool === key ? 'active' : ''}`} onClick={() => setTool(key)}>
                <span>{STRIKES[key].label}</span>
                <small>{STRIKES[key].desc}</small>
              </button>
            ))}
          </div>
          <div className="lab-actions">
            <button className="btn btn-sm" disabled={!rotatable} onClick={() => setRot((r) => (r ? 0 : 1))}>
              Rotate R
            </button>
            <button className="btn btn-sm" onClick={() => rendererRef.current?.resetCamera()}>
              Reset Camera
            </button>
            <button className="btn btn-sm btn-primary" onClick={resetLab}>
              Reset Lab
            </button>
          </div>
          {isMobile && hover && (
            <div style={{ padding: '0 8px 8px' }}>
              <button
                className="btn btn-primary btn-confirm-action"
                style={{ width: '100%', border: '2px solid var(--green)', background: '#113525', textShadow: '0 0 6px var(--green)' }}
                onClick={() => {
                  sfx.click();
                  fireAt(hover);
                }}
              >
                Confirm Strike ✓
              </button>
            </div>
          )}
          <p className="hint">Footprint: {dims.w}x{dims.h}. Right/middle drag pans. Wheel zooms. Q/E rotate camera.</p>
        </div>

        <div className="panel">
          <div className="panel-head">Building Readability</div>
          <div className="lab-building-list">
            {buildingStats.map(({ type, def, live, total, destroyed }) => (
              <div key={type} className={`lab-building ${destroyed ? 'destroyed' : ''}`}>
                <BuildingIcon type={type} size={34} color={FACTIONS[0].color} />
                <div>
                  <div>{def.name}</div>
                  <small>
                    {def.w}x{def.h} plot - {live}/{total} cells live
                  </small>
                </div>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
