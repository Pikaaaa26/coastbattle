import type { WebSocket } from 'ws';
import { customAlphabet } from 'nanoid';
import { updateEloForMatch } from './ratings';
import type { Action, Difficulty, GameEvent, GameState, MapArchetype } from '../shared/types';
import type { CreateOpts, LobbyPlayer, LobbyView, S2C } from '../shared/protocol';
import { applyAction, createGame, serializeForPlayer } from '../shared/engine';
import { decideDeploy, decideTurn, newAiMemory, type AiMemory } from '../shared/ai';
import { randomSeed } from '../shared/rng';
import { TURN_CAP } from '../shared/constants';

const makeCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 4);
const makeToken = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 16);

interface Slot {
  index: number;
  id: string; // engine player id
  name: string;
  color: string;
  ready: boolean;
  isBot: boolean;
  token: string;
  ws: WebSocket | null;
  connected: boolean;
  playerId?: string;
}

const BOT_NAMES = ['CPU NIMITZ', 'CPU YAMATO', 'CPU DRAKE', 'CPU IRONSIDE'];
const BOT_COLORS = ['#ff5a5a', '#ffcf4d', '#52e0a0', '#d36bff'];

export class Room {
  code: string;
  mode: 'duel' | 'ffa';
  numPlayers: number;
  archetype: MapArchetype | 'random';
  difficulty: Difficulty;
  slots: Slot[] = [];
  hostToken = '';
  state: GameState | null = null;
  status: 'lobby' | 'active' | 'ended' = 'lobby';
  private mems = new Map<number, AiMemory>();
  private timers: NodeJS.Timeout[] = [];
  private lastCurrentPlayer = -1;
  private moveTimer: NodeJS.Timeout | null = null;
  private botChainActive = false;
  lastActivity = Date.now();

  isPrivate: boolean;
  isRanked: boolean;

  constructor(opts: CreateOpts) {
    this.code = makeCode();
    this.mode = opts.mode;
    this.numPlayers = Math.max(2, Math.min(4, opts.mode === 'duel' ? 2 : opts.numPlayers));
    this.archetype = opts.archetype;
    this.difficulty = opts.difficulty;
    this.isPrivate = !!opts.isPrivate;
    this.isRanked = !!opts.isRanked;
  }

  private timer(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      if (this.status !== 'ended') fn();
    }, ms);
    this.timers.push(t);
  }

  private resetMoveTimer() {
    if (this.moveTimer) {
      clearTimeout(this.moveTimer);
      this.moveTimer = null;
    }
    if (this.status !== 'active' || !this.state) return;
    const cur = this.state.currentPlayer;
    if (this.slots[cur]?.isBot) return;

    this.moveTimer = setTimeout(() => {
      if (this.status !== 'active' || !this.state) return;
      const c = this.state.currentPlayer;
      if (this.slots[c]?.isBot) return;

      console.log(`[Timer] Player pl${c} timed out on phase: ${this.state.phase}`);
      if (this.state.phase === 'deploy') {
        const a = decideDeploy(this.state, c);
        if (a) {
          this.step(c, a);
          this.afterHuman();
        }
      } else if (this.state.phase === 'playing') {
        this.step(c, { type: 'endTurn' });
        this.afterHuman();
      }
    }, 60_000);
  }

  private touch() {
    this.lastActivity = Date.now();
  }

  // ---------- slots ----------
  addHuman(name: string, color: string, ws: WebSocket, playerId?: string): Slot | null {
    if (this.status !== 'lobby' || this.slots.length >= this.numPlayers) return null;
    const index = this.slots.length;
    const slot: Slot = {
      index,
      id: `pl${index}`,
      name: name.slice(0, 16) || `CMDR ${index + 1}`,
      color,
      ready: false,
      isBot: false,
      token: makeToken(),
      ws,
      connected: true,
      playerId,
    };
    this.slots.push(slot);
    if (this.slots.length === 1) this.hostToken = slot.token;
    this.touch();
    return slot;
  }

  addBot(): boolean {
    if (this.isRanked) return false; // Ranked matches cannot have bots
    if (this.status !== 'lobby' || this.slots.length >= this.numPlayers) return false;
    const index = this.slots.length;
    const used = new Set(this.slots.map((s) => s.color));
    const color = BOT_COLORS.find((c) => !used.has(c)) || BOT_COLORS[index % BOT_COLORS.length];
    this.slots.push({
      index,
      id: `pl${index}`,
      name: BOT_NAMES[index % BOT_NAMES.length],
      color,
      ready: true,
      isBot: true,
      token: makeToken(),
      ws: null,
      connected: true,
    });
    this.touch();
    return true;
  }

  slotByToken(token: string): Slot | undefined {
    return this.slots.find((s) => s.token === token);
  }
  slotByWs(ws: WebSocket): Slot | undefined {
    return this.slots.find((s) => s.ws === ws);
  }
  isHost(slot: Slot): boolean {
    return slot.token === this.hostToken;
  }
  get hostIndex(): number {
    return this.slots.find((s) => s.token === this.hostToken)?.index ?? 0;
  }

  // remove a human during lobby (re-index); during a game, convert to bot
  removeWs(ws: WebSocket): { empty: boolean } {
    const slot = this.slotByWs(ws);
    if (!slot) return { empty: this.slots.every((s) => !s.connected && !s.isBot) };
    if (this.status === 'lobby') {
      this.slots = this.slots.filter((s) => s !== slot);
      this.slots.forEach((s, i) => {
        s.index = i;
        s.id = `pl${i}`;
      });
      if (this.slots.length && !this.slots.some((s) => s.token === this.hostToken)) {
        this.hostToken = this.slots[0].token;
      }
      this.broadcastLobby();
    } else {
      // mid-game: keep the seat, hand it to the AI so the match continues
      slot.connected = false;
      slot.ws = null;
      slot.isBot = true;
      this.mems.set(slot.index, newAiMemory());
      this.broadcastLobby();
      this.resetMoveTimer();
      this.driveBots();
    }
    const empty = this.slots.every((s) => s.isBot || !s.connected);
    return { empty };
  }

  rejoin(token: string, ws: WebSocket): Slot | null {
    const slot = this.slotByToken(token);
    if (!slot) return null;
    slot.ws = ws;
    slot.connected = true;
    slot.isBot = false;
    this.touch();
    return slot;
  }

  // ---------- messaging ----------
  private send(slot: Slot, msg: S2C) {
    if (slot.ws && slot.ws.readyState === 1) {
      try {
        slot.ws.send(JSON.stringify(msg));
      } catch {
        /* ignore */
      }
    }
  }
  sendTo(slot: Slot, msg: S2C) {
    this.send(slot, msg);
  }

  lobbyView(forIndex: number): LobbyView {
    const players: LobbyPlayer[] = this.slots.map((s) => ({
      index: s.index,
      name: s.name,
      color: s.color,
      ready: s.ready,
      connected: s.connected,
      isBot: s.isBot,
    }));
    return {
      code: this.code,
      hostIndex: this.hostIndex,
      youIndex: forIndex,
      mode: this.mode,
      numPlayers: this.numPlayers,
      archetype: this.archetype,
      difficulty: this.difficulty,
      players,
      canStart: this.canStart(),
      isPrivate: this.isPrivate,
      isRanked: this.isRanked,
    };
  }

  togglePrivate(isPrivate: boolean) {
    this.isPrivate = isPrivate;
    this.touch();
    this.broadcastLobby();
  }

  broadcastLobby() {
    for (const s of this.slots) if (!s.isBot && s.ws) this.send(s, { t: 'lobby', lobby: this.lobbyView(s.index) });
  }

  canStart(): boolean {
    return (
      this.slots.length === this.numPlayers &&
      this.slots.every((s) => s.isBot || s.ready) &&
      this.slots.length >= 2
    );
  }

  setReady(slot: Slot, ready: boolean) {
    slot.ready = ready;
    this.broadcastLobby();
  }

  // ---------- game ----------
  start(): boolean {
    if (this.status !== 'lobby' || !this.canStart()) return false;
    const seed = randomSeed();
    const players = this.slots.map((s) => ({ id: s.id, name: s.name, color: s.color, isAI: s.isBot }));
    const settings = {
      numPlayers: this.numPlayers,
      mode: this.mode,
      turnCap: TURN_CAP,
      fogOfWar: true,
      mapArchetype: this.archetype,
      difficulty: this.difficulty,
    };
    this.state = createGame(settings, seed, players);
    this.status = 'active';
    this.lastCurrentPlayer = -1;
    this.slots.forEach((s) => this.mems.set(s.index, newAiMemory()));
    this.broadcastState();
    this.resetMoveTimer();
    this.driveBots();
    return true;
  }

  rematch() {
    this.status = 'lobby';
    this.state = null;
    this.botChainActive = false;
    this.lastCurrentPlayer = -1;
    if (this.moveTimer) {
      clearTimeout(this.moveTimer);
      this.moveTimer = null;
    }
    this.slots.forEach((s) => (s.ready = s.isBot));
    this.broadcastLobby();
  }

  private eventsFor(events: GameEvent[], index: number): GameEvent[] {
    const out: GameEvent[] = [];
    for (const e of events) {
      // private to the owner: scouting + economy + construction
      if (e.type === 'reveal' || e.type === 'radar' || e.type === 'sonar' || e.type === 'income' || e.type === 'build') {
        if ((e as { player: number }).player === index) out.push(e);
        continue;
      }
      // a destroyed building's full footprint reveals its type/orientation — owner only
      if (e.type === 'destroyed') {
        if ((e as { owner: number }).owner === index) out.push(e);
        continue;
      }
      // fire events carry two secrets: the launcher cell (attacker's) and, for missiles,
      // the intercepting turret cell (defender's). Each side only gets its own.
      if (e.type === 'missile' || e.type === 'artillery' || e.type === 'napalm' || e.type === 'nuke') {
        const isAttacker = (e as { player: number }).player === index;
        let ev: GameEvent = e;
        if (!isAttacker) ev = { ...ev, from: { x: -1, y: -1 } } as GameEvent;
        if (isAttacker && ev.type === 'missile' && ev.interceptedBy) ev = { ...ev, interceptedBy: null };
        out.push(ev);
        continue;
      }
      out.push(e);
    }
    return out;
  }

  broadcastState(events: GameEvent[] = []) {
    if (!this.state) return;
    for (const s of this.slots) {
      if (s.isBot || !s.ws) continue;
      // events FIRST so the client can hold the board's visual state until ordnance lands
      const ev = this.eventsFor(events, s.index);
      if (ev.length) this.send(s, { t: 'events', events: ev });
      this.send(s, { t: 'state', state: serializeForPlayer(this.state, s.index) });
    }
    if (this.state.phase === 'ended' && this.status === 'active') {
      this.status = 'ended';
      if (this.isRanked) {
        const rankedPlayers = this.slots
          .filter((s) => !s.isBot && s.playerId)
          .map((s) => ({
            playerId: s.playerId!,
            name: s.name,
            rank: this.state!.winner === null ? 1 : (this.state!.winner === s.index ? 1 : 2),
          }));
        if (rankedPlayers.length >= 2) {
          try {
            updateEloForMatch(rankedPlayers);
          } catch (e) {
            console.error('Error updating Elo:', e);
          }
        }
      }
      for (const s of this.slots) if (!s.isBot && s.ws) this.send(s, { t: 'end', winner: this.state.winner });
    } else {
      if (this.state.currentPlayer !== this.lastCurrentPlayer) {
        this.lastCurrentPlayer = this.state.currentPlayer;
        for (const s of this.slots) if (!s.isBot && s.ws) this.send(s, { t: 'turn', player: this.state.currentPlayer });
      }
    }
  }

  // returns error string or null
  step(index: number, action: Action): string | null {
    if (!this.state) return 'No active game';
    const slot = this.slots[index];
    if (!slot) return 'Bad slot';
    const r = applyAction(this.state, slot.id, action);
    if (!r.ok) return r.error || 'Invalid action';
    this.state = r.state;
    this.touch();
    this.broadcastState(r.events);
    this.resetMoveTimer();
    return null;
  }

  // called after a HUMAN action; if control passed to a bot, run it
  afterHuman() {
    this.driveBots();
  }

  driveBots() {
    if (this.botChainActive || this.status !== 'active' || !this.state) return;
    const cur = this.state.currentPlayer;
    if (!this.slots[cur]?.isBot) return;
    this.botChainActive = true;
    this.timer(() => this.botTurn(cur), 1600);
  }

  private mem(idx: number): AiMemory {
    let m = this.mems.get(idx);
    if (!m) {
      m = newAiMemory();
      this.mems.set(idx, m);
    }
    return m;
  }

  private botTurn(idx: number) {
    if (this.status !== 'active' || !this.state) {
      this.botChainActive = false;
      return;
    }
    if (this.state.phase === 'deploy') {
      const a = decideDeploy(this.state, idx);
      if (a) this.step(idx, a);
      this.timer(() => this.botContinue(), 350);
      return;
    }
    const plan = decideTurn(this.state, idx, this.mem(idx));
    this.botPlay(idx, plan, 0);
  }

  private botPlay(idx: number, plan: Action[], i: number) {
    if (this.status !== 'active' || !this.state) {
      this.botChainActive = false;
      return;
    }
    if (i >= plan.length) {
      this.timer(() => this.botContinue(), 300);
      return;
    }
    const action = plan[i];
    this.step(idx, action);
    if (!this.state || this.state.phase === 'ended') {
      this.botChainActive = false;
      return;
    }
    if (action.type === 'endTurn') {
      this.timer(() => this.botContinue(), 300);
      return;
    }
    const delay = action.type === 'fire' || action.type === 'sonar' ? 700 : action.type === 'build' ? 420 : 260;
    this.timer(() => this.botPlay(idx, plan, i + 1), delay);
  }

  private botContinue() {
    if (this.status !== 'active' || !this.state) {
      this.botChainActive = false;
      return;
    }
    const cur = this.state.currentPlayer;
    if (this.slots[cur]?.isBot) {
      this.timer(() => this.botTurn(cur), 450);
      return;
    }
    this.botChainActive = false; // human's turn (already broadcast)
  }

  chat(slot: Slot, text: string) {
    const clean = text.slice(0, 200);
    for (const s of this.slots)
      if (!s.isBot && s.ws) this.send(s, { t: 'chat', from: slot.name, color: slot.color, text: clean });
  }

  dispose() {
    this.status = 'ended';
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
    if (this.moveTimer) {
      clearTimeout(this.moveTimer);
      this.moveTimer = null;
    }
  }
}

export class Hub {
  rooms = new Map<string, Room>();

  create(opts: CreateOpts, ws: WebSocket): { room: Room; slot: Slot } {
    const room = new Room(opts);
    this.rooms.set(room.code, room);
    const slot = room.addHuman(opts.name, opts.color, ws, opts.playerId)!;
    return { room, slot };
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const idle = now - room.lastActivity;
      const noHumans = room.slots.every((s) => s.isBot || !s.connected);
      if ((noHumans && idle > 60_000) || idle > 2 * 3600_000) {
        room.dispose();
        this.rooms.delete(code);
      }
    }
  }
}
