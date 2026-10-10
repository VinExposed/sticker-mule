import { describe, expect, it } from 'vitest';
import { deform, solveArc, solvePeel, type DeformOut, type PeelState } from './model';

const out = (): DeformOut => ({ x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 1 });

describe('solveArc', () => {
  it('inverts s - r sin(s/r)', () => {
    const r = 0.35;
    for (const target of [1e-4, 0.01, 0.1, 0.5, 1.0]) {
      const s = solveArc(target, r);
      expect(s - r * Math.sin(s / r)).toBeCloseTo(target, 6);
    }
  });

  it('clamps to a half turn', () => {
    expect(solveArc(10, 0.3)).toBeCloseTo(Math.PI * 0.3, 9);
    expect(solveArc(-1, 0.3)).toBe(0);
  });
});

describe('deform', () => {
  it('leaves the stuck side alone', () => {
    const s: PeelState = { dx: 1, dy: 0, f: 0, r: 0.3, theta: Math.PI };
    const o = deform(0.5, 0.2, s, out());
    expect(o).toMatchObject({ x: 0.5, y: 0.2, z: 0, nz: 1 });
  });

  it('never stretches the sheet', () => {
    const s: PeelState = { dx: Math.SQRT1_2, dy: Math.SQRT1_2, f: 0.4, r: 0.3, theta: 2.4 };
    // Walk a line across the fold in small steps; 3D length must equal rest length.
    const n = 4000;
    let prev = deform(-2, -2, s, out());
    let length = 0;
    for (let i = 1; i <= n; i++) {
      const t = -2 + (4 * i) / n;
      const p = deform(t, t, s, out());
      length += Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z);
      prev = p;
    }
    expect(length).toBeCloseTo(4 * Math.SQRT2, 3);
  });

  it('keeps normals unit length and continuous across the fold', () => {
    const s: PeelState = { dx: 0, dy: 1, f: 0, r: 0.25, theta: Math.PI };
    for (let y = -2; y < 0.5; y += 0.01) {
      const o = deform(0.3, y, s, out());
      expect(Math.hypot(o.nx, o.ny, o.nz)).toBeCloseTo(1, 9);
    }
    const a = deform(0, -1e-6, s, out());
    expect(a.nz).toBeCloseTo(1, 4);
  });
});

describe('solvePeel', () => {
  const r = 0.35;
  const inward = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
  const grab = { x: -2, y: -2 };

  it('puts the grabbed point under the pointer when folding back', () => {
    for (const reach of [0.05, 0.4, 1.2, 3]) {
      const target = { x: grab.x + inward.x * reach, y: grab.y + inward.y * reach };
      const sol = solvePeel({ grab, target, inward, r });
      expect(sol.outward).toBe(false);
      const p = deform(grab.x, grab.y, sol, out());
      expect(p.x).toBeCloseTo(target.x, 5);
      expect(p.y).toBeCloseTo(target.y, 5);
      expect(p.z).toBeCloseTo(sol.grabZ, 5);
    }
  });

  it('follows the pointer when you fold sideways', () => {
    const target = { x: grab.x + 2.5, y: grab.y };
    const sol = solvePeel({ grab, target, inward, r });
    const p = deform(grab.x, grab.y, sol, out());
    expect(p.x).toBeCloseTo(target.x, 5);
    expect(p.y).toBeCloseTo(target.y, 5);
  });

  it('lifts and builds tension when pulled away', () => {
    const near = solvePeel({ grab, target: { x: grab.x - 0.1, y: grab.y - 0.1 }, inward, r });
    const far = solvePeel({ grab, target: { x: grab.x - 0.6, y: grab.y - 0.6 }, inward, r });
    expect(near.outward).toBe(true);
    expect(far.tension).toBeGreaterThan(near.tension);
    expect(far.grabZ).toBeGreaterThan(near.grabZ);
  });

  it('starts flat', () => {
    const sol = solvePeel({ grab, target: grab, inward, r });
    const p = deform(grab.x, grab.y, sol, out());
    expect(p.z).toBeCloseTo(0, 9);
  });
});
