import type { Vec2 } from '../math';

/**
 * The peel model.
 *
 * A sticker is an inextensible sheet lying in its local XY plane. Peeling is
 * described by a straight fold line: everything on one side stays stuck to the
 * surface, everything on the other side wraps around a cylinder of radius `r`
 * (the curl you see at the peel front) for up to `theta` radians, then carries
 * on as a straight flap (the bit between your fingers).
 *
 *            straight flap
 *             \
 *              \   <- theta
 *          .--. \
 *         /    \_\___________________   <- stuck part (z = 0)
 *               ^ fold line at u = f
 *
 * Coordinates: `u` runs along the peel direction `d` (pointing from the peeled
 * side into the stuck side), `v` runs along the fold line. Arc length is
 * preserved, so the sheet never stretches.
 */

export interface PeelState {
  /** Unit peel direction (from the peeled side into the stuck side). */
  dx: number;
  dy: number;
  /** Fold position along d. Points with u < f are lifted. */
  f: number;
  /** Curl radius at the peel front. */
  r: number;
  /** Total wrap angle in radians (0 = flat, PI = folded right back). */
  theta: number;
}

export interface DeformOut {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

/** No peel at all: the fold line is far behind the sticker. */
export const FLAT: PeelState = { dx: 1, dy: 0, f: -1e9, r: 0.3, theta: 0 };

/** Map a rest-pose point of the sticker to its peeled position and normal. */
export function deform(px: number, py: number, s: PeelState, out: DeformOut): DeformOut {
  const { dx, dy, f, r, theta } = s;
  const u = px * dx + py * dy;
  if (u >= f || theta === 0) {
    out.x = px;
    out.y = py;
    out.z = 0;
    out.nx = 0;
    out.ny = 0;
    out.nz = 1;
    return out;
  }
  const v = -px * dy + py * dx;
  const dist = f - u;
  const arc = r * theta;
  let uu: number;
  let z: number;
  let phi: number;
  if (dist <= arc && r > 1e-6) {
    phi = dist / r;
    uu = f - r * Math.sin(phi);
    z = r * (1 - Math.cos(phi));
  } else {
    phi = theta;
    const l = dist - arc;
    const c = Math.cos(theta);
    const sn = Math.sin(theta);
    uu = f - r * sn - l * c;
    z = r * (1 - c) + l * sn;
  }
  const nu = Math.sin(phi);
  out.x = uu * dx - v * dy;
  out.y = uu * dy + v * dx;
  out.z = z;
  out.nx = nu * dx;
  out.ny = nu * dy;
  out.nz = Math.cos(phi);
  return out;
}

/**
 * Solve `s - r*sin(s/r) = target` for s in [0, PI*r].
 * This is the arc length you need to peel so that a point on the curl lands
 * `target` further along the peel direction than where it started.
 */
export function solveArc(target: number, r: number): number {
  if (target <= 0) return 0;
  const max = Math.PI * r;
  if (target >= max) return max;
  // g(s) = s - r sin(s/r) is monotonic on [0, PI r]; g ~ s^3 / (6 r^2) near 0
  // which makes a good starting point for Newton, with bisection as a guard.
  let lo = 0;
  let hi = max;
  let s = Math.min(max, Math.cbrt(6 * r * r * target));
  for (let i = 0; i < 24; i++) {
    const g = s - r * Math.sin(s / r) - target;
    if (Math.abs(g) < 1e-7) break;
    if (g > 0) hi = s;
    else lo = s;
    const dg = 1 - Math.cos(s / r);
    let next = dg > 1e-9 ? s - g / dg : (lo + hi) / 2;
    if (next <= lo || next >= hi) next = (lo + hi) / 2;
    s = next;
  }
  return s;
}

export interface PeelInput {
  /** Point you grabbed, in rest-pose sticker coordinates. */
  grab: Vec2;
  /** Where the pointer is now, projected into sticker coordinates. */
  target: Vec2;
  /** Natural peel direction at the grab point (into the sticker). */
  inward: Vec2;
  /** Curl radius. */
  r: number;
}

export interface PeelSolution extends PeelState {
  /** How far the grabbed point has been lifted off the surface. */
  grabZ: number;
  /** Pulling away from the sticker rather than folding it back over itself. */
  outward: boolean;
  /** How hard we're pulling outward (only meaningful when outward). */
  tension: number;
}

/**
 * Turn a drag into a peel.
 *
 * Folding back (dragging over the sticker) is solved exactly: the fold line
 * sits where the grabbed point, wrapped around the curl, lands under the
 * pointer. Pulling away from the sticker can't be satisfied by an
 * inextensible sheet, so it raises the flap instead and builds up tension
 * until the sticker pops free.
 */
export function solvePeel(inp: PeelInput): PeelSolution {
  const { grab, target, inward, r } = inp;
  const ddx = target.x - grab.x;
  const ddy = target.y - grab.y;
  const len = Math.hypot(ddx, ddy);
  const along = ddx * inward.x + ddy * inward.y;

  if (along >= 0 || len < 1e-6) {
    // Blend from the natural direction to the drag direction as the drag grows
    // so a tiny wobble right after grabbing doesn't swing the fold around.
    const w = smoothstep(0, r * 1.5, len);
    let dx = inward.x * (1 - w) + (len > 1e-6 ? (ddx / len) * w : 0);
    let dy = inward.y * (1 - w) + (len > 1e-6 ? (ddy / len) * w : 0);
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl;
    dy /= dl;
    const reach = Math.max(0, ddx * dx + ddy * dy);
    const ug = grab.x * dx + grab.y * dy;
    let sg: number;
    let theta: number;
    if (reach >= Math.PI * r) {
      sg = (reach + Math.PI * r) / 2;
      theta = Math.PI;
    } else {
      sg = solveArc(reach, r);
      theta = r > 0 ? sg / r : 0;
    }
    return {
      dx,
      dy,
      f: ug + sg,
      r,
      theta,
      grabZ: r * (1 - Math.cos(Math.min(theta, Math.PI))),
      outward: false,
      tension: 0,
    };
  }

  // Pulling away: lift, don't fold.
  const away = -along;
  const side = Math.abs(ddx * inward.y - ddy * inward.x);
  const pull = away + side * 0.35;
  const dx = inward.x;
  const dy = inward.y;
  const theta = Math.min(1.35, (pull / (r * 2.2)) * 1.35);
  const sg = r * theta + pull * 0.55;
  const ug = grab.x * dx + grab.y * dy;
  const arc = r * theta;
  const l = Math.max(0, sg - arc);
  return {
    dx,
    dy,
    f: ug + sg,
    r,
    theta,
    grabZ: r * (1 - Math.cos(theta)) + l * Math.sin(theta),
    outward: true,
    tension: pull,
  };
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
