import * as THREE from 'three/webgpu';

// A fully procedural, cozy soundscape (Web Audio, no files): crackling fire, a slow
// tavern-ish chord pad, and spatialised forge sounds that come from where they happen.
// Browsers only allow audio after a user gesture, so nothing starts until enable().

const CHORDS = [
  [62, 66, 69, 74], // D
  [59, 62, 66, 71], // Bm
  [55, 59, 62, 67], // G
  [57, 61, 64, 69], // A
];
const PENTA = [74, 76, 78, 81, 83, 86];
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export class Soundscape {
  private ctx?: AudioContext;
  private master?: GainNode;
  private noise?: AudioBuffer;
  private chord = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private camPos = new THREE.Vector3();
  private camFwd = new THREE.Vector3();
  private camUp = new THREE.Vector3();
  enabled = false;
  furnace = new THREE.Vector3(0, 1.5, -9);

  /** Must be called from a user gesture (tap/click). */
  enable(): void {
    if (!this.ctx) this.boot();
    void this.ctx!.resume();
    this.master!.gain.setTargetAtTime(0.9, this.ctx!.currentTime, 0.4);
    this.enabled = true;
  }

  disable(): void {
    if (!this.ctx) return;
    this.master!.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
    this.enabled = false;
  }

  private boot(): void {
    const ctx = (this.ctx = new AudioContext());
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    // Gentle glue so stacked clangs never clip.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    this.startFire();
    this.startPad();
  }

  // ------------------------------------------------------------------ helpers

  private at(pos?: THREE.Vector3, gain = 1): AudioNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = gain;
    if (!pos) {
      g.connect(this.master!);
      return g;
    }
    const p = new PannerNode(ctx, { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 4, rolloffFactor: 1.1 });
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
    g.connect(p).connect(this.master!);
    return g;
  }

  private noiseBurst(dest: AudioNode, type: BiquadFilterType, freq: number, q: number, attack: number, decay: number, peak: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random());
    src.stop(t + attack + decay + 0.05);
  }

  private partials(dest: AudioNode, base: number, ratios: number[], decay: number, peak: number, type: OscillatorType = 'sine'): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    ratios.forEach((r, i) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = base * r;
      const g = ctx.createGain();
      const p = peak / (1 + i * 0.8);
      g.gain.setValueAtTime(p, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay / (1 + i * 0.35));
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(t + decay + 0.05);
    });
  }

  // ------------------------------------------------------------------ ambience

  private startFire(): void {
    const ctx = this.ctx!;
    const out = this.at(this.furnace, 1);
    // Low roar: looping brown-ish noise.
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    const g = ctx.createGain();
    g.gain.value = 0.16;
    src.connect(lp).connect(g).connect(out);
    src.start();
    // Crackles and pops.
    this.timers.push(setInterval(() => {
      if (!this.enabled) return;
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        setTimeout(() => this.noiseBurst(out, 'bandpass', 1800 + Math.random() * 3500, 3, 0.001, 0.02 + Math.random() * 0.05, 0.25 + Math.random() * 0.35), Math.random() * 300);
      }
    }, 380));
  }

  private startPad(): void {
    const play = () => {
      if (!this.enabled) return;
      const ctx = this.ctx!;
      const notes = CHORDS[this.chord++ % CHORDS.length]!;
      const t = ctx.currentTime;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.035, t + 2.5);
      g.gain.linearRampToValueAtTime(0.0, t + 8.5);
      lp.connect(g).connect(this.master!);
      for (const n of notes) {
        for (const detune of [-6, 6]) {
          const o = ctx.createOscillator();
          o.type = 'triangle';
          o.frequency.value = hz(n - 12);
          o.detune.value = detune;
          o.connect(lp);
          o.start(t);
          o.stop(t + 9);
        }
      }
      // An occasional plucked note on top, like someone idly playing a lute.
      if (Math.random() < 0.7) {
        const pluck = () => this.partials(this.at(undefined, 0.5), hz(PENTA[Math.floor(Math.random() * PENTA.length)]!), [1, 2, 3], 1.4, 0.05, 'triangle');
        setTimeout(pluck, 1500 + Math.random() * 2000);
        if (Math.random() < 0.5) setTimeout(pluck, 4000 + Math.random() * 2000);
      }
    };
    play();
    this.timers.push(setInterval(play, 8000));
  }

  // ------------------------------------------------------------------ forge sounds

  clang(pos: THREE.Vector3): void {
    if (!this.enabled) return;
    const out = this.at(pos, 0.9);
    this.partials(out, 520 + Math.random() * 60, [1, 2.76, 5.4, 8.93], 0.9, 0.22);
    this.noiseBurst(out, 'highpass', 3000, 0.7, 0.001, 0.05, 0.25);
  }

  hiss(pos: THREE.Vector3): void {
    if (!this.enabled) return;
    this.noiseBurst(this.at(pos, 1), 'highpass', 4200, 0.5, 0.05, 1.1, 0.22);
  }

  fizzle(pos: THREE.Vector3): void {
    if (!this.enabled) return;
    const out = this.at(pos, 1);
    this.partials(out, 220, [1, 1.5], 0.5, 0.12, 'sawtooth');
    this.noiseBurst(out, 'bandpass', 900, 2, 0.01, 0.4, 0.15);
  }

  bell(pos: THREE.Vector3): void {
    if (!this.enabled) return;
    this.partials(this.at(pos, 1), 392, [0.5, 1, 1.19, 1.5, 2, 2.74], 3.2, 0.2);
  }

  whoosh(pos: THREE.Vector3): void {
    if (!this.enabled) return;
    this.noiseBurst(this.at(pos, 1), 'lowpass', 600, 0.8, 0.25, 0.5, 0.3);
  }

  coins(pos: THREE.Vector3): void {
    if (!this.enabled) return;
    const out = this.at(pos, 0.6);
    for (let i = 0; i < 3; i++) setTimeout(() => this.partials(out, 2400 + Math.random() * 1600, [1, 1.5], 0.25, 0.05), i * 70);
  }

  rumble(pos: THREE.Vector3, seconds = 4): void {
    if (!this.enabled) return;
    this.noiseBurst(this.at(pos, 1), 'lowpass', 160, 1, 0.6, seconds, 0.5);
  }

  cheer(pos: THREE.Vector3): void {
    if (!this.enabled) return;
    const out = this.at(pos, 0.7);
    [0, 4, 7, 12].forEach((s, i) => setTimeout(() => this.partials(out, hz(74 + s), [1, 2], 0.5, 0.06, 'triangle'), i * 90));
  }

  /** Keep the listener on the camera so sounds pan as you orbit. */
  update(camera: THREE.Camera): void {
    if (!this.ctx || !this.enabled) return;
    const l = this.ctx.listener;
    camera.getWorldPosition(this.camPos);
    camera.getWorldDirection(this.camFwd);
    this.camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const t = this.ctx.currentTime;
    l.positionX.setTargetAtTime(this.camPos.x, t, 0.05);
    l.positionY.setTargetAtTime(this.camPos.y, t, 0.05);
    l.positionZ.setTargetAtTime(this.camPos.z, t, 0.05);
    l.forwardX.setTargetAtTime(this.camFwd.x, t, 0.05);
    l.forwardY.setTargetAtTime(this.camFwd.y, t, 0.05);
    l.forwardZ.setTargetAtTime(this.camFwd.z, t, 0.05);
    l.upX.setTargetAtTime(this.camUp.x, t, 0.05);
    l.upY.setTargetAtTime(this.camUp.y, t, 0.05);
    l.upZ.setTargetAtTime(this.camUp.z, t, 0.05);
  }
}
