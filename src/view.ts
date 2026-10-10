import { clamp, easeInOutCubic } from './math';
import type { World } from './scene/world';

/** Tilt limits (radians) for dragging the desk around. */
const YAW_LIMIT = 0.6;
const PITCH_MIN = -0.42;
const PITCH_MAX = 0.22;
/** How long the opening shot takes to settle (s). */
const INTRO_SECONDS = 2.4;

/**
 * Where the camera points: the opening shot, tilting the desk by dragging
 * (it swings back when you let go), and a little parallax from the pointer
 * or the phone's gyro so the holo foil always has something to play with.
 */
export class ViewControl {
  readonly reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private intro = 0;
  private tilt = { yaw: 0, pitch: 0 };
  private drag: { x: number; y: number; yaw: number; pitch: number } | null = null;
  private gyro: { x: number; y: number; base: { b: number; g: number } | null } | null = null;
  private gyroRequested = false;

  constructor(
    private world: World,
    private wake: () => void,
  ) {
    if (this.reduceMotion) this.intro = 1;
  }

  get introDone() {
    return this.intro >= 1;
  }

  get dragging() {
    return this.drag !== null;
  }

  startDrag(x: number, y: number) {
    this.drag = { x, y, ...this.tilt };
  }

  dragTo(x: number, y: number) {
    const d = this.drag;
    if (!d) return;
    this.tilt.yaw = clamp(d.yaw - (x - d.x) * 0.0035, -YAW_LIMIT, YAW_LIMIT);
    this.tilt.pitch = clamp(d.pitch + (y - d.y) * 0.003, PITCH_MIN, PITCH_MAX);
  }

  endDrag() {
    this.drag = null;
  }

  /** Scroll wheel / trackpad: tilt by a nudge. */
  nudge(dx: number, dy: number) {
    this.tilt.pitch = clamp(this.tilt.pitch - dy * 0.0015, PITCH_MIN, PITCH_MAX);
    this.tilt.yaw = clamp(this.tilt.yaw - dx * 0.0015, -YAW_LIMIT, YAW_LIMIT);
  }

  /**
   * Phones: tilt the device to catch the light on the holo foil. iOS only
   * allows the permission prompt from a user activation (a touch *release*).
   */
  requestGyro() {
    if (this.gyroRequested || this.reduceMotion || !('DeviceOrientationEvent' in window)) return;
    this.gyroRequested = true;
    const start = () => {
      this.gyro = { x: 0, y: 0, base: null };
      window.addEventListener('deviceorientation', (e) => {
        if (e.beta == null || e.gamma == null || !this.gyro) return;
        const g = this.gyro;
        g.base ??= { b: e.beta, g: e.gamma };
        // Slowly re-centre so however you hold the phone becomes "level".
        g.base.b += (e.beta - g.base.b) * 0.01;
        g.base.g += (e.gamma - g.base.g) * 0.01;
        // Ignore changes smaller than sensor noise, so a phone lying still
        // doesn't keep the scene redrawing.
        const x = clamp((e.gamma - g.base.g) / 25, -1, 1);
        const y = clamp(-(e.beta - g.base.b) / 25, -1, 1);
        if (Math.abs(x - g.x) < 0.02 && Math.abs(y - g.y) < 0.02) return;
        g.x = x;
        g.y = y;
        this.wake();
      });
    };
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof DOE.requestPermission === 'function') {
      DOE.requestPermission()
        .then((r) => r === 'granted' && start())
        .catch(() => {});
    } else start();
  }

  /** `pointer` is in normalised device coords, or null when it's off the canvas. */
  update(dt: number, pointer: { x: number; y: number } | null) {
    let px = 0;
    let py = 0;
    if (this.gyro) {
      px = this.gyro.x;
      py = this.gyro.y;
    } else if (pointer && !this.drag && !this.reduceMotion) {
      px = pointer.x;
      py = pointer.y;
    }
    // Let go of a tilt and the desk swings back, like a lazy susan.
    if (!this.drag) {
      const k = 1 - Math.exp(-dt * 2.2);
      this.tilt.yaw -= this.tilt.yaw * k;
      this.tilt.pitch -= this.tilt.pitch * k;
      if (Math.abs(this.tilt.yaw) + Math.abs(this.tilt.pitch) < 3e-4) this.tilt.yaw = this.tilt.pitch = 0; // ~half a pixel
    }
    // Opening shot: start low and turned, settle into the top-down view.
    let introYaw = 0;
    let introPitch = 0;
    if (this.intro < 1) {
      this.intro = Math.min(1, this.intro + dt / INTRO_SECONDS);
      const e = 1 - easeInOutCubic(this.intro);
      introYaw = 0.5 * e;
      introPitch = -0.5 * e;
    }
    const orbit = this.world.orbit;
    orbit.tYaw = this.tilt.yaw - px * 0.05 + introYaw;
    orbit.tPitch = this.tilt.pitch - py * 0.035 + introPitch;
    // The intro is choreographed: follow it exactly instead of easing.
    if (this.intro < 1) this.world.kick(orbit.tYaw - orbit.yaw, orbit.tPitch - orbit.pitch);
    this.world.tick(dt);
  }
}
