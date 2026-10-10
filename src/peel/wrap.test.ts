import { describe, expect, it } from 'vitest';
import { fitsOn, wrapPoint, type Box, type Wrapped } from './wrap';

const box: Box = { x: 2, z: -1, yaw: 0.3, w: 10, d: 14, top: 1.2 };
const out = (): Wrapped => ({ x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 });

/** World point at local (lx, lz) of the box. */
function at(lx: number, lz: number) {
  const c = Math.cos(box.yaw);
  const s = Math.sin(box.yaw);
  return { x: box.x + c * lx + s * lz, z: box.z - s * lx + c * lz };
}

describe('wrapPoint', () => {
  it('leaves the top face alone', () => {
    const p = at(3, -4);
    expect(wrapPoint(box, p.x, p.z, out())).toBe(false);
  });

  it('runs down the wall without stretching', () => {
    const edge = at(5, 2);
    const o = out();
    const p = at(5.5, 2);
    expect(wrapPoint(box, p.x, p.z, o)).toBe(true);
    // Half a cm past the edge -> half a cm down the wall, still at the edge.
    expect(o.y).toBeCloseTo(box.top - 0.5, 9);
    expect(Math.hypot(o.x - edge.x, o.z - edge.z)).toBeCloseTo(0, 9);
    // Normal points straight out of the wall.
    expect(o.ny).toBeCloseTo(0, 9);
    expect(Math.hypot(o.nx, o.nz)).toBeCloseTo(1, 9);
  });

  it('continues across the floor after the wall', () => {
    const o = out();
    const p = at(5 + box.top + 0.7, 2);
    wrapPoint(box, p.x, p.z, o);
    const foot = at(5.7, 2);
    expect(o.y).toBeCloseTo(0, 9);
    expect(o.x).toBeCloseTo(foot.x, 9);
    expect(o.z).toBeCloseTo(foot.z, 9);
    expect(o.ny).toBeCloseTo(1, 9);
  });
});

describe('fitsOn', () => {
  it('knows when a sticker hangs over an edge', () => {
    const c = at(0, 0);
    expect(fitsOn(box, c.x, c.z, 3)).toBe(true);
    const e = at(4, 0);
    expect(fitsOn(box, e.x, e.z, 3)).toBe(false);
  });
});
