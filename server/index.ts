import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import type { C2S } from '../shared/protocol';
import { serializeForPlayer } from '../shared/engine';
import { Hub } from './rooms';
import { getLeaderboard } from './ratings';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..');

const app = express();
app.use(express.json({ limit: '128kb' })); // cap body size (battle logs are small)
const hub = new Hub();

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, rooms: hub.rooms.size, uptime: process.uptime() });
});

app.post('/api/battle-log', (req, res) => {
  const { battleId, log } = req.body;
  if (!battleId || !log) {
    return res.status(400).json({ error: 'Missing battleId or log' });
  }
  try {
    const dir = path.join(DATA_DIR, 'battle_logs');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // sanitize the client-supplied id so it can't traverse the path / escape the dir
    const safeId = String(battleId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'unknown';
    const filename = `battle_${safeId}_${Date.now()}.json`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, JSON.stringify({ battleId, log }, null, 2), 'utf-8');
    console.log(`[coast-battle] saved battle log to ${filepath}`);
    res.json({ ok: true, file: filepath });
  } catch (error: any) {
    console.error('[coast-battle] failed to save battle log:', error);
    res.status(500).json({ error: 'Failed to write battle log' });
  }
});

app.get('/api/lobbies', (_req, res) => {
  const list = [];
  for (const room of hub.rooms.values()) {
    if (room.status === 'lobby' && !room.isPrivate) {
      const totalPlayers = room.slots.length;
      const openSeats = room.numPlayers - totalPlayers;
      const host = room.slots.find((s) => s.token === room.hostToken);
      list.push({
        code: room.code,
        mode: room.mode,
        numPlayers: room.numPlayers,
        archetype: room.archetype,
        difficulty: room.difficulty,
        isRanked: room.isRanked,
        playersCount: totalPlayers,
        openSeats,
        hostName: host ? host.name : 'Unknown',
      });
    }
  }
  res.json({ ok: true, lobbies: list });
});

app.get('/api/leaderboard', (_req, res) => {
  try {
    const list = getLeaderboard();
    res.json({ ok: true, leaderboard: list });
  } catch (error) {
    console.error('[coast-battle] failed to retrieve leaderboard:', error);
    res.status(500).json({ error: 'Failed to retrieve leaderboard' });
  }
});

// serve the built client in production (single deployable)
const distDir = path.resolve(__dirname, '../dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
  console.log('[coast-battle] serving client from', distDir);
} else {
  app.get('/', (_req, res) =>
    res.type('text').send('Coast Battle server running. Start the Vite client with `npm run dev:client`.'),
  );
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if ((req.url || '').split('?')[0] === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// keepalive: Render (and most proxies) drop idle WebSockets after a few minutes. Ping every 30s
// and reap any socket that didn't answer the previous ping (-> existing close handler runs).
type Alive = WebSocket & { isAlive?: boolean };
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    const w = ws as Alive;
    if (w.isAlive === false) {
      w.terminate();
      return;
    }
    w.isAlive = false;
    try {
      w.ping();
    } catch {
      /* ignore */
    }
  });
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

function err(ws: WebSocket, message: string) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'error', message }));
}
function codeOf(ws: WebSocket): string | undefined {
  return (ws as unknown as { _code?: string })._code;
}
function setCode(ws: WebSocket, code: string) {
  (ws as unknown as { _code?: string })._code = code;
}

wss.on('connection', (ws: WebSocket) => {
  (ws as Alive).isAlive = true;
  ws.on('pong', () => {
    (ws as Alive).isAlive = true;
  });
  ws.on('message', (data) => {
    let msg: C2S;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    handle(ws, msg);
  });
  ws.on('close', () => closeWs(ws));
  ws.on('error', () => {});
});

function roomOf(ws: WebSocket) {
  const code = codeOf(ws);
  return code ? hub.get(code) : undefined;
}

function handle(ws: WebSocket, msg: C2S) {
  switch (msg.t) {
    case 'create': {
      const numPlayers = msg.mode === 'duel' ? 2 : Math.max(2, Math.min(4, msg.numPlayers));
      const { room, slot } = hub.create({ ...msg, numPlayers }, ws);
      setCode(ws, room.code);
      room.sendTo(slot, { t: 'joined', code: room.code, token: slot.token, index: slot.index });
      room.broadcastLobby();
      break;
    }
    case 'join': {
      const room = hub.get(msg.code);
      if (!room) return err(ws, 'Room not found.');
      if (room.status !== 'lobby') return err(ws, 'That battle has already started.');
      const slot = room.addHuman(msg.name, msg.color, ws, msg.playerId);
      if (!slot) return err(ws, 'Room is full.');
      setCode(ws, room.code);
      room.sendTo(slot, { t: 'joined', code: room.code, token: slot.token, index: slot.index });
      room.broadcastLobby();
      break;
    }
    case 'rejoin': {
      const room = hub.get(msg.code);
      if (!room) return err(ws, 'Room not found.');
      const slot = room.rejoin(msg.token, ws);
      if (!slot) return err(ws, 'Could not rejoin.');
      setCode(ws, room.code);
      room.sendTo(slot, { t: 'joined', code: room.code, token: slot.token, index: slot.index });
      if (room.state) {
        room.sendTo(slot, { t: 'state', state: serializeForPlayer(room.state, slot.index) });
        if (room.state.phase === 'ended') room.sendTo(slot, { t: 'end', winner: room.state.winner });
        else room.sendTo(slot, { t: 'turn', player: room.state.currentPlayer });
      } else {
        room.sendTo(slot, { t: 'lobby', lobby: room.lobbyView(slot.index) });
      }
      room.broadcastLobby();
      break;
    }
    case 'setReady': {
      const room = roomOf(ws);
      const slot = room?.slotByWs(ws);
      if (room && slot) room.setReady(slot, msg.ready);
      break;
    }
    case 'addBot': {
      const room = roomOf(ws);
      const slot = room?.slotByWs(ws);
      if (!room || !slot) return;
      if (!room.isHost(slot)) return err(ws, 'Only the host can add a CPU.');
      if (!room.addBot()) return err(ws, 'No open slots.');
      room.broadcastLobby();
      break;
    }
    case 'start': {
      const room = roomOf(ws);
      const slot = room?.slotByWs(ws);
      if (!room || !slot) return;
      if (!room.isHost(slot)) return err(ws, 'Only the host can launch.');
      if (!room.start()) return err(ws, 'Fill every slot and ready up first.');
      break;
    }
    case 'action': {
      const room = roomOf(ws);
      const slot = room?.slotByWs(ws);
      if (!room || !slot || !room.state) return err(ws, 'No active game.');
      if (room.status !== 'active') return err(ws, 'Game is not active.');
      if (msg.action.type !== 'surrender' && room.state.currentPlayer !== slot.index) {
        return err(ws, 'Not your turn.');
      }
      const e = room.step(slot.index, msg.action);
      if (e) return err(ws, e);
      room.afterHuman();
      break;
    }
    case 'chat': {
      const room = roomOf(ws);
      const slot = room?.slotByWs(ws);
      if (room && slot) room.chat(slot, msg.text);
      break;
    }
    case 'rematch': {
      const room = roomOf(ws);
      const slot = room?.slotByWs(ws);
      if (room && slot && room.isHost(slot)) room.rematch();
      break;
    }
    case 'togglePrivate': {
      const room = roomOf(ws);
      const slot = room?.slotByWs(ws);
      if (room && slot && room.isHost(slot)) {
        room.togglePrivate(msg.isPrivate);
      }
      break;
    }
    case 'leave':
      closeWs(ws);
      break;
    default:
      break;
  }
}

function closeWs(ws: WebSocket) {
  const room = roomOf(ws);
  if (room) {
    const { empty } = room.removeWs(ws);
    if (empty && room.status !== 'active') {
      room.dispose();
      hub.rooms.delete(room.code);
    }
  }
  setCode(ws, '');
}

setInterval(() => hub.sweep(), 30_000);

server.listen(PORT, () => {
  console.log(`[coast-battle] server listening on :${PORT} (ws path /ws)`);
});
