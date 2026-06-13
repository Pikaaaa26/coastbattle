// Synthesized retro SFX — no audio files, everything generated via Web Audio.

class SfxEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  muted = false;
  private musicNodes: { stop: () => void } | null = null;
  musicOn = false;

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);

    // white-noise buffer for percussive/explosion sounds
    const len = this.ctx.sampleRate * 1.2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.5;
  }

  private now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  private tone(
    freq: number,
    dur: number,
    type: OscillatorType = 'square',
    gain = 0.3,
    slideTo?: number,
    delay = 0,
  ) {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.now() + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, gain = 0.4, filterFreq = 1000, delay = 0, sweep = false) {
    if (!this.ctx || !this.master || !this.noiseBuf || this.muted) return;
    const t = this.now() + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(filterFreq, t);
    if (sweep) filter.frequency.exponentialRampToValueAtTime(Math.max(80, filterFreq * 0.1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  click() {
    this.tone(420, 0.05, 'square', 0.18);
  }
  hover() {
    this.tone(620, 0.03, 'square', 0.06);
  }
  deny() {
    this.tone(160, 0.12, 'sawtooth', 0.2, 90);
  }
  coin() {
    this.tone(880, 0.06, 'square', 0.2);
    this.tone(1320, 0.08, 'square', 0.2, undefined, 0.06);
  }
  place() {
    this.tone(220, 0.06, 'square', 0.25);
    this.tone(330, 0.1, 'square', 0.22, undefined, 0.05);
    this.noise(0.08, 0.12, 600, 0.02);
  }
  launch() {
    this.tone(180, 0.3, 'sawtooth', 0.22, 760);
    this.noise(0.3, 0.18, 1800, 0, true);
  }
  splash() {
    this.noise(0.35, 0.3, 900, 0, true);
    this.tone(300, 0.12, 'sine', 0.1, 120);
  }
  explosion() {
    this.noise(0.5, 0.5, 1600, 0, true);
    this.tone(90, 0.4, 'sawtooth', 0.25, 40);
  }
  bigExplosion() {
    this.noise(0.9, 0.6, 2200, 0, true);
    this.tone(70, 0.7, 'sawtooth', 0.3, 30);
    this.tone(120, 0.5, 'square', 0.2, 50, 0.05);
  }
  nuke() {
    this.tone(60, 1.4, 'sawtooth', 0.35, 30);
    this.noise(1.4, 0.6, 2600, 0.1, true);
    this.tone(200, 1.0, 'square', 0.18, 40, 0.2);
  }
  radar() {
    this.tone(1200, 0.12, 'sine', 0.14, 1800);
    this.tone(900, 0.1, 'sine', 0.1, 1400, 0.12);
  }
  reveal() {
    this.tone(700, 0.07, 'triangle', 0.16, 1100);
    this.tone(1100, 0.07, 'triangle', 0.14, 1500, 0.06);
  }
  intercept() {
    this.tone(1500, 0.06, 'square', 0.2, 600);
    this.noise(0.12, 0.2, 3000);
  }
  turnStart() {
    this.tone(523, 0.08, 'square', 0.16);
    this.tone(784, 0.1, 'square', 0.16, undefined, 0.08);
  }
  win() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.18, 'square', 0.22, undefined, i * 0.12));
  }
  lose() {
    [400, 330, 262, 196].forEach((f, i) => this.tone(f, 0.25, 'sawtooth', 0.22, undefined, i * 0.14));
  }

  toggleMusic(on?: boolean) {
    const want = on ?? !this.musicOn;
    if (want === this.musicOn) return this.musicOn;
    this.musicOn = want;
    if (!want) {
      this.musicNodes?.stop();
      this.musicNodes = null;
      return false;
    }
    this.init();
    if (!this.ctx || !this.master) return false;
    // slow, brooding naval arpeggio + drone
    const ctx = this.ctx;
    const bus = ctx.createGain();
    bus.gain.value = 0.12;
    bus.connect(this.master);
    const drone = ctx.createOscillator();
    drone.type = 'sine';
    drone.frequency.value = 55;
    const dg = ctx.createGain();
    dg.gain.value = 0.5;
    drone.connect(dg).connect(bus);
    drone.start();
    const seq = [220, 277, 330, 277, 246, 330, 392, 330];
    let i = 0;
    const interval = window.setInterval(() => {
      if (this.muted) return;
      const f = seq[i % seq.length];
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(bus);
      o.start(t);
      o.stop(t + 0.55);
      i++;
    }, 460);
    this.musicNodes = {
      stop: () => {
        clearInterval(interval);
        try {
          drone.stop();
        } catch {
          /* noop */
        }
      },
    };
    return true;
  }
}

export const sfx = new SfxEngine();
