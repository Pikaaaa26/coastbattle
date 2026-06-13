import { useEffect } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import Landing from './pages/Landing';
import Portal from './pages/Portal';
import Codex from './pages/Codex';
import GameScreen from './pages/GameScreen';
import ModelLab from './pages/ModelLab';
import { useSettings } from './store/settings';
import { sfx } from './audio/sfx';

function TopNav() {
  const nav = useNavigate();
  const loc = useLocation();
  const { muted, crt, music, setMuted, setCrt, setMusic } = useSettings();
  if (loc.pathname.startsWith('/game')) return null;
  return (
    <div className="topnav">
      <div className="brand" onClick={() => nav('/')}>
        COAST<span className="tide">BATTLE</span>
      </div>
      <div className="nav-links">
        <button className="btn btn-ghost btn-sm" onClick={() => nav('/codex')}>
          Codex
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => nav('/play')}>
          Play
        </button>
        <button
          className={`icon-toggle ${music ? 'on' : ''}`}
          title="Music"
          onClick={() => setMusic(!music)}
        >
          ♪
        </button>
        <button
          className={`icon-toggle ${!muted ? 'on' : ''}`}
          title="Sound"
          onClick={() => setMuted(!muted)}
        >
          {muted ? '🔇' : '🔊'}
        </button>
        <button className={`icon-toggle ${crt ? 'on' : ''}`} title="CRT filter" onClick={() => setCrt(!crt)}>
          CRT
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const navigate = useNavigate();
  useEffect(() => {
    const unlock = () => sfx.init();
    window.addEventListener('pointerdown', unlock, { once: true });

    // Expose hidden console command to access the Model Lab
    (window as any).showLab = () => {
      console.log("Accessing hidden Model Lab sandbox...");
      navigate('/lab');
      return "Navigating to Model Lab...";
    };

    return () => {
      window.removeEventListener('pointerdown', unlock);
      delete (window as any).showLab;
    };
  }, [navigate]);

  return (
    <div className="shell">
      <div className="crt-overlay" />
      <div className="crt-vignette" />
      <TopNav />
      <div className="content">
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/play" element={<Portal />} />
          <Route path="/codex" element={<Codex />} />
          <Route path="/lab" element={<ModelLab />} />
          <Route path="/game" element={<GameScreen />} />
          <Route path="*" element={<Landing />} />
        </Routes>
      </div>
    </div>
  );
}
