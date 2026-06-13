import { create } from 'zustand';
import type { BuildingType, GameState, Vec } from '@shared/types';
import { canTargetAt, validPlacements } from '@shared/engine';
import { buildingDef } from '@shared/constants';
import type { BaseSession } from '../game/session';
import { sfx } from '../audio/sfx';

export type ToolMode = 'idle' | 'placeBase' | 'build' | 'fire' | 'sonar';

interface ToolState {
  mode: ToolMode;
  buildingType?: BuildingType;
  buildingId?: string;
  attackW?: number;
  attackH?: number;
  rot?: 0 | 1;
}

interface GameStoreState {
  session: BaseSession | null;
  view: GameState | null;
  viewer: number;
  busy: boolean;
  passInfo: { player: number; name: string } | null;
  turnBanner: { player: number; isAI: boolean; t: number } | null;
  ended: { winner: number | null } | null;
  error: { text: string; t: number } | null;
  tool: ToolState;
  hover: Vec | null;
  validCells: Set<number>;

  bind: (session: BaseSession) => void;
  unbind: () => void;
  controllable: () => boolean;
  selectBuild: (type: BuildingType) => void;
  selectBase: () => void;
  selectWeapon: (buildingId: string) => void;
  rotateTool: () => void;
  clearTool: () => void;
  setHover: (cell: Vec | null) => void;
  click: (cell: Vec) => void;
  resumePass: () => void;
  flashError: (text: string) => void;
}

function computeValid(view: GameState | null, viewer: number, type: BuildingType, rot: 0 | 1 = 0): Set<number> {
  if (!view) return new Set();
  const spots = validPlacements(view, viewer, type, rot);
  return new Set(spots.map((s) => s.y * view.map.width + s.x));
}

function computeValidTargets(view: GameState | null, viewer: number, w: number, h: number, rot: 0 | 1 = 0): Set<number> {
  if (!view) return new Set();
  const aw = rot ? h : w;
  const ah = rot ? w : h;
  const out = new Set<number>();
  for (let y = 0; y <= view.map.height - ah; y++) {
    for (let x = 0; x <= view.map.width - aw; x++) {
      if (canTargetAt(view, viewer, x, y, aw, ah)) out.add(y * view.map.width + x);
    }
  }
  return out;
}

export const useGame = create<GameStoreState>((set, get) => ({
  session: null,
  view: null,
  viewer: 0,
  busy: false,
  passInfo: null,
  turnBanner: null,
  ended: null,
  error: null,
  tool: { mode: 'idle' },
  hover: null,
  validCells: new Set(),

  bind: (session) => {
    const offs: (() => void)[] = [];
    offs.push(
      session.on('view', ({ view, viewer }) => {
        set({ view, viewer, passInfo: null });
        // refresh valid cells if a placement tool is active
        const t = get().tool;
        if (t.mode === 'build' && t.buildingType) set({ validCells: computeValid(view, viewer, t.buildingType, t.rot ?? 0) });
        else if (t.mode === 'placeBase') set({ validCells: computeValid(view, viewer, 'base', t.rot ?? 0) });
        else if (t.mode === 'fire') set({ validCells: computeValidTargets(view, viewer, t.attackW ?? 1, t.attackH ?? 1, t.rot ?? 0) });
      }),
    );
    offs.push(session.on('busy', (b) => set({ busy: b, ...(b ? { tool: { mode: 'idle' }, validCells: new Set() } : {}) })));
    offs.push(
      session.on('pass', (info) => {
        set({ passInfo: info, busy: false, tool: { mode: 'idle' }, validCells: new Set() });
      }),
    );
    offs.push(
      session.on('turn', (info) => {
        const prev = get().turnBanner;
        if (!prev || prev.player !== info.player) {
          set({ turnBanner: { ...info, t: Date.now() } });
          if (!info.isAI) sfx.turnStart();
        }
      }),
    );
    offs.push(
      session.on('end', ({ winner }) => {
        set({ ended: { winner } });
        const me = get().viewer;
        if (winner === me) sfx.win();
        else sfx.lose();
      }),
    );
    offs.push(session.on('error', (text) => get().flashError(text)));
    (session as any).__offs = offs;
    set({ session, view: null, ended: null, passInfo: null, busy: false, tool: { mode: 'idle' }, validCells: new Set() });
    if ((import.meta as any).env?.DEV) (window as any).__COAST_BATTLE = useGame;
    session.start();
  },

  unbind: () => {
    const s = get().session as any;
    if (s?.__offs) s.__offs.forEach((o: () => void) => o());
    s?.destroy?.();
    set({
      session: null,
      view: null,
      ended: null,
      passInfo: null,
      busy: false,
      tool: { mode: 'idle' },
      validCells: new Set(),
      turnBanner: null,
    });
  },

  controllable: () => {
    const { view, viewer, busy, passInfo, ended } = get();
    return !!view && !busy && !passInfo && !ended && view.phase !== 'ended' && view.currentPlayer === viewer;
  },

  selectBuild: (type) => {
    if (!get().controllable()) return;
    sfx.click();
    set({ tool: { mode: 'build', buildingType: type, rot: 0 }, validCells: computeValid(get().view, get().viewer, type) });
  },
  selectBase: () => {
    sfx.click();
    set({ tool: { mode: 'placeBase', rot: 0 }, validCells: computeValid(get().view, get().viewer, 'base') });
  },
  selectWeapon: (buildingId) => {
    if (!get().controllable()) return;
    const view = get().view;
    const b = view?.buildings.find((x) => x.id === buildingId);
    if (!b) return;
    const def = buildingDef(b.type);
    sfx.click();
    set({
      tool: {
        mode: b.type === 'sonar' ? 'sonar' : 'fire',
        buildingId,
        attackW: def.attackW ?? 1,
        attackH: def.attackH ?? 1,
        rot: 0,
      },
      validCells:
        b.type === 'sonar'
          ? new Set()
          : computeValidTargets(view ?? null, get().viewer, def.attackW ?? 1, def.attackH ?? 1, 0),
    });
  },
  rotateTool: () => {
    const t = get().tool;
    const rot: 0 | 1 = t.rot ? 0 : 1;
    sfx.hover();
    if (t.mode === 'build' && t.buildingType) {
      set({ tool: { ...t, rot }, validCells: computeValid(get().view, get().viewer, t.buildingType, rot) });
    } else if (t.mode === 'fire' || t.mode === 'sonar') {
      set({
        tool: { ...t, rot },
        validCells: t.mode === 'fire' ? computeValidTargets(get().view, get().viewer, t.attackW ?? 1, t.attackH ?? 1, rot) : new Set(),
      });
    }
  },
  clearTool: () => set({ tool: { mode: 'idle' }, validCells: new Set() }),

  setHover: (cell) => set({ hover: cell }),

  click: (cell) => {
    const { tool, session, controllable, view, validCells, viewer } = get();
    if (!session || !controllable()) return;

    const selectNextWeapon = (usedId: string) => {
      if (!view) {
        set({ tool: { mode: 'idle' }, validCells: new Set() });
        return;
      }
      const me = view.players[viewer];
      const myEnergy = me?.energy ?? 0;
      const myBuildings = view.buildings.filter((b) => b.owner === viewer);
      const weapons = myBuildings.filter((b) => {
        const isWpn = buildingDef(b.type).category === 'weapon' || b.type === 'sonar';
        if (!isWpn || b.id === usedId) return false;
        const powering = view.turn < b.operationalTurn;
        const ready = !b.disabled && !powering && b.cooldownLeft === 0;
        const cost = buildingDef(b.type).fireCost ?? 0;
        const currentWpn = view.buildings.find((x) => x.id === usedId);
        const currentCost = currentWpn ? (buildingDef(currentWpn.type).fireCost ?? 0) : 0;
        const estimatedEnergy = myEnergy - currentCost;
        return ready && estimatedEnergy >= cost;
      });

      if (weapons.length > 0) {
        get().selectWeapon(weapons[0].id);
      } else {
        set({ tool: { mode: 'idle' }, validCells: new Set() });
      }
    };

    switch (tool.mode) {
      case 'placeBase':
        session.submit({ type: 'placeBase', x: cell.x, y: cell.y });
        set({ tool: { mode: 'idle' }, validCells: new Set() });
        break;
      case 'build':
        if (tool.buildingType) {
          sfx.place();
          session.submit({ type: 'build', building: tool.buildingType, x: cell.x, y: cell.y, rot: tool.rot ?? 0 });
        }
        break;
      case 'fire':
        if (tool.buildingId) {
          if (!view || !validCells.has(cell.y * view.map.width + cell.x)) {
            get().flashError('Cannot target your own territory');
            return;
          }
          sfx.launch();
          session.submit({ type: 'fire', buildingId: tool.buildingId, x: cell.x, y: cell.y, rot: tool.rot ?? 0 });
          selectNextWeapon(tool.buildingId);
        }
        break;
      case 'sonar':
        if (tool.buildingId) {
          sfx.radar();
          session.submit({ type: 'sonar', buildingId: tool.buildingId, x: cell.x, y: cell.y });
          selectNextWeapon(tool.buildingId);
        }
        break;
      default:
        break;
    }
  },

  resumePass: () => {
    sfx.click();
    set({ passInfo: null });
    get().session?.resume();
  },

  flashError: (text) => {
    sfx.deny();
    set({ error: { text, t: Date.now() } });
  },
}));
