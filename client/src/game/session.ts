import type { Action, GameEvent, GameSettings, GameState, MapArchetype } from '@shared/types';
import { applyAction, createGame, serializeForPlayer } from '@shared/engine';
import { decideDeploy, decideTurn, newAiMemory, type AiMemory } from '@shared/ai';
import { randomSeed } from '@shared/rng';
import { TURN_CAP } from '@shared/constants';

export type SessionEventMap = {
  view: { view: GameState; viewer: number };
  events: GameEvent[];
  pass: { player: number; name: string };
  turn: { player: number; isAI: boolean };
  end: { winner: number | null };
  error: string;
  busy: boolean;
};

type Listener<K extends keyof SessionEventMap> = (payload: SessionEventMap[K]) => void;

export abstract class BaseSession {
  protected listeners: { [K in keyof SessionEventMap]?: Set<Listener<K>> } = {};
  kind: 'local' | 'online' = 'local';

  on<K extends keyof SessionEventMap>(type: K, cb: Listener<K>): () => void {
    (this.listeners[type] ||= new Set() as any).add(cb as any);
    return () => this.listeners[type]?.delete(cb as any);
  }
  protected emit<K extends keyof SessionEventMap>(type: K, payload: SessionEventMap[K]) {
    this.listeners[type]?.forEach((cb) => (cb as Listener<K>)(payload));
  }

  setRevealFog(val: boolean) {}
  getRevealFog(): boolean {
    return false;
  }

  abstract start(): void;
  abstract submit(action: Action): void;
  abstract destroy(): void;
  resume(): void {}
}

export interface LocalConfig {
  mode: 'ai' | 'hotseat';
  settings: GameSettings;
  seed?: number;
  players: { id: string; name: string; color?: string; isAI?: boolean }[];
}

export class LocalSession extends BaseSession {
  private state: GameState;
  private memories: AiMemory[];
  private timers: number[] = [];
  private dead = false;
  readonly cfg: LocalConfig;
  private revealFogState = false;

  constructor(cfg: LocalConfig) {
    super();
    this.cfg = cfg;
    const seed = cfg.seed ?? randomSeed();
    this.state = createGame(cfg.settings, seed, cfg.players);
    this.memories = cfg.players.map(() => newAiMemory());
  }

  override setRevealFog(val: boolean) {
    this.revealFogState = val;
    this.emitView();
  }

  override getRevealFog() {
    return this.revealFogState;
  }

  private humanViewer(): number {
    if (this.cfg.mode === 'ai') {
      const h = this.state.players.findIndex((p) => !p.isAI);
      return h < 0 ? 0 : h;
    }
    return this.state.currentPlayer;
  }

  private emitView() {
    const viewer = this.humanViewer();
    let viewState = this.state;
    if (this.revealFogState) {
      viewState = {
        ...this.state,
        settings: {
          ...this.state.settings,
          fogOfWar: false,
        },
      };
    }
    this.emit('view', { view: serializeForPlayer(viewState, viewer), viewer });
  }

  start() {
    // initial board for the first actor
    const cur = this.state.currentPlayer;
    if (this.state.players[cur].isAI) {
      this.emitView();
      this.scheduleAI(400);
    } else {
      this.emitView();
      this.emit('turn', { player: cur, isAI: false });
    }
  }

  private after(delay: number, fn: () => void) {
    const t = window.setTimeout(() => {
      if (!this.dead) fn();
    }, delay);
    this.timers.push(t);
  }

  submit(action: Action) {
    if (this.dead) return;
    const cur = this.state.currentPlayer;
    if (this.state.players[cur].isAI) return; // ignore human input during AI turn
    const before = this.state.currentPlayer;
    const beforePhase = this.state.phase;
    const r = applyAction(this.state, this.state.players[cur].id, action);
    if (!r.ok) {
      this.emit('error', r.error || 'Invalid action');
      return;
    }
    this.state = r.state;
    if (r.events.length) this.emit('events', r.events);

    const changed = this.state.currentPlayer !== before || this.state.phase !== beforePhase;
    this.handleTransition(changed);
  }

  // decide what to show/do after an action resolves
  private handleTransition(turnChanged: boolean) {
    if (this.state.phase === 'ended') {
      this.emitView();
      this.emit('end', { winner: this.state.winner });
      return;
    }
    const cur = this.state.currentPlayer;
    const isAI = this.state.players[cur].isAI;

    if (!turnChanged) {
      // same actor continues (build/fire within turn)
      this.emitView();
      return;
    }

    if (isAI) {
      // keep showing human's board; run AI after a beat so animations land
      this.emitView();
      this.emit('turn', { player: cur, isAI: true });
      this.emit('busy', true);
      this.scheduleAI(650);
    } else if (this.cfg.mode === 'hotseat') {
      // hand device to the next human — hide the board behind a pass screen
      this.emit('pass', { player: cur, name: this.state.players[cur].name });
    } else {
      // ai-mode, control returns to the human
      this.emit('busy', false);
      this.emitView();
      this.emit('turn', { player: cur, isAI: false });
    }
  }

  // hotseat: called by UI when the next player is ready
  resume() {
    if (this.dead) return;
    const cur = this.state.currentPlayer;
    this.emitView();
    this.emit('turn', { player: cur, isAI: this.state.players[cur].isAI });
  }

  private scheduleAI(delay: number) {
    this.after(delay, () => this.runAI());
  }

  private runAI() {
    if (this.dead) return;
    const ai = this.state.currentPlayer;
    if (!this.state.players[ai].isAI) {
      this.emit('busy', false);
      return;
    }
    if (this.state.phase === 'deploy') {
      const a = decideDeploy(this.state, ai);
      if (a) {
        const r = applyAction(this.state, this.state.players[ai].id, a);
        if (r.ok) {
          this.state = r.state;
          if (r.events.length) this.emit('events', r.events);
        }
      }
      // continue to next actor (deploy or play)
      this.after(300, () => this.continueAfterAI());
      return;
    }
    // play phase: execute the plan action by action with cinematic pacing
    const plan = decideTurn(this.state, ai, this.memories[ai]);
    this.playPlan(plan, 0);
  }

  private playPlan(plan: Action[], i: number) {
    if (this.dead) return;
    if (i >= plan.length) {
      this.continueAfterAI();
      return;
    }
    const ai = this.state.currentPlayer;
    const action = plan[i];
    const r = applyAction(this.state, this.state.players[ai].id, action);
    if (r.ok) {
      this.state = r.state;
      if (r.events.length) this.emit('events', r.events);
      this.emitView();
    }
    if (this.state.phase === 'ended') {
      this.emit('end', { winner: this.state.winner });
      return;
    }
    if (action.type === 'endTurn') {
      // turn handed off
      this.after(300, () => this.continueAfterAI());
      return;
    }
    const delay = action.type === 'fire' || action.type === 'sonar' ? 700 : action.type === 'build' ? 420 : 260;
    this.after(delay, () => this.playPlan(plan, i + 1));
  }

  private continueAfterAI() {
    if (this.dead) return;
    if (this.state.phase === 'ended') {
      this.emitView();
      this.emit('end', { winner: this.state.winner });
      return;
    }
    const cur = this.state.currentPlayer;
    if (this.state.players[cur].isAI) {
      this.emitView();
      this.emit('turn', { player: cur, isAI: true });
      this.scheduleAI(550);
    } else {
      this.emit('busy', false);
      this.emitView();
      this.emit('turn', { player: cur, isAI: false });
    }
  }

  destroy() {
    this.dead = true;
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
  }
}

export function makeLocalSettings(
  mode: 'ai' | 'hotseat',
  numPlayers: number,
  archetype: MapArchetype | 'random',
  difficulty: 'easy' | 'normal' | 'hard',
): GameSettings {
  return {
    numPlayers,
    mode,
    turnCap: TURN_CAP,
    fogOfWar: true,
    mapArchetype: archetype,
    difficulty,
  };
}
