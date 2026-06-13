import { useNavigate } from 'react-router-dom';
import { BUILDINGS } from '@shared/constants';
import type { BuildingType } from '@shared/types';
import { BuildingIcon } from '../components/BuildingIcon';

const CORE: BuildingType[] = ['base', 'powerplant', 'silo', 'artillery', 'research', 'nuclear'];
const ADV: BuildingType[] = ['radar', 'sonar', 'jammer', 'shield', 'turret', 'repair'];

function Card({ type }: { type: BuildingType }) {
  const d = BUILDINGS[type];
  return (
    <div className="codex-card">
      <BuildingIcon type={type} size={56} color="#3fb6ff" />
      <div className="meta">
        <h3>{d.name}</h3>
        <div className="plot">
          {d.w}×{d.h} plot · {d.cost === 0 ? 'FREE' : `${d.cost}⚡`}
          {d.fireCost ? ` · fire ${d.fireCost}⚡` : ''}
          {d.cooldown ? ` · CD ${d.cooldown}` : ''}
          {d.maxCount ? ` · max ${d.maxCount}` : ''}
        </div>
        <p>{d.desc}</p>
        <span className="cat-pill">{d.category.toUpperCase()}</span>
        {d.requiresResearch && <span className="cat-pill" style={{ color: '#d36bff', borderColor: '#d36bff' }}>NEEDS RESEARCH</span>}
      </div>
    </div>
  );
}

export default function Codex() {
  const nav = useNavigate();
  return (
    <div className="codex">
      <h1>⚓ Field Codex</h1>
      <div className="section" style={{ padding: '0 0 10px' }}>
        <h2>Core Structures</h2>
        <p className="sub">Available to every commander from turn one.</p>
        <div className="codex-grid">
          {CORE.map((t) => (
            <Card key={t} type={t} />
          ))}
        </div>
      </div>
      <div className="section" style={{ padding: '20px 0 10px' }}>
        <h2 style={{ color: '#d36bff' }}>Advanced Tech</h2>
        <p className="sub">
          Unlocked by a living <span className="amber">Research Station</span>. Lose the station and every
          advanced structure goes dark until you rebuild it.
        </p>
        <div className="codex-grid">
          {ADV.map((t) => (
            <Card key={t} type={t} />
          ))}
        </div>
      </div>
      <div className="section" style={{ textAlign: 'center', padding: '20px 0' }}>
        <h2>Doctrine</h2>
        <p className="muted" style={{ maxWidth: 680, margin: '0 auto', lineHeight: 1.7 }}>
          You start with <span className="amber">3⚡</span> and a Base that earns <span className="amber">+2⚡</span> a
          turn. Spend energy to expand. Weapons can't fire the turn they're built. Enemy structures are hidden
          in fog — every hit reveals what you struck. Destroy <span className="red">every enemy Base</span> to
          win. Last commander on the tide takes the archipelago.
        </p>
        <div className="cta-row" style={{ marginTop: 24, justifyContent: 'center' }}>
          <button className="btn btn-primary" onClick={() => nav('/play')}>
            ▶ Play Now
          </button>
        </div>
      </div>
    </div>
  );
}
