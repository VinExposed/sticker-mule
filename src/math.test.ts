import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { rotateToLocal, rotateToWorld } from './math';

describe('rotateToWorld / rotateToLocal', () => {
  it('match three.js rotation.y for sticker space (x right, y down = +z)', () => {
    const yaw = 0.7;
    const v = new THREE.Vector3(1.5, 0, -2).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const w = rotateToWorld(1.5, -2, yaw);
    expect(w.x).toBeCloseTo(v.x, 12);
    expect(w.y).toBeCloseTo(v.z, 12);
  });

  it('invert each other', () => {
    const w = rotateToWorld(0.3, -4.2, -2.1);
    const l = rotateToLocal(w.x, w.y, -2.1);
    expect(l.x).toBeCloseTo(0.3, 12);
    expect(l.y).toBeCloseTo(-4.2, 12);
  });
});
