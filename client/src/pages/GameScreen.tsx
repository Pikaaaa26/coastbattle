import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { BuildingType, GameEvent, GameState, Vec } from '@shared/types';
import { BUILDINGS, PALETTE } from '@shared/constants';
import { incomePreview, validPlacements } from '@shared/engine';
import { BoardRenderer } from '../game/renderer';
import { LocalSession } from '../game/session';
import { OnlineConnection } from '../net/online';
import { useGame } from '../store/game';
import { sfx } from '../audio/sfx';
import { BuildingIcon } from '../components/BuildingIcon';

export default function GameScreen() {
  const nav = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<BoardRenderer | null>(null);
  const sfxTimers = useRef<number[]>([]);

  const session = useGame((s) => s.session);
  const view = useGame((s) => s.view);
  const viewer = useGame((s) => s.viewer);
  const tool = useGame((s) => s.tool);
  const hover = useGame((s) => s.hover);
  const validCells = useGame((s) => s.validCells);
  const passInfo = useGame((s) => s.passInfo);
  const ended = useGame((s) => s.ended);
  const error = useGame((s) => s.error);
  const turnBanner = useGame((s) => s.turnBanner);

  const click = useGame((s) => s.click);
  const setHover = useGame((s) => s.setHover);
  const clearTool = useGame((s) => s.clearTool);
  const resumePass = useGame((s) => s.resumePass);
  const canAct = useGame((s) => s.controllable());

  const [showHelp, setShowHelp] = useState(false);
  const [spectating, setSpectating] = useState(false);
  const [timeLeft, setTimeLeft] = useState(60);
  const [surrendered, setSurrendered] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [showLogModal, setShowLogModal] = useState(false);
  const [showEndTurnConfirm, setShowEndTurnConfirm] = useState(false);

  const myBuildings = useMemo(() => {
    return view?.buildings.filter((b) => b.owner === viewer && !b.destroyed) ?? [];
  }, [view?.buildings, viewer]);

  const weapons = useMemo(() => {
    return myBuildings.filter((b) => BUILDINGS[b.type].category === 'weapon' || b.type === 'sonar');
  }, [myBuildings]);

  const hasReadyWeapon = useMemo(() => {
    if (!view) return false;
    return weapons.some((b) => {
      const powering = view.turn < b.operationalTurn;
      const ready = !b.disabled && !powering && b.cooldownLeft === 0;
      return ready;
    });
  }, [view, weapons]);

  const isMobile = window.innerWidth <= 760;
  const gameId = view?.id;
  useEffect(() => {
    setSpectating(false);
  }, [gameId]);

  // 60s move timer countdown for online play
  useEffect(() => {
    if (!session || session.kind !== 'online' || view?.phase === 'ended') {
      return;
    }
    setTimeLeft(60);
    const interval = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [view, session]);

  // redirect if no active session
  useEffect(() => {
    if (!session) nav('/play');
  }, [session, nav]);

  // renderer lifecycle
  useEffect(() => {
    if (!canvasRef.current) return;
    const r = new BoardRenderer(canvasRef.current);
    rendererRef.current = r;
    if ((import.meta as any).env?.DEV) (window as any).__RENDERER = r;
    r.start();
    return () => {
      r.stop();
      rendererRef.current = null;
    };
  }, []);

  // feed view to renderer
  useEffect(() => {
    if (view) rendererRef.current?.setView(view);
  }, [view]);

  // feed interaction to renderer
  useEffect(() => {
    rendererRef.current?.setInteraction({
      mode: tool.mode,
      ghostType: tool.mode === 'placeBase' ? 'base' : tool.buildingType,
      attackW: tool.attackW,
      attackH: tool.attackH,
      rot: tool.rot,
      hover,
      validCells,
      selectedBuildingId: tool.buildingId,
      myIndex: viewer,
    });
  }, [tool, hover, validCells, viewer]);

  // Mobile: pick a recommended position when the tool activates — but keep the spot the
  // player is already aiming at if it's still valid, so rotating (or an economy change)
  // rotates the ghost in place instead of yanking it (and the floating buttons) to a new cell.
  useEffect(() => {
    if (!isMobile || tool.mode === 'idle') return;
    const W = view?.map.width ?? 20;
    const cur = useGame.getState().hover;
    if (cur && validCells && validCells.size > 0 && validCells.has(cur.y * W + cur.x)) return;
    let recommended: Vec | null = null;
    if (validCells && validCells.size > 0) {
      const firstCellIdx = Array.from(validCells)[0];
      recommended = { x: firstCellIdx % W, y: Math.floor(firstCellIdx / W) };
    } else if (tool.mode === 'fire' || tool.mode === 'sonar') {
      const H = view?.map.height ?? 20;
      recommended = { x: Math.floor(W * 0.7), y: Math.floor(H / 2) };
    }
    if (recommended) setHover(recommended);
  }, [tool.mode, tool.buildingType, tool.buildingId, tool.rot, validCells, isMobile, view, setHover]);

  // keyboard: R/Space rotate the current build/aim, Q/E rotate the camera, Esc cancels
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'r' || e.key === 'R') useGame.getState().rotateTool();
      else if (e.key === ' ') {
        e.preventDefault(); // keep Space from scrolling / re-clicking focused buttons
        useGame.getState().rotateTool();
      } else if (e.key === 'q' || e.key === 'Q') rendererRef.current?.rotateCamera(1);
      else if (e.key === 'e' || e.key === 'E') rendererRef.current?.rotateCamera(-1);
      else if (e.key === 'Escape') useGame.getState().clearTool();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // events -> renderer + sfx
  useEffect(() => {
    if (!session) return;
    const off = session.on('events', (events: GameEvent[]) => {
      rendererRef.current?.ingest(events);
      for (const e of events) playEventSfx(e, sfxTimers.current);
    });
    return off;
  }, [session]);

  // save battle log when game ends
  useEffect(() => {
    if (!session) return;
    const off = session.on('end', () => {
      const state = useGame.getState().view;
      if (!state) return;
      
      const battleId = state.id;
      const log = state.log;
      
      fetch('/api/battle-log', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ battleId, log }),
      })
      .then(res => res.json())
      .then(data => {
        console.log('[coast-battle] Battle log submitted successfully:', data);
      })
      .catch(err => {
        console.error('[coast-battle] Failed to submit battle log:', err);
      });
    });
    return off;
  }, [session]);

  // clear renderer markers at a fresh game / cleanup timers
  useEffect(() => {
    return () => {
      sfxTimers.current.forEach((t) => clearTimeout(t));
      sfxTimers.current = [];
    };
  }, []);

  // auto-select base placement during deploy
  useEffect(() => {
    if (view?.phase === 'deploy' && canAct && tool.mode !== 'placeBase') {
      useGame.getState().selectBase();
    }
  }, [view?.phase, canAct, tool.mode]);

  if (!view) {
    return (
      <div className="game-shell center" style={{ color: 'var(--ink-dim)' }}>
        <div className="blink">ESTABLISHING UPLINK…</div>
      </div>
    );
  }

  const me = view.players[viewer];
  const myEnergy = me?.energy ?? 0;
  const income = incomePreview(view, viewer);

  const panRef = useRef<{ x: number; y: number; moved: number; btn: number } | null>(null);
  // multi-touch gesture state: 1 finger = aim, 2 = pan + pinch-zoom, 3 = rotate
  const gestureRef = useRef<{ mode: 'tap' | 'two' | 'three'; cx: number; cy: number; dist: number; moved: number } | null>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  const onCanvasMove = (e: React.MouseEvent) => {
    if (panRef.current) {
      const dx = e.clientX - panRef.current.x;
      const dy = e.clientY - panRef.current.y;
      panRef.current.x = e.clientX;
      panRef.current.y = e.clientY;
      panRef.current.moved += Math.abs(dx) + Math.abs(dy);
      rendererRef.current?.pan(dx, dy);
      return;
    }
    const c = rendererRef.current?.cellAt(e.clientX, e.clientY) ?? null;
    setHover(c);
  };
  const onCanvasClick = (e: React.MouseEvent) => {
    const c = rendererRef.current?.cellAt(e.clientX, e.clientY);
    if (c) {
      if (isMobile && tool.mode !== 'idle') {
        setHover(c);
      } else {
        click(c);
      }
    }
  };
  const onPointerDown = (e: React.MouseEvent) => {
    if (e.button === 1 || e.button === 2) {
      panRef.current = { x: e.clientX, y: e.clientY, moved: 0, btn: e.button };
      e.preventDefault();
    }
  };
  const onPointerUp = (e: React.MouseEvent) => {
    if (panRef.current) {
      const wasDrag = panRef.current.moved > 6;
      const btn = panRef.current.btn;
      panRef.current = null;
      if (!wasDrag && btn === 2) clearTool(); // right-click (no drag) still cancels
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    rendererRef.current?.adjustZoom(e.deltaY < 0 ? 1.12 : 0.9);
  };

  const isOverElement = (clientX: number, clientY: number, selector: string) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  };
  const overUI = (x: number, y: number) =>
    isOverElement(x, y, '.hud') ||
    isOverElement(x, y, '.canvas-log-overlay') ||
    isOverElement(x, y, '.topnav') ||
    isOverElement(x, y, '.floating-confirm');
  const touchInfo = (touches: React.TouchList) => {
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < touches.length; i++) {
      cx += touches[i].clientX;
      cy += touches[i].clientY;
    }
    cx /= touches.length;
    cy /= touches.length;
    const dist =
      touches.length >= 2 ? Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY) : 0;
    return { cx, cy, dist };
  };

  const onTouchStart = (e: React.TouchEvent) => {
    const n = e.touches.length;
    const { cx, cy, dist } = touchInfo(e.touches);
    gestureRef.current = { mode: n >= 3 ? 'three' : n === 2 ? 'two' : 'tap', cx, cy, dist, moved: 0 };
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    const n = e.touches.length;
    const { cx, cy, dist } = touchInfo(e.touches);
    const dx = cx - g.cx;
    const dy = cy - g.cy;
    g.moved += Math.abs(dx) + Math.abs(dy);
    if (g.mode === 'tap' && n === 1) {
      // 1 finger = aim: slide the building/target ghost to the touched cell (never over UI)
      const t = e.touches[0];
      if (tool.mode !== 'idle' && !overUI(t.clientX, t.clientY)) {
        const c = rendererRef.current?.cellAt(t.clientX, t.clientY);
        if (c) setHover(c);
      }
    } else if (g.mode === 'two' && n >= 2) {
      rendererRef.current?.pan(dx, dy); // two-finger drag = pan
      if (g.dist > 0 && dist > 0) rendererRef.current?.adjustZoom(dist / g.dist); // pinch = zoom
    } else if (g.mode === 'three' && n >= 3) {
      rendererRef.current?.rotateCameraBy(-dx * 0.012); // three-finger horizontal = rotate
    }
    g.cx = cx;
    g.cy = cy;
    g.dist = dist;
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const g = gestureRef.current;
    if (g && g.mode === 'tap' && g.moved < 12 && e.changedTouches.length >= 1) {
      const t = e.changedTouches[0];
      if (!overUI(t.clientX, t.clientY)) {
        const c = rendererRef.current?.cellAt(t.clientX, t.clientY);
        if (c) {
          // mobile: a tap only AIMS (the floating ✓ commits); desktop touch / idle acts immediately
          if (isMobile && tool.mode !== 'idle') setHover(c);
          else click(c);
        }
      }
    }
    if (e.touches.length === 0) {
      gestureRef.current = null;
    } else {
      // some fingers lifted — re-baseline so the remaining gesture doesn't jump
      const n = e.touches.length;
      const { cx, cy, dist } = touchInfo(e.touches);
      gestureRef.current = { mode: n >= 3 ? 'three' : n === 2 ? 'two' : 'tap', cx, cy, dist, moved: 999 };
    }
  };

  // keep the floating confirm/cancel buttons pinned over the building ghost (mobile only)
  useEffect(() => {
    if (!isMobile) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = floatRef.current;
      const r = rendererRef.current;
      if (!el || !r) return;
      const st = useGame.getState();
      const t = st.tool;
      const h = st.hover;
      if (!st.controllable() || t.mode === 'idle' || !h) {
        el.style.display = 'none';
        return;
      }
      let fw = 1;
      let fh = 1;
      if (t.mode === 'build' || t.mode === 'placeBase') {
        const def = BUILDINGS[t.mode === 'placeBase' ? 'base' : t.buildingType || 'silo'];
        fw = t.rot ? def.h : def.w;
        fh = t.rot ? def.w : def.h;
      } else {
        fw = t.attackW || 1;
        fh = t.attackH || 1;
      }
      const pos = r.cellToScreen(h.x + (fw - 1) / 2, h.y + (fh - 1) / 2);
      if (!pos) {
        el.style.display = 'none';
        return;
      }
      el.style.display = 'flex';
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isMobile]);

  // mobile ✓: commit the aimed action directly from fresh store state (robust, no synthetic-click reliance)
  const mobileConfirm = () => {
    const st = useGame.getState();
    const h = st.hover;
    const t = st.tool;
    const sess = st.session;
    if (!sess || !h || t.mode === 'idle' || !st.controllable()) return;
    if (t.mode === 'placeBase') {
      sfx.place();
      sess.submit({ type: 'placeBase', x: h.x, y: h.y });
      useGame.setState({ tool: { mode: 'idle' }, validCells: new Set() });
    } else if (t.mode === 'build' && t.buildingType) {
      sfx.place();
      sess.submit({ type: 'build', building: t.buildingType, x: h.x, y: h.y, rot: t.rot ?? 0 });
    } else if (t.mode === 'sonar' && t.buildingId) {
      sfx.radar();
      sess.submit({ type: 'sonar', buildingId: t.buildingId, x: h.x, y: h.y });
      useGame.setState({ tool: { mode: 'idle' }, validCells: new Set() });
    } else if (t.mode === 'fire' && t.buildingId) {
      if (!st.view || !st.validCells.has(h.y * st.view.map.width + h.x)) {
        st.flashError('Cannot target your own territory');
        return;
      }
      sfx.launch();
      sess.submit({ type: 'fire', buildingId: t.buildingId, x: h.x, y: h.y, rot: t.rot ?? 0 });
      useGame.setState({ tool: { mode: 'idle' }, validCells: new Set() });
    }
  };
  const confirmLabel =
    tool.mode === 'placeBase' ? 'DEPLOY' : tool.mode === 'build' ? 'BUILD' : tool.mode === 'sonar' ? 'SCAN' : 'FIRE';
  // a rotate button is only useful when the footprint is non-square (e.g. napalm 3×1, 2×1 builds)
  const rotatable =
    (tool.mode === 'build' && !!tool.buildingType && BUILDINGS[tool.buildingType].w !== BUILDINGS[tool.buildingType].h) ||
    ((tool.mode === 'fire' || tool.mode === 'sonar') && (tool.attackW ?? 1) !== (tool.attackH ?? 1));

  function leave() {
    sfx.click();
    const me = view?.players[viewer];
    const isAlive = me?.alive ?? true;
    const isSpectator = spectating || (me?.isAI ?? false);
    if (view && view.phase !== 'ended' && !ended && isAlive && !isSpectator) {
      setShowLeaveConfirm(true);
      return;
    }
    useGame.getState().unbind();
    nav('/play');
  }

  function rematch() {
    sfx.click();
    const s = useGame.getState().session;
    if (s instanceof OnlineConnection) {
      s.rematch();
      return;
    }
    if (s instanceof LocalSession) {
      const cfg = s.cfg;
      useGame.getState().unbind();
      const fresh = new LocalSession({ ...cfg, seed: undefined });
      useGame.getState().bind(fresh);
    }
  }

  return (
    <div className="game-shell">
      <div className="board-area">
        <div className="board-top">
          <button className="btn btn-ghost btn-sm" onClick={leave}>
            ‹ Leave
          </button>
          {session instanceof LocalSession && (view.players[viewer]?.isAI || !view.players[viewer]?.alive) && (
            <button
              className={`btn btn-ghost btn-sm ${session.getRevealFog() ? 'on' : ''}`}
              style={{ color: session.getRevealFog() ? 'var(--color-primary)' : '' }}
              onClick={() => {
                session.setRevealFog(!session.getRevealFog());
              }}
            >
              👁️ {session.getRevealFog() ? 'Hide Map' : 'Reveal Map'}
            </button>
          )}
          <span className="tag">TURN {view.turn}</span>
          <button className="btn btn-ghost btn-sm help-toggle" onClick={() => setShowHelp((v) => !v)}>
            ?
          </button>
        </div>

        {/* player roster — top-right overlay on both desktop & mobile */}
        <div className="player-roster">
          {view.turnOrder.map((idx) => {
            const p = view.players[idx];
            const isCurrent = view.currentPlayer === p.index;
            return (
              <div
                key={p.index}
                className={`pchip ${isCurrent ? 'turn' : ''} ${!p.alive ? 'dead' : ''}`}
              >
                <span className="dot" style={{ background: p.color }} />
                {p.name}
                {p.index === viewer && (
                  <span className="faint"> {p.isAI ? '(viewing)' : '(you)'}</span>
                )}
                {p.alive && p.readyShots > 0 && <span className="shots-badge">🎯 x{p.readyShots}</span>}
                {isCurrent && session?.kind === 'online' && !p.isAI && (
                  <span className={`timer-badge ${timeLeft <= 10 ? 'low' : ''}`}>⏱️ {timeLeft}s</span>
                )}
              </div>
            );
          })}
          {/* compact energy readout — mobile only (desktop shows it in the HUD sidebar) */}
          <div className="mobile-energy">
            <div className="me-faction">{view.players[viewer]?.faction?.toUpperCase() ?? 'PLYR'}</div>
            <div className="me-val">
              {myEnergy}
              <small> ⚡</small>
            </div>
            <div className="me-income">+{income}/turn</div>
          </div>
        </div>

        <div className="board-wrap">
          <canvas
            ref={canvasRef}
            onMouseMove={onCanvasMove}
            onClick={onCanvasClick}
            onMouseDown={onPointerDown}
            onMouseUp={onPointerUp}
            onWheel={onWheel}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            onMouseLeave={() => {
              setHover(null);
              panRef.current = null;
            }}
            onContextMenu={(e) => e.preventDefault()}
          />
          {isMobile && (
            <div ref={floatRef} className="floating-confirm" style={{ display: 'none' }}>
              <button
                className="fc-btn fc-yes"
                type="button"
                aria-label={confirmLabel}
                title={confirmLabel}
                onPointerUp={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  mobileConfirm();
                }}
                onTouchEnd={(e) => e.stopPropagation()}
              >
                <svg className="fc-ico" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
                  <path
                    d="M2 8 L6 12 L14 3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="square"
                    strokeLinejoin="miter"
                  />
                </svg>
              </button>
              {rotatable && (
                <button
                  className="fc-btn fc-rot"
                  type="button"
                  aria-label="Rotate"
                  onPointerUp={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    sfx.click();
                    useGame.getState().rotateTool();
                  }}
                  onTouchEnd={(e) => e.stopPropagation()}
                >
                  <svg className="fc-ico" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
                    <path
                      d="M8 3 A5 5 0 1 1 3 8"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="square"
                    />
                    <path d="M8 1 L8 5 L12 3 Z" fill="currentColor" stroke="none" />
                  </svg>
                </button>
              )}
              <button
                className="fc-btn fc-no"
                type="button"
                aria-label="Cancel"
                onPointerUp={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  sfx.click();
                  clearTool();
                }}
                onTouchEnd={(e) => e.stopPropagation()}
              >
                <svg className="fc-ico" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
                  <path
                    d="M3 3 L13 13 M13 3 L3 13"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="square"
                  />
                </svg>
              </button>
            </div>
          )}
          {/* Battle Log Overlay Trigger & Preview */}
          <div
            className="canvas-log-overlay"
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              background: 'rgba(5, 13, 23, 0.85)',
              border: '2px solid var(--line-bright)',
              padding: '6px 10px',
              zIndex: 10,
              boxShadow: 'var(--shadow-hard)',
            }}
          >
            <button
              className="btn btn-square btn-sm"
              style={{
                width: 32,
                height: 32,
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                background: 'var(--panel2)',
                border: '1px solid var(--line-bright)',
                color: 'var(--ink)',
                cursor: 'pointer',
              }}
              onClick={() => setShowLogModal(true)}
              title="Open Full Battle Log"
            >
              📜
            </button>
            <div
              className="canvas-log-text"
              style={{
                display: 'flex',
                flexDirection: 'column',
                fontSize: 9,
                lineHeight: 1.25,
                overflow: 'hidden',
                color: 'var(--ink-dim)',
              }}
            >
              {view.log.slice(-5).reverse().map((l, i) => (
                <div key={i} className={`le ${l.kind}`} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  • {l.text}
                </div>
              ))}
              {view.log.length === 0 && <div className="muted">No logs recorded.</div>}
            </div>
          </div>
          {turnBanner && view.currentPlayer === turnBanner.player && (
            <div className="turn-banner" key={turnBanner.t}>
              {turnBanner.player === viewer && !view.players[viewer]?.isAI ? 'YOUR MOVE' : `${view.players[turnBanner.player]?.name}'S MOVE`}
            </div>
          )}
           {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
          {passInfo && <PassScreen name={passInfo.name} onReady={resumePass} />}
          {showLeaveConfirm && (
            <LeaveConfirmScreen
              onConfirm={() => {
                setShowLeaveConfirm(false);
                setSurrendered(true);
                session?.submit({ type: 'surrender' });
              }}
              onCancel={() => {
                setShowLeaveConfirm(false);
              }}
            />
          )}
          {showLogModal && (
            <div className="overlay" onClick={() => setShowLogModal(false)}>
              <div className="overlay-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520, width: '90%', display: 'flex', flexDirection: 'column', maxHeight: '80vh' }}>
                <div className="panel-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Battle Log</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => setShowLogModal(false)}>✕</button>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', background: '#07151f', padding: '12px 16px', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {view.log.slice().reverse().map((l, i) => (
                    <div key={i} className={`le ${l.kind}`} style={{ fontSize: 13, lineHeight: 1.4 }}>
                      [{l.turn}] {l.text}
                    </div>
                  ))}
                  {view.log.length === 0 && <div className="muted">No battle logs recorded.</div>}
                </div>
              </div>
            </div>
          )}
          {showEndTurnConfirm && (
            <div className="overlay" style={{ zIndex: 1000 }}>
              <div className="overlay-card" style={{ maxWidth: 400 }}>
                <h2 className="defeat" style={{ color: 'var(--amber)', textShadow: '2px 2px 0 #5a3d00' }}>
                  WEAPONS READY
                </h2>
                <p style={{ color: 'var(--ink)', fontSize: 13, margin: '12px 0 20px', lineHeight: 1.5 }}>
                  You still have active weapon systems charged and ready to launch this turn. Are you sure you want to stand down?
                </p>
                <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      sfx.click();
                      setShowEndTurnConfirm(false);
                      session?.submit({ type: 'endTurn' });
                    }}
                  >
                    End Turn
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      sfx.click();
                      setShowEndTurnConfirm(false);
                    }}
                  >
                    Stay
                  </button>
                </div>
              </div>
            </div>
          )}
          {!ended && me && !me.alive && !spectating && (
            <EliminatedScreen surrendered={surrendered} onSpectate={() => setSpectating(true)} onLeave={leave} />
          )}
          {ended && (
            <EndScreen surrendered={surrendered} view={view} viewer={viewer} winner={ended.winner} onRematch={rematch} onLeave={leave} />
          )}
        </div>
      </div>

      <Hud
        view={view}
        viewer={viewer}
        myEnergy={myEnergy}
        income={income}
        canAct={canAct}
        tool={tool}
        onClearTool={clearTool}
        onEndTurn={() => {
          if (hasReadyWeapon) {
            setShowEndTurnConfirm(true);
          } else {
            session?.submit({ type: 'endTurn' });
          }
        }}
      />

      {error && <ErrorToast text={error.text} key={error.t} />}
    </div>
  );
}

// ---------------- HUD ----------------
function Hud({
  view,
  viewer,
  myEnergy,
  income,
  canAct,
  tool,
  onEndTurn,
}: {
  view: GameState;
  viewer: number;
  myEnergy: number;
  income: number;
  canAct: boolean;
  tool: ReturnType<typeof useGame.getState>['tool'];
  onClearTool: () => void;
  onEndTurn: () => void;
}) {
  const [activeTab, setActiveTab] = useState<'build' | 'arsenal'>('build');
  const [drawerOpen, setDrawerOpen] = useState(false); // mobile: collapsible Build/Arsenal drawer
  const selectBuild = useGame((s) => s.selectBuild);
  const selectWeapon = useGame((s) => s.selectWeapon);
  const clearTool = useGame((s) => s.clearTool);
  const rotateTool = useGame((s) => s.rotateTool);
  const session = useGame((s) => s.session);
  const hover = useGame((s) => s.hover);
  const click = useGame((s) => s.click);
  const isMobile = window.innerWidth <= 760;

  const rotatable =
    (tool.mode === 'build' && tool.buildingType && BUILDINGS[tool.buildingType].w !== BUILDINGS[tool.buildingType].h) ||
    ((tool.mode === 'fire' || tool.mode === 'sonar') && (tool.attackW ?? 1) !== (tool.attackH ?? 1));

  const myBuildings = view.buildings.filter((b) => b.owner === viewer && !b.destroyed);
  const hasResearch = myBuildings.some((b) => b.type === 'research');
  const weapons = myBuildings.filter((b) => BUILDINGS[b.type].category === 'weapon' || b.type === 'sonar');

  const paletteInfo = useMemo(() => {
    return PALETTE.map((type) => {
      const d = BUILDINGS[type];
      const count = myBuildings.filter((b) => b.type === type).length;
      const maxed = d.maxCount ? count >= d.maxCount : false;
      const needRes = d.requiresResearch && !hasResearch;
      const spots = canAct && !maxed && !needRes ? validPlacements(view, viewer, type).length : 0;
      const affordable = myEnergy >= d.cost;
      return { type, d, maxed, needRes, spots, affordable, count };
    });
  }, [view, viewer, myEnergy, hasResearch, canAct, myBuildings]);

  const isDeploy = view.phase === 'deploy';
  const isYourTurn = canAct;
  const enemyTurn = view.phase === 'playing' && !canAct && !view.winner && view.currentPlayer !== viewer;

  return (
    <div className={`hud${drawerOpen ? ' drawer-open' : ''}`}>
      <div className="hud-scroll">
        <div className="res-bar">
          <div>
            <div className="energy">
              {myEnergy}
              <small> ⚡</small>
            </div>
            <div className="income">+{income}/turn</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="tag">{view.players[viewer]?.faction?.toUpperCase()}</div>
            <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
              {myBuildings.length} structures
            </div>
          </div>
        </div>

        <div className={`phase-line ${isYourTurn ? 'your' : ''}`}>
          {isDeploy
            ? isYourTurn
              ? '◢ DEPLOY YOUR BASE ◣'
              : 'AWAITING DEPLOYMENT'
            : view.players[viewer]?.isAI
              ? '⏿ SPECTATING BATTLE…'
              : isYourTurn
                ? '◢ YOUR COMMAND ◣'
                : enemyTurn
                  ? '⏿ ENEMY PLOTTING…'
                  : 'STANDBY'}
        </div>

        {isDeploy && isYourTurn && (
          <div className="hint">Click a glowing 2×2 block in your territory to plant your Command Base.</div>
        )}

        {!isDeploy && (
          <div className="panel" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div className="hud-tabs" style={{ display: 'flex', borderBottom: '2px solid var(--line)', background: 'rgba(0,0,0,0.1)' }}>
              <button
                className="drawer-chev"
                aria-label={drawerOpen ? 'Collapse panel' : 'Expand panel'}
                title={drawerOpen ? 'Collapse' : 'Expand'}
                onClick={() => {
                  sfx.click();
                  setDrawerOpen((o) => !o);
                }}
              >
                {drawerOpen ? '▾' : '▴'}
              </button>
              <button
                className={`hud-tab-btn ${activeTab === 'build' ? 'active' : ''}`}
                style={{
                  flex: 1,
                  fontFamily: 'var(--font-display)',
                  fontSize: 10,
                  padding: '10px 4px',
                  background: activeTab === 'build' ? 'rgba(0, 0, 0, 0.25)' : 'transparent',
                  border: 'none',
                  borderBottom: activeTab === 'build' ? '2px solid var(--amber)' : '2px solid transparent',
                  color: activeTab === 'build' ? 'var(--amber)' : 'var(--ink-dim)',
                  cursor: 'pointer',
                  textTransform: 'uppercase',
                  marginBottom: -2
                }}
                onClick={() => {
                  sfx.click();
                  setActiveTab('build');
                  setDrawerOpen(true);
                }}
              >
                Build Yard
              </button>
              <button
                className={`hud-tab-btn ${activeTab === 'arsenal' ? 'active' : ''}`}
                style={{
                  flex: 1,
                  fontFamily: 'var(--font-display)',
                  fontSize: 10,
                  padding: '10px 4px',
                  background: activeTab === 'arsenal' ? 'rgba(0, 0, 0, 0.25)' : 'transparent',
                  border: 'none',
                  borderBottom: activeTab === 'arsenal' ? '2px solid var(--amber)' : '2px solid transparent',
                  color: activeTab === 'arsenal' ? 'var(--amber)' : 'var(--ink-dim)',
                  cursor: 'pointer',
                  textTransform: 'uppercase',
                  marginBottom: -2
                }}
                onClick={() => {
                  sfx.click();
                  setActiveTab('arsenal');
                  setDrawerOpen(true);
                }}
              >
                Arsenal ({weapons.length})
              </button>
            </div>

            {activeTab === 'build' ? (
              <div className="palette" style={{ padding: 6, overflowY: 'auto' }}>
                {paletteInfo.map(({ type, d, maxed, needRes, spots, affordable }) => {
                  const disabled = !isYourTurn || maxed || needRes || spots === 0 || !affordable;
                  const sel = tool.mode === 'build' && tool.buildingType === type;
                  return (
                    <button
                      key={type}
                      className={`pal-btn ${sel ? 'sel' : ''}`}
                      disabled={disabled}
                      title={
                        needRes
                          ? 'Requires a Research Station'
                          : maxed
                            ? `Max ${d.maxCount}`
                            : spots === 0 && isYourTurn
                              ? 'No room in your territory'
                              : d.desc
                      }
                      onClick={() => {
                        selectBuild(type);
                        setDrawerOpen(false); // collapse so the board is tappable for placement
                      }}
                    >
                      <BuildingIcon type={type} size={30} color={view.players[viewer]?.color} />
                      <span className="pal-meta">
                        <div className="pal-name">{d.name}</div>
                        <div className={`pal-cost ${!affordable ? 'cant' : ''}`}>
                          {d.cost}⚡ {d.w}×{d.h}
                        </div>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="col" style={{ padding: 6, gap: 6, overflowY: 'auto' }}>
                {weapons.length === 0 && <div className="hint">No weapons yet. Build a Missile Silo.</div>}
                {weapons.map((b) => {
                  const d = BUILDINGS[b.type];
                  const powering = view.turn < b.operationalTurn;
                  const ready = !b.disabled && !powering && b.cooldownLeft === 0;
                  const status = b.disabled
                    ? 'OFFLINE'
                    : powering
                      ? 'CHARGING'
                      : b.cooldownLeft > 0
                        ? `RELOAD ${b.cooldownLeft}`
                        : 'READY';
                  const stClass = b.disabled ? 'off' : ready ? 'ready' : 'cd';
                  const sel = tool.buildingId === b.id;
                  const canFire = isYourTurn && ready && (!d.fireCost || myEnergy >= d.fireCost);
                  return (
                    <div
                      key={b.id}
                      className={`weapon-row ${sel ? 'sel' : ''} ${!canFire ? 'dis' : ''}`}
                      onClick={() => {
                        if (canFire) {
                          selectWeapon(b.id);
                          setDrawerOpen(false); // collapse so the board is tappable for targeting
                        }
                      }}
                    >
                      <BuildingIcon type={b.type} size={26} color={view.players[viewer]?.color} />
                      <div>
                        <div style={{ fontSize: 12 }}>{d.name}</div>
                        <div className="faint" style={{ fontSize: 10 }}>
                          ({b.x},{b.y}){d.fireCost ? ` · ${d.fireCost}⚡` : ''}
                        </div>
                      </div>
                      <span className={`st ${stClass}`}>{status}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="hud-actions">
        {rotatable && (
          <button className="btn btn-sm" title={isMobile ? 'Rotate' : 'Rotate (Space)'} onClick={rotateTool}>
            ⟳ Rotate{isMobile ? '' : ' (Space)'}
          </button>
        )}
        {tool.mode === 'fire' || tool.mode === 'sonar' ? (
          <button className="btn btn-ghost" onClick={clearTool}>
            Cancel Target
          </button>
        ) : null}
        {!isDeploy && (
          <button
            className="btn btn-primary"
            disabled={!isYourTurn}
            onClick={() => {
              sfx.click();
              onEndTurn();
            }}
          >
            End Turn ▸
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------- overlays ----------------
function EliminatedScreen({
  surrendered,
  onSpectate,
  onLeave,
}: {
  surrendered?: boolean;
  onSpectate: () => void;
  onLeave: () => void;
}) {
  return (
    <div className="overlay">
      <div className="overlay-card">
        <h2 className="defeat">{surrendered ? '☠ SURRENDERED' : '☠ COMMAND BASE LOST'}</h2>
        <p className="muted">
          {surrendered
            ? 'You scuttled your fleet and surrendered the battle. Stay and watch the survivors with full vision of every field, or withdraw with honor.'
            : 'Your fleet is finished — but the war rages on. Stay and watch the survivors with full vision of every field, or withdraw with honor.'}
        </p>
        <div className="row center" style={{ gap: 10, marginTop: 18 }}>
          <button className="btn btn-primary" onClick={onSpectate}>
            ⏿ Spectate
          </button>
          <button className="btn" onClick={onLeave}>
            Exit to Menu
          </button>
        </div>
      </div>
    </div>
  );
}

function LeaveConfirmScreen({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="overlay animate-fade-in">
      <div className="overlay-card">
        <h2 className="red">SURRENDER BATTLE?</h2>
        <p className="muted" style={{ margin: '12px 0 24px' }}>
          Are you sure you want to scuttle your fleet and abandon the battle? This will count as an immediate defeat.
        </p>
        <div className="row center" style={{ gap: 10 }}>
          <button className="btn btn-danger" onClick={onConfirm}>
            Yes, Surrender
          </button>
          <button className="btn btn-primary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function PassScreen({ name, onReady }: { name: string; onReady: () => void }) {
  return (
    <div className="overlay">
      <div className="overlay-card">
        <h2 className="teal">PASS THE DEVICE</h2>
        <p className="muted">Hand control to</p>
        <div className="energy" style={{ color: 'var(--amber)', fontSize: 36, margin: '10px 0' }}>
          {name}
        </div>
        <p className="faint" style={{ fontSize: 12 }}>
          Make sure only {name} is watching — enemy positions are hidden.
        </p>
        <button className="btn btn-primary btn-xl" style={{ marginTop: 16 }} onClick={onReady}>
          I'm {name} — Ready
        </button>
      </div>
    </div>
  );
}

function EndScreen({
  surrendered,
  view,
  viewer,
  winner,
  onRematch,
  onLeave,
}: {
  surrendered?: boolean;
  view: GameState;
  viewer: number;
  winner: number | null;
  onRematch: () => void;
  onLeave: () => void;
}) {
  const won = winner === viewer;
  const me = view.players[viewer];
  const acc = me.stats.shotsFired ? Math.round((me.stats.hits / me.stats.shotsFired) * 100) : 0;
  return (
    <div className="overlay">
      <div className="overlay-card">
        <h2 className={won ? 'victory' : 'defeat'}>
          {surrendered ? '☠ SURRENDERED' : won ? '★ VICTORY ★' : winner === null ? 'STALEMATE' : 'DEFEAT'}
        </h2>
        <p className="muted">
          {surrendered
            ? 'You scuttled your fleet and surrendered the battle.'
            : winner === null
            ? 'The tide claims no master.'
            : `${view.players[winner]?.name} rules the archipelago.`}
        </p>
        <div className="stat-grid">
          <div className="stat">
            <div className="v">{me.stats.shotsFired}</div>
            <div className="k">Shots</div>
          </div>
          <div className="stat">
            <div className="v">{acc}%</div>
            <div className="k">Accuracy</div>
          </div>
          <div className="stat">
            <div className="v">{me.stats.buildingsBuilt}</div>
            <div className="k">Built</div>
          </div>
          <div className="stat">
            <div className="v">{me.stats.hits}</div>
            <div className="k">Hits</div>
          </div>
          <div className="stat">
            <div className="v">{me.stats.nukesLaunched}</div>
            <div className="k">Nukes</div>
          </div>
          <div className="stat">
            <div className="v">{me.stats.buildingsLost}</div>
            <div className="k">Lost</div>
          </div>
        </div>
        <div className="row center" style={{ gap: 10 }}>
          <button className="btn btn-primary" onClick={onRematch}>
            ⟳ New Battle
          </button>
          <button className="btn" onClick={onLeave}>
            Main Menu
          </button>
        </div>
      </div>
    </div>
  );
}

function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay-card" style={{ textAlign: 'left', maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <h2 className="teal" style={{ textAlign: 'center' }}>Field Manual</h2>
        <ul className="muted" style={{ fontSize: 13, lineHeight: 1.8 }}>
          <li>
            <span className="amber">Build:</span> pick a structure, click a glowing cell in your territory.
          </li>
          <li>
            <span className="amber">Fire:</span> click a weapon in the Arsenal, then click a target cell.
          </li>
          <li>
            <span className="amber">R / Space</span> rotates the building or aim footprint.
          </li>
          <li>
            <span className="amber">Q / E</span> rotate the camera · <span className="amber">wheel</span> zooms ·{' '}
            <span className="amber">right-drag</span> pans.
          </li>
          <li>
            <span className="amber">Mobile:</span> tap to aim, then ✓ to place/fire · two-finger drag pans ·
            pinch zooms · three-finger drag rotates.
          </li>
          <li>
            <span className="amber">Right-click</span> (without dragging) cancels the current tool.
          </li>
          <li>Enemy structures hide in fog — radar & sonar reveal them; every hit reveals what you struck.</li>
          <li>Weapons can't fire the turn they're built.</li>
          <li>
            Lose your <span className="red">Research Station</span> and all advanced tech goes dark.
          </li>
          <li>Destroy every enemy Base to win.</li>
        </ul>
        <div className="legend" style={{ marginTop: 12 }}>
          <span className="li"><span className="sw" style={{ background: 'var(--teal)' }} /> your territory</span>
          <span className="li"><span className="sw" style={{ background: 'var(--red)' }} /> enemy territory</span>
          <span className="li"><span className="sw" style={{ background: '#0a1f38' }} /> open sea</span>
          <span className="li"><span className="sw" style={{ background: '#6c6f7d' }} /> mountain (blocks radar)</span>
        </div>
        <div className="row center" style={{ marginTop: 16 }}>
          <button className="btn btn-primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function ErrorToast({ text }: { text: string }) {
  const [show, setShow] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setShow(false), 2600);
    return () => clearTimeout(t);
  }, []);
  if (!show) return null;
  return <div className="toast">⚠ {text}</div>;
}

// ---------------- sfx mapping ----------------
function playEventSfx(e: GameEvent, timers: number[]) {
  const schedule = (fn: () => void, ms: number) => {
    const t = window.setTimeout(fn, ms);
    timers.push(t);
  };
  switch (e.type) {
    case 'missile':
      sfx.launch();
      schedule(() => (e.intercepted ? sfx.intercept() : e.hit ? sfx.explosion() : sfx.splash()), 480);
      break;
    case 'artillery':
      sfx.launch();
      schedule(() => sfx.bigExplosion(), 540);
      break;
    case 'napalm':
      sfx.launch();
      schedule(() => sfx.explosion(), 560);
      break;
    case 'absorbed':
      sfx.intercept();
      break;
    case 'nuke':
      sfx.launch();
      schedule(() => sfx.nuke(), 760);
      break;
    case 'radar':
    case 'sonar':
      sfx.radar();
      break;
    case 'reveal':
      sfx.reveal();
      break;
    case 'build':
      sfx.place();
      break;
    case 'eliminated':
      sfx.bigExplosion();
      break;
    default:
      break;
  }
}
