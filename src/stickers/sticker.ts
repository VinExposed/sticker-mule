import * as THREE from 'three';
import { deform, type DeformOut, type PeelState } from '../peel/model';
import { fitsOn, wrapPoint, type Box, type Wrapped } from '../peel/wrap';
import type { StickerSource } from './factory';
import { stickerMaterials, type StickerMaterials } from './materials';

export type StickerMode = 'stuck' | 'peeling' | 'carried' | 'dropping';


let nextId = 1;
const tmp: DeformOut = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 1 };
const wrapped: Wrapped = { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 };
const m4 = new THREE.Matrix4();
const m4b = new THREE.Matrix4();
const q = new THREE.Quaternion();
const yAxis = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const v3 = new THREE.Vector3();

/**
 * One sticker: a finely tessellated sheet whose vertices are recomputed on the
 * CPU whenever it's moving. Resting stickers cost nothing per frame.
 */
export class Sticker {
  readonly id = nextId++;
  readonly src: StickerSource;
  readonly root = new THREE.Group();
  readonly front: THREE.Mesh;
  readonly back: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  materials: StickerMaterials;

  /** Rest-pose vertex positions in sticker space (cm, y down). */
  private rest: Float32Array;
  private cols: number;
  private rows: number;

  mode: StickerMode = 'stuck';
  /** Centre on the surface (world XZ) and spin around the vertical axis. */
  x = 0;
  z = 0;
  yaw = 0;
  /** Surface height at the centre plus stacking offset. */
  baseY = 0;
  layer = 0;
  surface: string = 'desk';

  /** Peel shape while stuck/peeling. */
  peel: PeelState = { dx: 1, dy: 0, f: -1e9, r: 0.3, theta: 0 };

  /** Carried pose: pivot (the point you're holding) in world, plus tilt. */
  pivot = new THREE.Vector3();
  grab = new THREE.Vector2();
  tilt = new THREE.Quaternion();
  /** Bend while carried/dropping: cm of lift at `bendReach` from the held point. */
  bend = 0;
  bendReach = 1;

  /** What it's stuck to; parts hanging past its edges wrap over them. */
  support: Box | null = null;
  dirty = true;

  constructor(src: StickerSource, maxAniso: number) {
    this.src = src;
    const long = 84;
    this.cols = Math.max(12, Math.round((src.width / Math.max(src.width, src.height)) * long));
    this.rows = Math.max(12, Math.round((src.height / Math.max(src.width, src.height)) * long));
    const { geometry, rest } = grid(src.width, src.height, this.cols, this.rows);
    this.geometry = geometry;
    this.rest = rest;
    this.materials = stickerMaterials(src, maxAniso);
    this.front = new THREE.Mesh(geometry, this.materials.front);
    this.back = new THREE.Mesh(geometry, this.materials.back);
    for (const m of [this.front, this.back]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.sticker = this;
      this.root.add(m);
    }
    this.root.matrixAutoUpdate = false;
  }

  setMaterials(m: StickerMaterials) {
    this.materials.dispose();
    this.materials = m;
    this.front.material = m.front;
    this.back.material = m.back;
  }

  /** World XZ of a sticker-space point when lying flat. */
  toWorld(px: number, py: number, out = new THREE.Vector2()) {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    return out.set(this.x + c * px + s * py, this.z - s * px + c * py);
  }

  /** Sticker-space point under a world XZ position (when lying flat). */
  toLocal(wx: number, wz: number, out = new THREE.Vector2()) {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const dx = wx - this.x;
    const dz = wz - this.z;
    return out.set(c * dx - s * dz, s * dx + c * dz);
  }

  radius() {
    return 0.5 * Math.hypot(this.src.width, this.src.height);
  }

  /** Recompute the transform and the deformed vertices. */
  update(): boolean {
    if (!this.dirty) return false;
    this.dirty = false;
    const flying = this.mode === 'carried' || this.mode === 'dropping';
    const peel = this.peel;
    const flat = Math.abs(peel.theta) <= 1e-4 || peel.f < -1e8;

    if (flying) {
      // M = T(pivot) * tilt * Ry(yaw) * T(-grab'), where grab' is the held
      // point in its current (possibly still curled) shape. Holding that point
      // fixed is what makes a just-popped flap unfold around your fingers.
      const gd = flat ? { x: this.grab.x, y: this.grab.y, z: 0 } : deform(this.grab.x, this.grab.y, peel, { ...tmp });
      q.setFromAxisAngle(yAxis, this.yaw).premultiply(this.tilt);
      m4.compose(this.pivot, q, ONE);
      m4b.makeTranslation(-gd.x, -gd.z, -gd.y);
      this.root.matrix.multiplyMatrices(m4, m4b);
    } else {
      q.setFromAxisAngle(yAxis, this.yaw);
      m4.compose(v3.set(this.x, this.baseY, this.z), q, ONE);
      this.root.matrix.copy(m4);
    }
    this.root.matrixWorldNeedsUpdate = true;

    const pos = this.geometry.attributes.position.array as Float32Array;
    const nor = this.geometry.attributes.normal.array as Float32Array;
    const rest = this.rest;
    const n = rest.length / 2;
    const sup = !flying && this.support && !fitsOn(this.support, this.x, this.z, this.radius()) ? this.support : null;
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const gx = this.grab.x;
    const gy = this.grab.y;
    const k = flying ? this.bend / (this.bendReach * this.bendReach) : 0;
    const floor = this.mode === 'dropping' ? this.baseY - this.pivot.y : -Infinity;

    for (let i = 0; i < n; i++) {
      const px = rest[i * 2];
      const py = rest[i * 2 + 1];
      let d: DeformOut;
      if (flat) {
        tmp.x = px;
        tmp.y = py;
        tmp.z = 0;
        tmp.nx = 0;
        tmp.ny = 0;
        tmp.nz = 1;
        d = tmp;
      } else {
        d = deform(px, py, peel, tmp);
      }
      let y = d.z;
      let nx = d.nx;
      let ny = d.nz;
      let nz = d.ny;
      if (k !== 0) {
        // Radial bend around the held point: droops while carried, edges
        // spring up then slap down while landing.
        const ex = px - gx;
        const ey = py - gy;
        y += k * (ex * ex + ey * ey);
        if (y < floor) y = floor;
        else {
          nx -= 2 * k * ex;
          nz -= 2 * k * ey;
          const l = 1 / Math.hypot(nx, ny, nz);
          nx *= l;
          ny *= l;
          nz *= l;
        }
      } else if (sup && d.z < 1e-5 && wrapPoint(sup, this.x + c * d.x + s * d.y, this.z - s * d.x + c * d.y, wrapped)) {
        // Hanging past the edge: fold over it, down the side, onto the desk.
        const L = this.layer;
        const ox = wrapped.x + wrapped.nx * L - this.x;
        const oz = wrapped.z + wrapped.nz * L - this.z;
        pos[i * 3] = c * ox - s * oz;
        pos[i * 3 + 1] = wrapped.y + wrapped.ny * L - this.baseY;
        pos[i * 3 + 2] = s * ox + c * oz;
        nor[i * 3] = c * wrapped.nx - s * wrapped.nz;
        nor[i * 3 + 1] = wrapped.ny;
        nor[i * 3 + 2] = s * wrapped.nx + c * wrapped.nz;
        continue;
      }
      pos[i * 3] = d.x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = d.y;
      nor[i * 3] = nx;
      nor[i * 3 + 1] = ny;
      nor[i * 3 + 2] = nz;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
    this.geometry.computeBoundingSphere();
    return true;
  }

  /** World position of a rest-pose point in the current shape. */
  worldPoint(px: number, py: number, out = new THREE.Vector3()) {
    const flat = Math.abs(this.peel.theta) <= 1e-4 || this.peel.f < -1e8;
    const d = flat ? { x: px, y: py, z: 0 } : deform(px, py, this.peel, { ...tmp });
    return out.set(d.x, d.z, d.y).applyMatrix4(this.root.matrix);
  }

  dispose() {
    this.geometry.dispose();
    this.materials.dispose();
  }
}

/** Grid in sticker space: x right, y down (matching the canvas), lift on +Y. */
function grid(w: number, h: number, cols: number, rows: number) {
  const n = (cols + 1) * (rows + 1);
  const rest = new Float32Array(n * 2);
  const position = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  let i = 0;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      const v = r / rows;
      const x = (u - 0.5) * w;
      const y = (v - 0.5) * h;
      rest[i * 2] = x;
      rest[i * 2 + 1] = y;
      position[i * 3] = x;
      position[i * 3 + 2] = y;
      normal[i * 3 + 1] = 1;
      uv[i * 2] = u;
      uv[i * 2 + 1] = 1 - v;
      i++;
    }
  }
  const index: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;
      const b = a + 1;
      const d = a + cols + 1;
      const e = d + 1;
      // Counter-clockwise seen from +Y (x right, z toward the viewer).
      index.push(a, d, b, b, d, e);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return { geometry, rest };
}
