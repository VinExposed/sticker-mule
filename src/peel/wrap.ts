/**
 * Wrapping a sticker over the edge of a box (the notebook).
 *
 * A sticker that hangs past an edge doesn't stretch down the side; it folds
 * over the edge, runs down the wall, and if there's still sticker left it
 * carries on along the floor. Measured from the edge, that's distance
 * preserving: `o` cm past the edge ends up `o` cm along the wall/floor path.
 */

export interface Box {
  /** Centre (world XZ), spin, size and height of the top face. */
  x: number;
  z: number;
  yaw: number;
  w: number;
  d: number;
  top: number;
}

export interface Wrapped {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

/** Does a circle around (x, z) stay entirely on the top face? */
export function fitsOn(b: Box, x: number, z: number, radius: number): boolean {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  const dx = x - b.x;
  const dz = z - b.z;
  const lx = Math.abs(c * dx - s * dz);
  const lz = Math.abs(s * dx + c * dz);
  return lx + radius <= b.w / 2 && lz + radius <= b.d / 2;
}

/**
 * Map a point of a sheet lying flat at the box's top height onto the box.
 * Returns false (and leaves `out` alone) if the point is on the top face.
 * `out` receives the world position (y absolute) and outward normal.
 */
export function wrapPoint(b: Box, wx: number, wz: number, out: Wrapped, c = Math.cos(b.yaw), s = Math.sin(b.yaw)): boolean {
  const dx = wx - b.x;
  const dz = wz - b.z;
  const lx = c * dx - s * dz;
  const lz = s * dx + c * dz;
  const hw = b.w / 2;
  const hd = b.d / 2;
  const ox = Math.abs(lx) - hw;
  const oz = Math.abs(lz) - hd;
  if (ox <= 0 && oz <= 0) return false;

  let nlx = 0;
  let nlz = 0;
  let ny = 0;
  let drop = 0;
  let x = lx;
  let z = lz;
  if (ox > 0) {
    const down = Math.min(ox, b.top);
    drop += down;
    x = Math.sign(lx) * (hw + Math.max(0, ox - b.top));
    if (ox < b.top) nlx = Math.sign(lx);
    else ny = 1;
  }
  if (oz > 0) {
    const down = Math.min(oz, b.top);
    drop += down;
    z = Math.sign(lz) * (hd + Math.max(0, oz - b.top));
    if (oz < b.top) nlz = Math.sign(lz);
    else ny = 1;
  }
  drop = Math.min(drop, b.top);
  if (nlx === 0 && nlz === 0) ny = 1;
  const nl = Math.hypot(nlx, ny, nlz);
  out.x = b.x + c * x + s * z;
  out.z = b.z - s * x + c * z;
  out.y = b.top - drop;
  out.nx = (c * nlx + s * nlz) / nl;
  out.ny = ny / nl;
  out.nz = (-s * nlx + c * nlz) / nl;
  return true;
}
