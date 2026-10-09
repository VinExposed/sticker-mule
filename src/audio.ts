/**
 * All sound is synthesised: no assets to load.
 * - peel: adhesive crackle, a stream of tiny filtered clicks whose density
 *   follows how fast the peel front is moving.
 * - pop: the sticker letting go.
 * - slap: a soft thump with a papery transient.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private out!: GainNode;
  private noise!: AudioBuffer;
  private crackleBudget = 0;
  muted = false;

  /**
   * Create the audio graph ahead of time (it starts suspended). Creating an
   * AudioContext can take ~100ms, which we'd rather not spend inside the
   * first click.
   */
  prepare() {
    if (this.ctx) return;
    this.create();
  }

  /** Must be called from a user gesture. */
  unlock() {
    if (!this.ctx) this.create();
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private create() {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    this.out = ctx.createGain();
    this.out.gain.value = this.muted ? 0 : 0.9;
    this.out.connect(comp).connect(ctx.destination);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx) this.out.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.02);
  }

  private grain(t: number, dur: number, freq: number, q: number, gain: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.0008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(this.out);
    src.start(t, Math.random() * 0.9, dur + 0.02);
  }

  /**
   * Call every frame while peeling. `speed` is the peel front speed in cm/s.
   */
  crackle(speed: number, dt: number) {
    if (!this.ctx || this.muted) return;
    const rate = Math.min(260, Math.max(0, speed) * 70); // clicks per second
    this.crackleBudget += rate * dt;
    const now = this.ctx.currentTime;
    let n = 0;
    while (this.crackleBudget >= 1 && n < 12) {
      this.crackleBudget -= 1;
      n++;
      const t = now + Math.random() * dt;
      const loud = 0.05 + Math.random() * 0.12 * Math.min(1, speed / 3);
      this.grain(t, 0.004 + Math.random() * 0.01, 1800 + Math.random() * 4200, 2.5, loud);
    }
    if (this.crackleBudget > 4) this.crackleBudget = 0;
  }

  pop() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this.grain(t, 0.05, 2600, 1.2, 0.35);
    this.grain(t + 0.004, 0.03, 5200, 2, 0.18);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(420, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.07);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.12);
  }

  slap(strength = 1) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = Math.min(1.2, Math.max(0.2, strength));
    // Papery transient.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(5200, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.55 * s, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    src.connect(lp).connect(g).connect(this.out);
    src.start(t, Math.random() * 0.5, 0.15);
    // Body thump.
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.12);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.5 * s, t + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(og).connect(this.out);
    o.start(t);
    o.stop(t + 0.2);
  }

  tick() {
    if (!this.ctx || this.muted) return;
    this.grain(this.ctx.currentTime, 0.012, 3800, 4, 0.08);
  }
}
