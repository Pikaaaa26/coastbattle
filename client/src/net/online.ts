import type { Action } from '@shared/types';
import type { C2S, CreateOpts, LobbyView, S2C } from '@shared/protocol';
import { BaseSession } from '../game/session';

export type { LobbyView } from '@shared/protocol';

function wsUrl(): string {
  const env = (import.meta as any).env?.VITE_WS_URL as string | undefined;
  if (env) return env;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

// OnlineConnection is both the lobby client AND (once the match starts) the game Session.
export class OnlineConnection extends BaseSession {
  private ws: WebSocket | null = null;
  private lobbyCbs = new Set<(l: LobbyView) => void>();
  private startedCbs = new Set<() => void>();
  private errCbs = new Set<(m: string) => void>();
  private chatCbs = new Set<(from: string, color: string, text: string) => void>();
  private latestView: { view: any; viewer: number } | null = null;
  private started = false;
  code = '';
  token = '';
  index = -1;
  private destroyed = false;
  private reconnectAttempts = 0;
  private reconnectTimer = 0;

  constructor() {
    super();
    this.kind = 'online';
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl());
      } catch (e) {
        reject(e);
        return;
      }
      const to = window.setTimeout(() => reject(new Error('timeout')), 8000);
      this.ws.onopen = () => {
        clearTimeout(to);
        this.reconnectAttempts = 0;
        resolve();
      };
      this.ws.onerror = () => {
        clearTimeout(to);
        if (!this.started) this.errCbs.forEach((cb) => cb('Connection error.'));
        reject(new Error('ws error'));
      };
      this.ws.onclose = () => this.onClose();
      this.ws.onmessage = (ev) => this.handle(JSON.parse(ev.data) as S2C);
    });
  }

  // mid-game socket drop (idle proxy kill, wifi blip, redeploy) -> auto-reconnect + rejoin
  private onClose() {
    if (this.destroyed) return;
    if (!this.started) {
      this.errCbs.forEach((cb) => cb('Disconnected from server.'));
      return;
    }
    this.emit('error', 'Connection lost — reconnecting…');
    this.scheduleReconnect();
  }
  private scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    if (this.reconnectAttempts >= 8) {
      this.emit('error', 'Could not reconnect. Please rejoin the room.');
      return;
    }
    const delay = Math.min(8000, 700 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0;
      this.tryReconnect();
    }, delay);
  }
  private tryReconnect() {
    if (this.destroyed || !this.code || !this.token) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.send({ t: 'rejoin', code: this.code, token: this.token });
    ws.onmessage = (ev) => this.handle(JSON.parse(ev.data) as S2C);
    ws.onerror = () => {};
    ws.onclose = () => this.onClose();
  }

  private send(msg: C2S) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private handle(msg: S2C) {
    switch (msg.t) {
      case 'joined':
        this.code = msg.code;
        this.token = msg.token;
        this.index = msg.index;
        try {
          sessionStorage.setItem('coast-battle-rejoin', JSON.stringify({ code: msg.code, token: msg.token }));
        } catch {
          /* ignore */
        }
        break;
      case 'lobby':
        this.lobbyCbs.forEach((cb) => cb(msg.lobby));
        break;
      case 'state': {
        this.reconnectAttempts = 0; // a fresh state confirms we're (re)connected and in the game
        const viewer = msg.state.viewerIndex ?? this.index;
        this.latestView = { view: msg.state, viewer };
        if (!this.started) {
          this.started = true;
          this.startedCbs.forEach((cb) => cb());
        }
        this.emit('view', { view: msg.state, viewer });
        break;
      }
      case 'events':
        this.emit('events', msg.events);
        break;
      case 'turn':
        this.emit('turn', { player: msg.player, isAI: false });
        break;
      case 'end':
        this.emit('end', { winner: msg.winner });
        break;
      case 'error':
        this.emit('error', msg.message);
        this.errCbs.forEach((cb) => cb(msg.message));
        break;
      case 'chat':
        this.chatCbs.forEach((cb) => cb(msg.from, msg.color, msg.text));
        break;
      default:
        break;
    }
  }

  // lobby API
  create(opts: CreateOpts) {
    this.send({ t: 'create', ...opts });
  }
  join(code: string, name: string, color: string, playerId?: string) {
    this.send({ t: 'join', code, name, color, playerId });
  }
  togglePrivate(isPrivate: boolean) {
    this.send({ t: 'togglePrivate', isPrivate });
  }
  setReady(ready: boolean) {
    this.send({ t: 'setReady', ready });
  }
  addBot() {
    this.send({ t: 'addBot' });
  }
  startGame() {
    this.send({ t: 'start' });
  }
  chat(text: string) {
    this.send({ t: 'chat', text });
  }
  onLobby(cb: (l: LobbyView) => void) {
    this.lobbyCbs.add(cb);
    return () => this.lobbyCbs.delete(cb);
  }
  onStarted(cb: () => void) {
    this.startedCbs.add(cb);
    return () => this.startedCbs.delete(cb);
  }
  onConnError(cb: (m: string) => void) {
    this.errCbs.add(cb);
    return () => this.errCbs.delete(cb);
  }
  onChat(cb: (from: string, color: string, text: string) => void) {
    this.chatCbs.add(cb);
    return () => this.chatCbs.delete(cb);
  }

  // BaseSession (game) API
  start() {
    if (this.latestView) this.emit('view', this.latestView);
  }
  submit(action: Action) {
    this.send({ t: 'action', action });
  }
  resume() {
    /* online needs no pass handoff */
  }
  rematch() {
    this.send({ t: 'rematch' });
  }
  destroy() {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
    }
    this.send({ t: 'leave' });
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
