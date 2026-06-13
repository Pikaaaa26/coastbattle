import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Difficulty, MapArchetype } from '@shared/types';
import { FACTIONS } from '@shared/constants';
import { ARCHETYPE_NAMES, ARCHETYPES } from '@shared/map';
import { LocalSession, makeLocalSettings } from '../game/session';
import { OnlineConnection, type LobbyView } from '../net/online';
import { useGame } from '../store/game';
import { useSettings } from '../store/settings';
import { sfx } from '../audio/sfx';

type Mode = 'ai' | 'hotseat' | 'online';
const COLORS = FACTIONS.map((f) => f.color);

export default function Portal() {
  const nav = useNavigate();
  const { commanderName, setName, getPlayerId } = useSettings();
  const bind = useGame((s) => s.bind);

  const [mode, setMode] = useState<Mode>('ai');
  const [name, setLocalName] = useState(commanderName || 'COMMANDER');
  const [colorIdx, setColorIdx] = useState(0);
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [numPlayers, setNumPlayers] = useState(2);
  const [archetype, setArchetype] = useState<MapArchetype | 'random'>('random');
  const [spectate, setSpectate] = useState(false);

  // online
  const [online, setOnline] = useState<'create' | 'join'>('create');
  const [joinCode, setJoinCode] = useState('');
  const [onlineMode, setOnlineMode] = useState<'duel' | 'ffa'>('duel');
  const [lobby, setLobby] = useState<LobbyView | null>(null);
  const [connErr, setConnErr] = useState('');
  const [connecting, setConnecting] = useState(false);
  const connRef = useRef<OnlineConnection | null>(null);
  const startedRef = useRef(false);

  const [isPrivate, setIsPrivate] = useState(false);
  const [isRanked, setIsRanked] = useState(false);
  const [lobbies, setLobbies] = useState<any[]>([]);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [lobbyTab, setLobbyTab] = useState<'join' | 'list' | 'leaderboard'>('join');
  const [loadingLobbies, setLoadingLobbies] = useState(false);
  const [loadingLeaderboard, setLoadingLeaderboard] = useState(false);

  const fetchLobbies = async () => {
    setLoadingLobbies(true);
    try {
      const res = await fetch('/api/lobbies');
      const data = await res.json();
      if (data.ok) setLobbies(data.lobbies);
    } catch (e) {
      console.error('Error fetching lobbies:', e);
    } finally {
      setLoadingLobbies(false);
    }
  };

  const fetchLeaderboard = async () => {
    setLoadingLeaderboard(true);
    try {
      const res = await fetch('/api/leaderboard');
      const data = await res.json();
      if (data.ok) setLeaderboard(data.leaderboard);
    } catch (e) {
      console.error('Error fetching leaderboard:', e);
    } finally {
      setLoadingLeaderboard(false);
    }
  };

  useEffect(() => {
    if (mode === 'online') {
      if (online === 'join') {
        if (lobbyTab === 'list') {
          fetchLobbies();
        } else if (lobbyTab === 'leaderboard') {
          fetchLeaderboard();
        }
      }
    }
  }, [mode, online, lobbyTab]);

  useEffect(() => {
    return () => {
      if (!startedRef.current) connRef.current?.destroy();
    };
  }, []);

  const saveName = (n: string) => {
    setLocalName(n);
    setName(n);
  };

  function startLocal() {
    sfx.init();
    sfx.click();
    const color = COLORS[colorIdx];
    const players: { id: string; name: string; color?: string; isAI?: boolean }[] = [];
    if (mode === 'ai' && spectate) {
      const others = [...COLORS];
      for (let i = 0; i < numPlayers; i++) {
        players.push({
          id: `cpu${i}`,
          name: `Latest AI ${String.fromCharCode(65 + i)}`,
          color: others[i % others.length],
          isAI: true,
        });
      }
    } else {
      players.push({ id: 'you', name: name || 'YOU', color, isAI: false });
      const others = COLORS.filter((_, i) => i !== colorIdx);
      for (let i = 1; i < numPlayers; i++) {
        if (mode === 'ai') {
          players.push({ id: `cpu${i}`, name: `CPU ${String.fromCharCode(64 + i)}`, color: others[i - 1], isAI: true });
        } else {
          players.push({ id: `p${i}`, name: `PLAYER ${i + 1}`, color: others[i - 1], isAI: false });
        }
      }
    }
    const settings = makeLocalSettings(mode === 'ai' ? 'ai' : 'hotseat', numPlayers, archetype, difficulty);
    const session = new LocalSession({ mode: mode === 'ai' ? 'ai' : 'hotseat', settings, players });
    bind(session);
    nav('/game');
  }

  async function connect(action: (c: OnlineConnection) => void) {
    setConnErr('');
    setConnecting(true);
    sfx.init();
    const c = new OnlineConnection();
    connRef.current = c;
    c.onLobby(setLobby);
    c.onConnError((m) => {
      setConnErr(m);
      setConnecting(false);
    });
    c.onStarted(() => {
      startedRef.current = true;
      bind(c);
      nav('/game');
    });
    try {
      await c.connect();
      setConnecting(false);
      action(c);
    } catch {
      setConnErr('Could not reach the Coast Battle server. Is it running?');
      setConnecting(false);
    }
  }

  const doCreate = () => {
    const pid = getPlayerId();
    connect((c) => c.create({ name: name || 'HOST', color: COLORS[colorIdx], mode: onlineMode, numPlayers, archetype, difficulty, isPrivate, isRanked, playerId: pid }));
  };
  const doJoin = () => {
    if (joinCode.trim().length < 4) return setConnErr('Enter a 4-character room code.');
    const pid = getPlayerId();
    connect((c) => c.join(joinCode.trim().toUpperCase(), name || 'GUEST', COLORS[colorIdx], pid));
  };
  const quickJoin = (code: string) => {
    const pid = getPlayerId();
    connect((c) => c.join(code, name || 'GUEST', COLORS[colorIdx], pid));
  };

  // ---------- lobby view ----------
  if (lobby) {
    const me = lobby.players.find((p) => p.index === lobby.youIndex);
    const isHost = lobby.youIndex === lobby.hostIndex;
    return (
      <div className="portal">
        <h1>⚓ War Room</h1>
        <p className="sub">Share the code. Battle begins when the host launches.</p>
        <div className="row" style={{ gap: 20, flexWrap: 'wrap' }}>
          <div className="col" style={{ flex: '1 1 280px' }}>
            <div className="field">
              <label>Room Code</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div className="room-code">{lobby.code}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="tag" style={{ background: lobby.isRanked ? '#ffcf4d' : '#1d4a6e', color: lobby.isRanked ? '#000' : '#fff', fontWeight: 'bold' }}>
                    {lobby.isRanked ? '🏆 Ranked' : '⚔️ Casual'}
                  </span>
                  <span className="tag" style={{ background: lobby.isPrivate ? '#522b2b' : '#2b5235', color: '#fff' }}>
                    {lobby.isPrivate ? '🔒 Private' : '🌐 Public'}
                  </span>
                </div>
              </div>
            </div>
            {isHost && (
              <div className="field" style={{ marginTop: 10 }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => connRef.current?.togglePrivate(!lobby.isPrivate)}
                >
                  {lobby.isPrivate ? '🔓 Make Public' : '🔒 Make Private'}
                </button>
              </div>
            )}
            <div className="panel">
              <div className="panel-head">
                Commanders <span className="tag">{lobby.players.length}/{lobby.numPlayers}</span>
              </div>
              <div className="col" style={{ padding: 10, gap: 8 }}>
                {lobby.players.map((p) => (
                  <div className="lobby-player" key={p.index}>
                    <span className="dot" style={{ background: p.color }} />
                    <span style={{ flex: 1 }}>
                      {p.name} {p.index === lobby.hostIndex && <span className="faint">(host)</span>}
                      {p.isBot && <span className="faint"> [BOT]</span>}
                    </span>
                    <span className={p.ready ? 'green' : 'faint'}>{p.ready ? 'READY' : p.connected ? '…' : 'OFFLINE'}</span>
                  </div>
                ))}
                {Array.from({ length: Math.max(0, lobby.numPlayers - lobby.players.length) }).map((_, i) => (
                  <div className="lobby-player" key={`e${i}`} style={{ opacity: 0.5 }}>
                    <span className="dot" style={{ background: '#1d4a6e' }} />
                    <span className="faint">waiting…</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="col" style={{ flex: '1 1 280px' }}>
            <div className="panel">
              <div className="panel-head">Briefing</div>
              <div className="col" style={{ padding: 12 }}>
                <div>
                  Mode: <span className="amber">{lobby.mode === 'duel' ? 'Duel 1v1' : 'Free-for-All'}</span>
                </div>
                <div>
                  Map: <span className="amber">{lobby.archetype === 'random' ? 'Random' : ARCHETYPE_NAMES[lobby.archetype]}</span>
                </div>
                <div>
                  Difficulty (bots): <span className="amber">{lobby.difficulty}</span>
                </div>
              </div>
            </div>
            <button
              className={`btn ${me?.ready ? '' : 'btn-primary'}`}
              onClick={() => connRef.current?.setReady(!me?.ready)}
            >
              {me?.ready ? '✓ Ready — stand down' : 'Ready Up'}
            </button>
            {isHost && (
              <>
                {!lobby.isRanked && (
                  <button className="btn btn-ghost" onClick={() => connRef.current?.addBot()}>
                    + Add CPU Commander
                  </button>
                )}
                <button
                  className="btn btn-primary"
                  disabled={!lobby.canStart}
                  onClick={() => connRef.current?.startGame()}
                >
                  ▶ Launch Battle
                </button>
                {!lobby.canStart && <div className="faint" style={{ fontSize: 12 }}>Need all slots filled & ready.</div>}
              </>
            )}
            <button
              className="btn btn-danger"
              onClick={() => {
                connRef.current?.destroy();
                connRef.current = null;
                setLobby(null);
              }}
            >
              Leave Room
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- setup view ----------
  const maxPlayers = mode === 'ai' ? 4 : mode === 'hotseat' ? 4 : onlineMode === 'duel' ? 2 : 4;
  return (
    <div className="portal">
      <h1>⚓ Choose Your Battle</h1>
      <p className="sub">Same archipelago, equal ground, one survivor.</p>

      <div className="mode-grid">
        <div className={`mode-card ${mode === 'ai' ? 'active' : ''}`} onClick={() => setMode('ai')}>
          <div className="ic">🤖</div>
          <h3>Skirmish vs AI</h3>
          <p>Battle a probability-targeting CPU commander. Best way to learn the tide.</p>
        </div>
        <div className={`mode-card ${mode === 'hotseat' ? 'active' : ''}`} onClick={() => setMode('hotseat')}>
          <div className="ic">🛋️</div>
          <h3>Hotseat</h3>
          <p>Pass-and-play on one device. 2–4 commanders, fog hidden between turns.</p>
        </div>
        <div className={`mode-card ${mode === 'online' ? 'active' : ''}`} onClick={() => setMode('online')}>
          <div className="ic">🌐</div>
          <h3>Online</h3>
          <p>Create a room code or join a friend. Duel 1v1 or Free-for-All up to 4.</p>
        </div>
      </div>

      <div className="row" style={{ gap: 20, flexWrap: 'wrap' }}>
        <div className="col" style={{ flex: '1 1 280px' }}>
          <div className="field">
            <label>Commander Name</label>
            <input className="input" value={name} maxLength={16} onChange={(e) => saveName(e.target.value)} />
          </div>
          <div className="field">
            <label>Banner Color</label>
            <div className="color-row">
              {COLORS.map((c, i) => (
                <div
                  key={c}
                  className={`swatch ${colorIdx === i ? 'on' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColorIdx(i)}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="col" style={{ flex: '1 1 280px' }}>
          {mode === 'online' && (
            <div className="field">
              <label>Online Mode</label>
              <div className="seg">
                <button className={online === 'create' ? 'on' : ''} onClick={() => setOnline('create')}>
                  Create
                </button>
                <button className={online === 'join' ? 'on' : ''} onClick={() => setOnline('join')}>
                  Join
                </button>
              </div>
            </div>
          )}

          {!(mode === 'online' && online === 'join') && (
            <>
              {(mode !== 'online' || online === 'create') && mode === 'online' && (
                <>
                  <div className="field">
                    <label>Match Type</label>
                    <div className="seg">
                      <button className={onlineMode === 'duel' ? 'on' : ''} onClick={() => { setOnlineMode('duel'); setNumPlayers(2); }}>
                        Duel 1v1
                      </button>
                      <button className={onlineMode === 'ffa' ? 'on' : ''} onClick={() => { setOnlineMode('ffa'); setNumPlayers(Math.max(3, numPlayers)); }}>
                        Free-for-All
                      </button>
                    </div>
                  </div>
                  <div className="field" style={{ display: 'flex', gap: 20, marginTop: 10 }}>
                    <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={isPrivate}
                        onChange={(e) => setIsPrivate(e.target.checked)}
                        style={{ width: 16, height: 16, cursor: 'pointer' }}
                      />
                      Private Room
                    </label>
                    <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={isRanked}
                        onChange={(e) => setIsRanked(e.target.checked)}
                        style={{ width: 16, height: 16, cursor: 'pointer' }}
                      />
                      Ranked Match
                    </label>
                  </div>
                </>
              )}
              <div className="field">
                <label>{mode === 'ai' ? 'Total Commanders (you + CPUs)' : 'Commanders'}</label>
                <div className="seg">
                  {[2, 3, 4].map((n) => (
                    <button key={n} className={numPlayers === n ? 'on' : ''} disabled={n > maxPlayers} onClick={() => setNumPlayers(n)}>
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              {mode === 'ai' && (
                <div className="field">
                  <label>AI Difficulty</label>
                  <div className="seg">
                    {(['easy', 'normal', 'hard'] as Difficulty[]).map((d) => (
                      <button key={d} className={difficulty === d ? 'on' : ''} onClick={() => setDifficulty(d)}>
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {mode === 'ai' && (
                <div className="field">
                  <label>Spectator Mode (AI vs AI)</label>
                  <div className="seg">
                    <button className={spectate ? 'on' : ''} onClick={() => setSpectate(true)}>
                      On
                    </button>
                    <button className={!spectate ? 'on' : ''} onClick={() => setSpectate(false)}>
                      Off
                    </button>
                  </div>
                </div>
              )}
              <div className="field">
                <label>Map</label>
                <select className="select" value={archetype} onChange={(e) => setArchetype(e.target.value as MapArchetype | 'random')}>
                  <option value="random">Random</option>
                  {ARCHETYPES.map((a) => (
                    <option key={a} value={a}>
                      {ARCHETYPE_NAMES[a]}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          {mode === 'online' && online === 'join' && (
            <div className="field">
              <div className="tab-buttons" style={{ display: 'flex', gap: 10, marginBottom: 15 }}>
                <button
                  type="button"
                  className={`btn btn-sm ${lobbyTab === 'join' ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ padding: '6px 12px', fontSize: 12 }}
                  onClick={() => setLobbyTab('join')}
                >
                  Direct Code
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${lobbyTab === 'list' ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ padding: '6px 12px', fontSize: 12 }}
                  onClick={() => setLobbyTab('list')}
                >
                  Active Lobbies
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${lobbyTab === 'leaderboard' ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ padding: '6px 12px', fontSize: 12 }}
                  onClick={() => setLobbyTab('leaderboard')}
                >
                  Leaderboard
                </button>
              </div>

              {lobbyTab === 'join' && (
                <div className="col">
                  <label>Room Code</label>
                  <input
                    className="input"
                    value={joinCode}
                    maxLength={5}
                    placeholder="ABCD"
                    style={{ textTransform: 'uppercase', letterSpacing: '0.3em', fontFamily: 'var(--font-display)' }}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  />
                </div>
              )}

              {lobbyTab === 'list' && (
                <div className="col" style={{ gap: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label style={{ margin: 0 }}>Available Lobbies</label>
                    <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '2px 8px', fontSize: 11 }} onClick={fetchLobbies} disabled={loadingLobbies}>
                      {loadingLobbies ? 'Refreshing...' : '🔄 Refresh'}
                    </button>
                  </div>
                  {loadingLobbies ? (
                    <div className="faint" style={{ fontSize: 12 }}>Scanning the frequency...</div>
                  ) : lobbies.length === 0 ? (
                    <div className="faint" style={{ fontSize: 12 }}>No public lobbies active. Create one above to start a battle!</div>
                  ) : (
                    <div className="col" style={{ gap: 8, maxHeight: '200px', overflowY: 'auto', paddingRight: 4 }}>
                      {lobbies.map((l) => (
                        <div key={l.code} className="lobby-row" style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '10px 14px',
                          background: 'rgba(29, 74, 110, 0.25)',
                          border: '1px solid rgba(63, 182, 255, 0.2)',
                          borderRadius: '6px',
                          gap: 10
                        }}>
                          <div className="col" style={{ alignItems: 'flex-start', gap: 2 }}>
                            <div style={{ fontWeight: 'bold', fontSize: 13 }}>
                              {l.hostName}'s Fleet <span className="amber" style={{ fontSize: 10 }}>[{l.code}]</span>
                            </div>
                            <div className="faint" style={{ fontSize: 10 }}>
                              {l.mode === 'duel' ? 'Duel 1v1' : 'Free-for-All'} • {l.playersCount}/{l.numPlayers} players
                              {l.isRanked && <span className="amber"> [Ranked]</span>}
                            </div>
                          </div>
                          <button type="button" className="btn btn-primary btn-sm" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => quickJoin(l.code)}>
                            Join ({l.openSeats} seat{l.openSeats > 1 ? 's' : ''})
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {lobbyTab === 'leaderboard' && (
                <div className="col" style={{ gap: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label style={{ margin: 0 }}>Commander Rankings</label>
                    <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '2px 8px', fontSize: 11 }} onClick={fetchLeaderboard} disabled={loadingLeaderboard}>
                      {loadingLeaderboard ? 'Updating...' : '🔄 Update'}
                    </button>
                  </div>
                  {loadingLeaderboard ? (
                    <div className="faint" style={{ fontSize: 12 }}>Fetching rankings...</div>
                  ) : leaderboard.length === 0 ? (
                    <div className="faint" style={{ fontSize: 12 }}>No ranked battles completed yet. Be the first to rule the tide!</div>
                  ) : (
                    <div className="col" style={{ gap: 4, maxHeight: '200px', overflowY: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid rgba(63, 182, 255, 0.2)', textAlign: 'left', opacity: 0.7 }}>
                            <th style={{ padding: '4px 6px' }}>Rank</th>
                            <th style={{ padding: '4px 6px' }}>Commander</th>
                            <th style={{ padding: '4px 6px', textAlign: 'right' }}>Rating</th>
                            <th style={{ padding: '4px 6px', textAlign: 'right' }}>W/L</th>
                          </tr>
                        </thead>
                        <tbody>
                          {leaderboard.map((player, idx) => (
                            <tr key={player.playerId} style={{ borderBottom: '1px solid rgba(63, 182, 255, 0.05)' }}>
                              <td style={{ padding: '6px', color: idx === 0 ? '#ffcf4d' : idx === 1 ? '#e2e2e2' : idx === 2 ? '#b87333' : 'inherit', fontWeight: 'bold' }}>
                                #{idx + 1}
                              </td>
                              <td style={{ padding: '6px', fontWeight: 'bold' }}>{player.name}</td>
                              <td style={{ padding: '6px', textAlign: 'right', color: '#3fb6ff', fontWeight: 'bold' }}>{player.rating}</td>
                              <td style={{ padding: '6px', textAlign: 'right', opacity: 0.7 }}>{player.wins}-{player.losses}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {connErr && <div className="red" style={{ fontSize: 12 }}>{connErr}</div>}

          {mode === 'online' ? (
            online === 'create' ? (
              <button className="btn btn-primary btn-xl" disabled={connecting} onClick={doCreate}>
                {connecting ? 'Connecting…' : '⚓ Create Room'}
              </button>
            ) : (
              <button className="btn btn-primary btn-xl" disabled={connecting} onClick={doJoin}>
                {connecting ? 'Connecting…' : '⚓ Join Room'}
              </button>
            )
          ) : (
            <button className="btn btn-primary btn-xl" onClick={startLocal}>
              ▶ Deploy For Battle
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
