// Coast Battle — shared game types. Pure data, fully JSON-serializable (no classes/methods on state).

export type Vec = { x: number; y: number };

export type TerrainType = 'deep' | 'land' | 'reef' | 'mountain' | 'irradiated' | 'rubble';

export type MapArchetype = 'twin' | 'atolls' | 'ring' | 'bay' | 'archipelago';

export interface GameMap {
  width: number;
  height: number;
  seed: number;
  archetype: MapArchetype;
  terrain: TerrainType[]; // length w*h, row-major (index = y*w + x)
  territory: number[]; // length w*h: owning player index, or -1 = neutral / not land
  numPlayers: number;
  territorySize: number; // equalized cell count per player
}

export type BuildingType =
  | 'base'
  | 'silo'
  | 'artillery'
  | 'napalm'
  | 'powerplant'
  | 'research'
  | 'nuclear'
  | 'radar'
  | 'sonar'
  | 'shield'
  | 'turret'
  | 'repair'
  | 'jammer';

export type BuildingCategory = 'hq' | 'economy' | 'weapon' | 'tech' | 'detection' | 'defense';

export interface BuildingDef {
  type: BuildingType;
  name: string;
  short: string; // 2-3 char code for compact UI/sprites
  w: number;
  h: number;
  cost: number;
  hpPerCell: number;
  category: BuildingCategory;
  requiresResearch: boolean;
  maxCount?: number; // per player
  cooldown?: number; // turns between fires/uses
  fireCost?: number; // energy to fire (weapons)
  energy?: number; // energy generated per turn
  attackW?: number; // weapon footprint width
  attackH?: number; // weapon footprint height
  range?: number; // radius for detection/defense (Chebyshev)
  interceptChance?: number; // turret
  irradiates?: boolean; // nuke
  desc: string;
  tagline: string;
}

export interface BuildingCell {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  shield: number; // temp hp from friendly shield generators (recharges each turn)
  destroyed: boolean;
  shieldCooldown?: number; // turns until this specific cell can be shielded again
}

export interface Building {
  id: string;
  type: BuildingType;
  owner: number; // player index
  x: number; // top-left
  y: number;
  w: number;
  h: number;
  cells: BuildingCell[];
  cooldownLeft: number;
  builtTurn: number;
  operationalTurn: number; // weapons can fire on/after this turn (build sickness)
  disabled: boolean; // advanced building with no living research station
  destroyed: boolean;
}

export type GameMode = 'ai' | 'hotseat' | 'duel' | 'ffa';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type GamePhase = 'deploy' | 'playing' | 'ended';

export interface PlayerStats {
  shotsFired: number;
  hits: number;
  buildingsBuilt: number;
  buildingsLost: number;
  energyEarned: number;
  nukesLaunched: number;
}

export interface PlayerState {
  id: string; // stable player id (token-linked online; synthetic offline)
  index: number; // 0..n-1
  name: string;
  color: string; // hex
  faction: string;
  energy: number;
  alive: boolean;
  isAI: boolean;
  connected: boolean;
  hasPlacedBase: boolean;
  readyShots: number;
  revealed: number[]; // scouted cell indices (enemy structures discovered)
  revealedAt?: Record<string, number>; // maps cellIndex to round revealed
  stats: PlayerStats;
}

export interface GameSettings {
  numPlayers: number;
  mode: GameMode;
  turnCap: number;
  fogOfWar: boolean;
  mapArchetype: MapArchetype | 'random';
  difficulty: Difficulty;
}

export interface LogEntry {
  turn: number;
  player: number; // -1 = system
  text: string;
  kind: string;
}

export interface GameState {
  id: string;
  seed: number;
  map: GameMap;
  players: PlayerState[];
  buildings: Building[];
  blockedUntil: number[]; // per cell: unbuildable while turn < value (shot craters)
  turn: number; // increments each player turn taken
  round: number; // full round counter
  turnOrder: number[]; // randomized turn sequence of player indices
  currentPlayer: number; // index whose turn it is
  phase: GamePhase;
  winner: number | null;
  settings: GameSettings;
  log: LogEntry[];
  visibleToEnemy?: number[]; // indices of own cells currently revealed/visible to any opponent
  // fog metadata (present on per-player serialized views):
  fogged?: boolean;
  viewerIndex?: number;
}

// ---- Actions (client -> engine) ----
export type Action =
  | { type: 'placeBase'; x: number; y: number }
  | { type: 'build'; building: BuildingType; x: number; y: number; rot?: 0 | 1 }
  | { type: 'fire'; buildingId: string; x: number; y: number; rot?: 0 | 1 }
  | { type: 'sonar'; buildingId: string; x: number; y: number }
  | { type: 'demolish'; buildingId: string }
  | { type: 'endTurn' }
  | { type: 'surrender' };

// ---- Events (engine -> client, for animation/feedback) ----
export type GameEvent =
  | { type: 'income'; player: number; amount: number; total: number }
  | { type: 'build'; player: number; building: BuildingType; x: number; y: number; w: number; h: number }
  | { type: 'missile'; player: number; from: Vec; to: Vec; hit: boolean; intercepted?: boolean; interceptedBy?: Vec | null }
  | { type: 'artillery'; player: number; from: Vec; cells: Vec[]; hits: Vec[] }
  | { type: 'napalm'; player: number; from: Vec; cells: Vec[]; hits: Vec[] }
  | { type: 'nuke'; player: number; from: Vec; center: Vec; cells: Vec[] }
  | { type: 'reveal'; player: number; cells: number[] }
  | { type: 'radar'; player: number; cells: number[] }
  | { type: 'sonar'; player: number; center: Vec; cells: number[] }
  | { type: 'cellDestroyed'; x: number; y: number; owner: number }
  | { type: 'destroyed'; buildingId: string; buildingType: BuildingType; owner: number; cells: Vec[] }
  | { type: 'eliminated'; player: number }
  | { type: 'absorbed'; x: number; y: number; owner: number } // shield ate a hit (public — shields announce themselves)
  | { type: 'repair'; cells: Vec[] }
  | { type: 'turn'; player: number; turn: number }
  | { type: 'win'; winner: number | null }
  | { type: 'message'; text: string };

export interface ApplyResult {
  ok: boolean;
  error?: string;
  state: GameState;
  events: GameEvent[];
}
