/**
 * A requestAnimationFrame loop that goes to sleep when there's nothing to do
 * and wakes on input, so an idle tab costs nothing — not even a frame tick.
 */
export interface LoopHooks {
  /** Advance the simulation. */
  update(dt: number, now: number): void;
  /** Draw if anything changed; return whether something was drawn. */
  draw(now: number): boolean;
  /** Is something waiting to be drawn (e.g. deferred by the frame cap)? */
  pending(): boolean;
  /** Is anything mid-gesture or mid-animation? */
  busy(): boolean;
  /** Seconds until something wants to animate on its own, if anything. */
  nextWakeIn(): number | null;
}

/** Idle frames in a row before the loop sleeps. */
const QUIET_FRAMES = 8;
/** Longest step fed to the simulation (s), so a stall can't explode springs. */
const MAX_DT = 1 / 30;

export function startLoop(hooks: LoopHooks) {
  let last = performance.now();
  let running = false;
  let quiet = 0;
  let timer = 0;

  const frame = () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, MAX_DT);
    last = now;
    hooks.update(dt, now);
    const drew = hooks.draw(now);
    quiet = drew || hooks.pending() || hooks.busy() ? 0 : quiet + 1;
    if (quiet <= QUIET_FRAMES) {
      requestAnimationFrame(frame);
      return;
    }
    running = false;
    clearTimeout(timer);
    const t = hooks.nextWakeIn();
    if (t != null) timer = window.setTimeout(wake, t * 1000);
  };

  const wake = () => {
    quiet = 0;
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  };

  for (const ev of ['pointermove', 'pointerdown', 'pointerup', 'pointerout', 'wheel', 'keydown', 'resize', 'deviceorientation']) {
    window.addEventListener(ev, wake, { passive: true, capture: true });
  }
  wake();
  return wake;
}
