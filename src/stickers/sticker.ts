import * as THREE from 'three';
import { deform, FLAT, type DeformOut, type PeelState } from '../peel/model';
import { fitsOn, wrapPoint, type Box, type Wrapped } from '../peel/wrap';
import type { StickerSource } from './factory';
import { rotateToLocal, rotateToWorld } from '../math';
import { acquireMaterials, type StickerMaterials } from './materials';
import { splitGeometry, type SplitGeometry } from './split';

export type StickerMode = 'stuck' | 'peeling' | 'carried' | 'dropping';
const MODE_INDEX: Record<StickerMode, number> = { stuck: 0, peeling: 1, carried: 2, dropping: 3 };

/** Thickness of one sticker (cm): stacked stickers sit this far apart. */
export const LAYER = 0.012;

const tmp: DeformOut = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 1 };
const wrapped: Wrapped = { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 };
const scratchPoint: DeformOut = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 1 };
const offset = { x: 0, y: 0 };
const m4 = new THREE.Matrix4();
const m4b = new THREE.Matrix4();
const q = new THREE.Quaternion();
const yAxis = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const v3 = new THREE.Vector3();

/**
 * One sticker. Resting flat, it's two static meshes cut from its silhouette
 * (see split.ts). While it curls, wraps or flies it switches to a finely
 * tessellated grid whose vertices are recomputed on the CPU, only on frames
 * where something changed.
 */
export class Sticker {
  readonly src: StickerSource;
  readonly root = new THREE.Group();
  readonly front: THREE.Mesh;
  /** Opaque interior while resting (see split.ts). */
  readonly core: THREE.Mesh;
  /** Depth pre-pass for the resting edge band. */
  readonly edgeDepth: THREE.Mesh;
  readonly back: THREE.Mesh;
  /** Fine grid for curling, wrapping and flying; built on first use. */
  private geometry: THREE.BufferGeometry | null = null;
  private readonly flat: SplitGeometry;
  readonly materials: StickerMaterials;

  /** Rest-pose vertex positions in sticker space (cm, y down). */
  private rest: Float32Array | null = null;
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
  peel: PeelState = { ...FLAT };

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
    this.flat = splitGeometry(src);
    this.materials = acquireMaterials(src, maxAniso);
    this.front = new THREE.Mesh(this.flat.edge, this.materials.front);
    this.core = new THREE.Mesh(this.flat.core, this.materials.core);
    this.edgeDepth = new THREE.Mesh(this.flat.edge, this.materials.edgeDepth);
    this.back = new THREE.Mesh(this.flat.edge, this.materials.back);
    this.back.visible = false;
    for (const m of [this.front, this.core, this.edgeDepth, this.back]) {
      // One shadow caster per surface.
      m.castShadow = m === this.front || m === this.core;
      m.receiveShadow = true;
      m.userData.sticker = this;
      this.root.add(m);
    }
    this.root.matrixAutoUpdate = false;
  }

  /** World XZ of a sticker-space point when lying flat. */
  toWorld(px: number, py: number, out = new THREE.Vector2()) {
    rotateToWorld(px, py, this.yaw, offset);
    return out.set(this.x + offset.x, this.z + offset.y);
  }

  /** Sticker-space point under a world XZ position (when lying flat). */
  toLocal(wx: number, wz: number, out = new THREE.Vector2()) {
    rotateToLocal(wx - this.x, wz - this.z, this.yaw, offset);
    return out.set(offset.x, offset.y);
  }

  /** Where the centre lands (world XZ) if laid flat with the held point at the pivot. */
  centreUnderPivot(out = new THREE.Vector2()) {
    rotateToWorld(this.grab.x, this.grab.y, this.yaw, offset);
    return out.set(this.pivot.x - offset.x, this.pivot.z - offset.y);
  }

  /** Half the diagonal: no part of the sticker is further than this from its centre. */
  radius() {
    return 0.5 * Math.hypot(this.src.width, this.src.height);
  }

  /** No curl at all (the peel model is a no-op). */
  private get isFlat() {
    return Math.abs(this.peel.theta) <= 1e-4 || this.peel.f < -1e8;
  }

  /** Recompute the transform and, if it isn't lying flat, the vertices. */
  update(): boolean {
    if (!this.dirty) return false;
    this.dirty = false;
    const flying = this.mode === 'carried' || this.mode === 'dropping';
    this.placeRoot(flying);
    // Hanging over the edge of what it's stuck to?
    const wrap = !flying && this.support && !fitsOn(this.support, this.x, this.z, this.radius()) ? this.support : null;
    // Lying flat with nothing to wrap: the static core/edge meshes will do.
    const resting = !flying && this.isFlat && !wrap;
    this.useMeshes(resting);
    if (!resting) this.deformGrid(flying, wrap);
    return true;
  }

  private placeRoot(flying: boolean) {
    if (flying) {
      // M = T(pivot) * tilt * Ry(yaw) * T(-grab'), where grab' is the held
      // point in its current (possibly still curled) shape. Holding that point
      // fixed is what makes a just-popped flap unfold around your fingers.
      const g = this.isFlat
        ? Object.assign(scratchPoint, { x: this.grab.x, y: this.grab.y, z: 0 })
        : deform(this.grab.x, this.grab.y, this.peel, scratchPoint);
      q.setFromAxisAngle(yAxis, this.yaw).premultiply(this.tilt);
      m4.compose(this.pivot, q, ONE);
      m4b.makeTranslation(-g.x, -g.z, -g.y);
      this.root.matrix.multiplyMatrices(m4, m4b);
    } else {
      q.setFromAxisAngle(yAxis, this.yaw);
      this.root.matrix.compose(v3.set(this.x, this.baseY, this.z), q, ONE);
    }
    this.root.matrixWorldNeedsUpdate = true;
  }

  /**
   * Resting: static core + edge meshes. Otherwise: the deformable grid, front
   * and back. Draw order: edge depth, then cores (topmost first, so whatever
   * they cover is never shaded), then the rest of the scene, then edge
   * colour. A curling or flying sticker is one alpha-tested mesh, drawn early.
   */
  private useMeshes(resting: boolean) {
    if (resting) {
      const layerIdx = Math.round((this.layer * 2) / LAYER);
      this.edgeDepth.renderOrder = -300000 - layerIdx;
      this.core.renderOrder = -200000 - layerIdx;
      this.front.renderOrder = 10;
    } else {
      this.front.renderOrder = this.back.renderOrder = -100000;
      if (!this.geometry) {
        const g = grid(this.src.width, this.src.height, this.cols, this.rows);
        this.geometry = g.geometry;
        this.rest = g.rest;
      }
    }
    const material = resting ? this.materials.edge : this.materials.front;
    const geometry = resting ? this.flat.edge : this.geometry!;
    if (this.front.material !== material) this.front.material = material;
    if (this.front.geometry !== geometry) this.front.geometry = this.back.geometry = geometry;
    this.back.visible = !resting;
    this.core.visible = resting;
    this.edgeDepth.visible = resting;
  }

  /** Write the grid's vertices and normals for the current peel, bend and wrap. */
  private deformGrid(flying: boolean, wrap: Box | null) {
    const geometry = this.geometry!;
    const pos = geometry.attributes.position.array as Float32Array;
    const nor = geometry.attributes.normal.array as Float32Array;
    const rest = this.rest!;
    const peel = this.peel;
    const flat = this.isFlat;
    const n = rest.length / 2;
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const wc = wrap ? Math.cos(wrap.yaw) : 1;
    const ws = wrap ? Math.sin(wrap.yaw) : 0;
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
      } else if (wrap && d.z < 1e-5 && wrapPoint(wrap, this.x + c * d.x + s * d.y, this.z - s * d.x + c * d.y, wrapped, wc, ws)) {
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
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.normal.needsUpdate = true;
    // Peeling and wrapping never stretch the sheet, so every point stays
    // within half a diagonal of the middle vertex. No need to scan them all.
    const mid = ((this.rows >> 1) * (this.cols + 1) + (this.cols >> 1)) * 3;
    const bs = (geometry.boundingSphere ??= new THREE.Sphere());
    bs.center.set(pos[mid], pos[mid + 1], pos[mid + 2]);
    bs.radius = this.radius() * 1.08 + Math.abs(this.bend);
  }

  /** Everything that affects the mesh, packed for cheap "did it move?" checks. */
  pose(out: Float64Array) {
    const p = this.peel;
    out[0] = p.dx;
    out[1] = p.dy;
    out[2] = p.f < -1e8 ? -1e8 : p.f;
    out[3] = p.r;
    out[4] = p.theta;
    out[5] = this.x;
    out[6] = this.z;
    out[7] = this.yaw;
    out[8] = this.baseY;
    out[9] = this.pivot.x;
    out[10] = this.pivot.y;
    out[11] = this.pivot.z;
    out[12] = this.tilt.x;
    out[13] = this.tilt.y;
    out[14] = this.tilt.z;
    out[15] = this.tilt.w;
    out[16] = this.bend;
    out[17] = this.grab.x;
    out[18] = this.grab.y;
    out[19] = MODE_INDEX[this.mode];
    return out;
  }

  /** World position of a rest-pose point in the current shape. */
  worldPoint(px: number, py: number, out = new THREE.Vector3()) {
    if (this.isFlat) return out.set(px, 0, py).applyMatrix4(this.root.matrix);
    const d = deform(px, py, this.peel, scratchPoint);
    return out.set(d.x, d.z, d.y).applyMatrix4(this.root.matrix);
  }

  dispose() {
    const g = this.geometry;
    if (g) {
      // Index and UVs are shared with other stickers' grids: detach them so
      // dispose() only frees what's ours.
      g.setIndex(null);
      g.deleteAttribute('uv');
      g.dispose();
    }
    this.materials.dispose();
  }
}

/** Index and UV buffers depend only on the grid resolution: share them. */
const topology = new Map<string, { index: THREE.BufferAttribute; uv: THREE.BufferAttribute }>();

function gridTopology(cols: number, rows: number) {
  const key = `${cols}x${rows}`;
  let t = topology.get(key);
  if (t) return t;
  const n = (cols + 1) * (rows + 1);
  const uv = new Float32Array(n * 2);
  let i = 0;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      uv[i * 2] = c / cols;
      uv[i * 2 + 1] = 1 - r / rows;
      i++;
    }
  }
  const index = new Uint16Array(cols * rows * 6);
  let k = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;
      const b = a + 1;
      const d = a + cols + 1;
      const e = d + 1;
      // Counter-clockwise seen from +Y (x right, z toward the viewer).
      index[k++] = a;
      index[k++] = d;
      index[k++] = b;
      index[k++] = b;
      index[k++] = d;
      index[k++] = e;
    }
  }
  t = { index: new THREE.BufferAttribute(index, 1), uv: new THREE.BufferAttribute(uv, 2) };
  topology.set(key, t);
  return t;
}

/** Grid in sticker space: x right, y down (matching the canvas), lift on +Y. */
function grid(w: number, h: number, cols: number, rows: number) {
  const n = (cols + 1) * (rows + 1);
  const rest = new Float32Array(n * 2);
  const position = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
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
      i++;
    }
  }
  const topo = gridTopology(cols, rows);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('uv', topo.uv);
  geometry.setIndex(topo.index);
  return { geometry, rest };
}
