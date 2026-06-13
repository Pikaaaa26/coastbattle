import type { Action, Difficulty, GameEvent, GameState, MapArchetype } from './types';

export interface LobbyPlayer {
  index: number;
  name: string;
  color: string;
  ready: boolean;
  connected: boolean;
  isBot: boolean;
}

export interface LobbyView {
  code: string;
  hostIndex: number;
  youIndex: number;
  mode: 'duel' | 'ffa';
  numPlayers: number;
  archetype: MapArchetype | 'random';
  difficulty: Difficulty;
  players: LobbyPlayer[];
  canStart: boolean;
  isPrivate: boolean;
  isRanked: boolean;
}

export interface CreateOpts {
  name: string;
  color: string;
  mode: 'duel' | 'ffa';
  numPlayers: number;
  archetype: MapArchetype | 'random';
  difficulty: Difficulty;
  isPrivate?: boolean;
  isRanked?: boolean;
  playerId?: string;
}

// client -> server
export type C2S =
  | ({ t: 'create' } & CreateOpts)
  | { t: 'join'; code: string; name: string; color: string; playerId?: string }
  | { t: 'rejoin'; code: string; token: string }
  | { t: 'setReady'; ready: boolean }
  | { t: 'addBot' }
  | { t: 'start' }
  | { t: 'action'; action: Action }
  | { t: 'chat'; text: string }
  | { t: 'rematch' }
  | { t: 'leave' }
  | { t: 'togglePrivate'; isPrivate: boolean };

// server -> client
export type S2C =
  | { t: 'joined'; code: string; token: string; index: number }
  | { t: 'lobby'; lobby: LobbyView }
  | { t: 'state'; state: GameState }
  | { t: 'events'; events: GameEvent[] }
  | { t: 'turn'; player: number }
  | { t: 'end'; winner: number | null }
  | { t: 'chat'; from: string; color: string; text: string }
  | { t: 'error'; message: string };
