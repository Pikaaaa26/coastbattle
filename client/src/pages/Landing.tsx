import { useNavigate } from 'react-router-dom';
import { HeroCanvas } from '../components/HeroCanvas';

export default function Landing() {
  const nav = useNavigate();
  return (
    <div className="landing">
      <div className="hero">
        <HeroCanvas />
        <div className="hero-inner">
          <h1 className="logo">
            COAST<span className="tide">BATTLE</span>
          </h1>
          <div className="tagline">BUILD · BOMBARD · RULE THE TIDE</div>
          <p className="subtag">
            A retro naval war of base-building and bombardment across a shared archipelago. Raise power,
            research, and weapons on your islands — then hunt the enemy through the fog and sink their
            command base into the sea.
          </p>
          <div className="cta-row">
            <button className="btn btn-primary btn-xl" onClick={() => nav('/play')}>
              ▶ Play Now
            </button>
            <button className="btn btn-xl" onClick={() => nav('/codex')}>
              Codex
            </button>
          </div>
        </div>
      </div>

      <div className="section">
        <h2>A Battleship You've Never Played</h2>
        <p className="sub">Classic naval guessing — reinvented as a build-and-bombard strategy duel.</p>
        <div className="feature-grid">
          <div className="feature">
            <div className="ic">🏝️</div>
            <h3>4 Island Maps</h3>
            <p>
              Twin Continents, Scattered Atolls, The Ring, and Fractured Bay — procedurally generated, 20×20,
              with mountains, reefs and impassable seas. Both commanders fight the same map.
            </p>
          </div>
          <div className="feature">
            <div className="ic">⚡</div>
            <h3>Living Economy</h3>
            <p>
              No fixed fleet. Start with a Base and 2⚡. Build Power Plants, Research, Radar, Shields and
              Silos turn by turn. Every structure is a target.
            </p>
          </div>
          <div className="feature">
            <div className="ic">🌫️</div>
            <h3>Fog & Detection</h3>
            <p>
              Enemy structures hide beneath the waves. Sweep with radar and sonar, jam their signals, and
              fire blind with probability on your side.
            </p>
          </div>
          <div className="feature">
            <div className="ic">☢️</div>
            <h3>Escalate to Nukes</h3>
            <p>
              Stack energy into a Nuclear Facility and erase a 3×3 zone — irradiating the ground so nothing
              ever rises there again.
            </p>
          </div>
          <div className="feature">
            <div className="ic">🤖</div>
            <h3>Smart CPU + Hotseat</h3>
            <p>
              Battle a probability-targeting AI commander, pass-and-play on one device, or take it online.
            </p>
          </div>
          <div className="feature">
            <div className="ic">🌐</div>
            <h3>Online 1v1 & FFA</h3>
            <p>
              Spin up a room code and duel a friend, or throw 3–4 commanders onto one map with perfectly
              equal territory.
            </p>
          </div>
        </div>
      </div>

      <div className="section">
        <h2>How It Works</h2>
        <p className="sub">Three phases, one survivor.</p>
        <div className="steps">
          <div className="step">
            <div className="num">1</div>
            <h3 className="amber">DEPLOY</h3>
            <p className="muted">Plant your Command Base anywhere in your island territory.</p>
          </div>
          <div className="step">
            <div className="num">2</div>
            <h3 className="amber">BUILD</h3>
            <p className="muted">Earn ⚡ each turn. Raise economy, detection, defense and weapons.</p>
          </div>
          <div className="step">
            <div className="num">3</div>
            <h3 className="amber">BOMBARD</h3>
            <p className="muted">Scout the fog, rain fire, and destroy every enemy Base to win.</p>
          </div>
        </div>
        <div className="cta-row" style={{ marginTop: 30 }}>
          <button className="btn btn-primary btn-xl" onClick={() => nav('/play')}>
            ▶ Deploy For Battle
          </button>
        </div>
      </div>

      <div className="footer">
        Coast Battle · a retro base-building battleship · built with an authoritative shared engine ·{' '}
        <span className="faint">no two tides are the same</span>
      </div>
    </div>
  );
}
