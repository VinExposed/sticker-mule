/** Small numeric helpers shared across the app. */

export interface Vec2 {
  x: number;
  y: number;
}

export function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x));
}

export function lerp2(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function normalize2(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / l, y: a.y / l };
}

export function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Sticker/surface space (x right, y down) to a world XZ offset for something
 * spun `yaw` radians about +Y. Matches three's rotation.y.
 */
export function rotateToWorld(x: number, y: number, yaw: number, out: Vec2 = { x: 0, y: 0 }): Vec2 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out.x = c * x + s * y;
  out.y = -s * x + c * y;
  return out;
}

/** Inverse of rotateToWorld. */
export function rotateToLocal(x: number, z: number, yaw: number, out: Vec2 = { x: 0, y: 0 }): Vec2 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out.x = c * x - s * z;
  out.y = s * x + c * z;
  return out;
}
