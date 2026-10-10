import * as THREE from 'three';
import type { Sfx } from './audio';
import { clamp, easeInOutCubic, lerp2, normalize2, rotateToLocal, rotateToWorld, type Vec2 } from './math';
import { deform, solvePeel, type DeformOut } from './peel/model';
import { buildSheet, layoutPack, SHEET, type Slot } from './scene/sheet';
import type { Surface, World } from './scene/world';
import { covers, edgeInfo, extent, type StickerSource } from './stickers/factory';
import { LAYER, Sticker } from './stickers/sticker';

/** Per-sticker animation state that only the controller cares about. */
interface Motion {
  // Peeling (and the hover/invite lift, which is a tiny peel).
  grab: Vec2;
  inward: Vec2;
  target: Vec2;
  targetVel: Vec2;
  lastF: number;
  r: number;
  // Hover/invite lift amount (0..1) while stuck.
  hover: number;
  hoverVel: number;
  hoverGoal: number;
  // Flying.
  vel: THREE.Vector3;
  goal: THREE.Vector3;
  thetaVel: number;
  bendVel: number;
  yawVel: number;
  yawGoal: number;
  dropT: number;
  dropFrom: number;
  slapped: boolean;
}

interface Sheet {
  mesh: THREE.Mesh;
  surface: Surface;
  name: string;
  dispose(): void;
}

/** Every pack's sheet is a surface named with this prefix. */
const SHEET_PREFIX = 'sheet-';

/** A scripted animation step; return false when finished. */
type Tween = (now: number) => boolean;

/** How high (cm) a held sticker floats above the tallest surface. */
const CARRY_LIFT = 3.4;
/** Peel reach (cm) of the corner lift when hovering an edge / on the invite. */
const HOVER_REACH = 0.12;
const INVITE_REACH = 0.4;
/** Fraction peeled at which a sticker lets go of the surface. */
const POP_FRACTION = 0.7;
/** Landing: time to fall (s), then how long the edges take to settle. */
const DROP_FALL = 0.12;
const DROP_SETTLE = 0.3;
/** Edge lift (cm) at the far edge when a sticker lands, before slapping down. */
const SLAP_LIFT = 0.42;

const scratch: DeformOut = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 1 };
const v2 = { x: 0, y: 0 };

/**
 * The interaction model: what's under the pointer, what you're holding, and
 * every spring that makes stickers peel, swing, land and settle. Each sticker
 * is in one of four modes:
 *
 *   stuck ──grab edge──▶ peeling ──peeled enough / pulled hard──▶ carried
 *     ▲                     │ let go                                  │ let go
 *     └──── rolls back ◀────┘                                         ▼
 *     └─────────────────────── settles ◀──────────────────────── dropping
 */
export class Playground {
  readonly stickers: Sticker[] = [];
  /** Set by the app: restarts the frame loop if it went to sleep. */
  wake: () => void = () => {};
  onFirstPeel: (() => void) | null = null;
  onChange: (() => void) | null = null;

  private motion = new Map<Sticker, Motion>();
  private tweens: Tween[] = [];
  private sheet: Sheet | null = null;
  private sheetPose = { x: 9.6, z: 0.6, yaw: -0.07 };
  private packNo = 0;
  private maxAniso: number;

  // Pointer.
  private rc = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private hit = new THREE.Vector3();
  private ndc = new THREE.Vector2(0, 0);
  private hasPointer = false;
  private lastPointerType = 'mouse';
  /** The one pointer driving the current gesture; other fingers are ignored. */
  private activePointer: number | null = null;
  private held: Sticker | null = null;
  /** A freshly made sticker follows the mouse until you click (no drag). */
  private clickToDrop = false;
  private hovered: { sticker: Sticker; grab: Vec2; inward: Vec2 } | null = null;

  // View.
  private orbitDrag: { x: number; y: number; yaw: number; pitch: number } | null = null;
  private userOrbit = { yaw: 0, pitch: 0 };
  private intro = 0;
  private gyro: { x: number; y: number; base: { b: number; g: number } | null } | null = null;
  private gyroRequested = false;
  private reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The sticker with its corner up on the opening screen.
  private invite: Sticker | null = null;
  private inviteStart = performance.now();

  // Scratch.
  private poseA = new Float64Array(20);
  private poseB = new Float64Array(20);
  private tiltGoal = new THREE.Quaternion();
  private tiltAxis = new THREE.Vector3();
  private identity = new THREE.Quaternion();
  private centre = new THREE.Vector2();

  constructor(
    readonly world: World,
    readonly sfx: Sfx,
  ) {
    this.maxAniso = world.renderer.capabilities.getMaxAnisotropy();
    if (this.reduceMotion) this.intro = 1;
    const el = world.renderer.domElement;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('pointerleave', () => {
      this.hasPointer = false;
      this.setHover(null);
    });
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKey);
  }

  // ---------------------------------------------------------------- setup

  /** Lay out the desk for the current viewport. */
  layout() {
    this.wake();
    const portrait = window.innerHeight > window.innerWidth * 1.05;
    const nb = portrait ? { x: 0, z: -6.2, yaw: 0.02 } : { x: -7.4, z: 0, yaw: 0.035 };
    const sh = portrait ? { x: 0.6, z: 14.4, yaw: -0.05 } : { x: 9.6, z: 0.6, yaw: -0.07 };
    const sheetName = this.sheet?.name;
    // Everything that isn't on the sheet travels with the notebook.
    this.moveSurface(this.world.notebookSurface, nb, (s) => s.surface !== sheetName);
    this.world.setNotebookPose(nb.x, nb.z, nb.yaw);
    if (this.sheet) {
      this.moveSurface(this.sheet.surface, sh, (s) => s.surface === sheetName);
      this.sheet.mesh.position.set(sh.x, 0, sh.z);
      this.sheet.mesh.rotation.y = sh.yaw;
    }
    this.sheetPose = sh;
    // Leave room for the toolbar at the bottom of the screen.
    const min = portrait ? new THREE.Vector2(-8.5, -18.6) : new THREE.Vector2(-15.7, -11.4);
    const max = portrait ? new THREE.Vector2(8.5, 27.5) : new THREE.Vector2(17, 12.2);
    this.world.fitView(min, max);
  }

  /** Move a surface and the stuck stickers that belong to it. */
  private moveSurface(surf: Surface, to: { x: number; z: number; yaw: number }, owns: (s: Sticker) => boolean) {
    const from = { x: surf.x, z: surf.z, yaw: surf.yaw };
    Object.assign(surf, to);
    for (const s of this.stickers) {
      if (s.mode !== 'stuck' || !owns(s)) continue;
      const local = rotateToLocal(s.x - from.x, s.z - from.z, from.yaw, v2);
      const world = rotateToWorld(local.x, local.y, to.yaw, v2);
      s.x = to.x + world.x;
      s.z = to.z + world.y;
      s.yaw += to.yaw - from.yaw;
      s.dirty = true;
    }
  }

  /** Replace the sheet with a fresh pack. */
  newPack(sources: StickerSource[], seed = Date.now()) {
    this.wake();
    this.packNo++;
    const old = this.sheet;
    // Nobody has peeled anything yet: keep inviting on the new sheet.
    const reinvite = !!this.invite;
    if (old) {
      // Old sheet and whatever's left on it slide off the desk.
      const leftovers = this.stickers.filter((s) => s.surface === old.name && s.mode === 'stuck');
      this.world.surfaces.splice(this.world.surfaces.indexOf(old.surface), 1);
      this.slideAway(old, leftovers);
    }
    const slots = layoutPack(sources, seed);
    const built = buildSheet(slots, this.packNo);
    const name = SHEET_PREFIX + this.packNo;
    const surface: Surface = { name, ...this.sheetPose, w: SHEET.w, d: SHEET.d, top: SHEET.t };
    this.world.surfaces.push(surface);
    this.world.scene.add(built.mesh);
    this.world.track(built.mesh);
    built.mesh.position.set(surface.x, 0, surface.z);
    built.mesh.rotation.y = surface.yaw;
    this.sheet = { mesh: built.mesh, surface, name, dispose: built.dispose };
    const placed = this.placeOnSheet(slots);
    if (old) this.slideIn(built.mesh, placed);
    if (reinvite) this.inviteOnSheet();
    return placed;
  }

  private placeOnSheet(slots: Slot[]) {
    const sheet = this.sheet!;
    const { x, z, yaw } = sheet.surface;
    return slots.map((slot) => {
      const st = this.add(slot.src);
      const at = rotateToWorld(slot.x, slot.y, yaw, v2);
      st.x = x + at.x;
      st.z = z + at.y;
      st.yaw = yaw + slot.yaw;
      st.surface = sheet.name;
      st.support = sheet.surface;
      st.layer = LAYER / 2;
      st.baseY = SHEET.t + st.layer;
      st.dirty = true;
      return st;
    });
  }

  add(src: StickerSource) {
    this.wake();
    const st = new Sticker(src, this.maxAniso);
    this.stickers.push(st);
    this.world.scene.add(st.root);
    this.world.trackMaterials(st.materials.all);
    this.motion.set(st, blankMotion());
    return st;
  }

  remove(st: Sticker) {
    this.world.scene.remove(st.root);
    st.dispose();
    this.stickers.splice(this.stickers.indexOf(st), 1);
    this.motion.delete(st);
    if (this.held === st) this.held = null;
    if (this.invite === st) this.invite = null;
    if (this.hovered?.sticker === st) this.hovered = null;
  }

  /** Run `step` every frame until it returns false. */
  private animate(step: Tween) {
    this.tweens.push(step);
    this.wake();
  }

  private slideAway(old: Sheet, leftovers: Sticker[]) {
    const start = performance.now();
    const from = old.mesh.position.clone();
    const offs = leftovers.map((s) => ({ s, x: s.x, z: s.z }));
    // Off the sheet's footprint while they move: nothing to wrap around.
    for (const o of offs) o.s.support = null;
    const dir = new THREE.Vector3(1, 0, -0.25).normalize();
    this.animate((now) => {
      const t = Math.min(1, (now - start) / 650);
      const d = 50 * t * t * t;
      old.mesh.position.set(from.x + dir.x * d, 0, from.z + dir.z * d);
      this.world.shadowsDirty = true;
      for (const o of offs) {
        o.s.x = o.x + dir.x * d;
        o.s.z = o.z + dir.z * d;
        o.s.dirty = true;
      }
      if (t < 1) return true;
      this.world.scene.remove(old.mesh);
      old.dispose();
      for (const o of offs) if (this.stickers.includes(o.s)) this.remove(o.s);
      return false;
    });
  }

  private slideIn(mesh: THREE.Mesh, stickers: Sticker[]) {
    const start = performance.now();
    const to = mesh.position.clone();
    const offs = stickers.map((s) => ({ s, x: s.x, z: s.z, support: s.support }));
    for (const o of offs) o.s.support = null;
    const place = (t: number) => {
      const e = 1 - Math.pow(1 - t, 4);
      const dx = (1 - e) * -4;
      const dz = (1 - e) * 34;
      mesh.position.set(to.x + dx, 0, to.z + dz);
      this.world.shadowsDirty = true;
      for (const o of offs) {
        if (o.s.mode !== 'stuck') continue;
        o.s.x = o.x + dx;
        o.s.z = o.z + dz;
        o.s.dirty = true;
      }
    };
    place(0);
    this.animate((now) => {
      const t = Math.min(1, (now - start) / 700);
      place(t);
      if (t < 1) return true;
      for (const o of offs) if (o.s.mode === 'stuck') o.s.support = o.support;
      return false;
    });
  }

  /** Lift a corner on the sheet's "Peel Me" sticker, asking for a first peel. */
  inviteOnSheet() {
    const onSheet = this.stickers.filter((s) => s.surface === this.sheetName);
    const st = onSheet.find((s) => s.src.key.startsWith('peel-me:')) ?? onSheet[0];
    if (st) this.setInvite(st);
  }

  /** One sticker's corner is lifted on the opening screen, asking to be peeled. */
  private setInvite(st: Sticker | null) {
    this.wake();
    if (this.invite && this.invite !== st) this.motion.get(this.invite)!.hoverGoal = 0;
    this.invite = st;
    if (!st) return;
    // The corner nearest the viewer's lower left.
    const p = st.src.points;
    let best = -Infinity;
    let bi = 0;
    for (let i = 0; i < p.length; i += 2) {
      const w = rotateToWorld(p[i], p[i + 1], st.yaw, v2);
      const score = -w.x * 0.7 + w.y;
      if (score > best) {
        best = score;
        bi = i;
      }
    }
    const e = edgeInfo(st.src, p[bi], p[bi + 1]);
    const m = this.motion.get(st)!;
    m.grab = { x: p[bi], y: p[bi + 1] };
    m.inward = { x: e.nx, y: e.ny };
    m.r = curlRadius(st);
    m.hoverGoal = 1;
  }

  // ---------------------------------------------------------------- input

  private setNdc(e: PointerEvent | WheelEvent) {
    const r = this.world.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.hasPointer = true;
  }

  /** Topmost sticker under the pointer, using the art's actual silhouette. */
  private pick(): { sticker: Sticker; x: number; y: number } | null {
    this.rc.setFromCamera(this.ndc, this.world.camera);
    const meshes: THREE.Object3D[] = [];
    for (const s of this.stickers) {
      if (s === this.held) continue;
      s.root.updateMatrixWorld();
      // The raycaster doesn't skip hidden meshes on its own.
      for (const m of [s.front, s.core, s.back]) if (m.visible) meshes.push(m);
    }
    for (const h of this.rc.intersectObjects(meshes, false)) {
      const st = h.object.userData.sticker as Sticker;
      if (!h.uv) continue;
      const x = (h.uv.x - 0.5) * st.src.width;
      const y = (0.5 - h.uv.y) * st.src.height;
      if (covers(st.src, x, y)) return { sticker: st, x, y };
    }
    return null;
  }

  private rayToPlane(y: number, out: THREE.Vector3) {
    this.rc.setFromCamera(this.ndc, this.world.camera);
    this.plane.constant = -y;
    return this.rc.ray.intersectPlane(this.plane, out);
  }

  /**
   * Phones: tilt the device to catch the light on the holo foil. iOS only
   * allows the permission prompt from a user activation (a touch *release*).
   */
  private requestGyro() {
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
        // Quantised, so sensor noise doesn't keep the scene redrawing.
        const x = Math.round(clamp((e.gamma - g.base.g) / 25, -1, 1) * 100) / 100;
        const y = Math.round(clamp(-(e.beta - g.base.b) / 25, -1, 1) * 100) / 100;
        if (x === g.x && y === g.y) return;
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

  /** Events from a second finger mid-gesture are ignored. */
  private isOtherPointer(e: PointerEvent) {
    return this.activePointer !== null && e.pointerId !== this.activePointer;
  }

  private onDown = (e: PointerEvent) => {
    if (this.isOtherPointer(e)) return;
    this.sfx.unlock();
    this.setNdc(e);
    this.lastPointerType = e.pointerType;
    if (this.held) {
      // A freshly made sticker in hand: this click sticks it down.
      if (this.clickToDrop) this.dropHeld();
      return;
    }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    this.activePointer = e.pointerId;
    const hit = e.button === 0 ? this.pick() : null;
    if (!hit) {
      this.orbitDrag = { x: e.clientX, y: e.clientY, yaw: this.userOrbit.yaw, pitch: this.userOrbit.pitch };
      this.setCursor('grabbing');
      return;
    }
    const st = hit.sticker;
    const m = this.motion.get(st)!;
    this.held = st;
    this.setHover(null);
    if (this.invite) {
      this.setInvite(null);
      this.onFirstPeel?.();
    }
    this.setCursor('grabbing');

    if (st.mode === 'dropping' || st.mode === 'carried') {
      // Caught mid-air.
      this.retarget(st, hit.x, hit.y);
      st.mode = 'carried';
      m.yawGoal = st.yaw;
      return;
    }

    const edge = edgeInfo(st.src, hit.x, hit.y);
    m.r = curlRadius(st);
    // Pressing a flap that's still rolling back near where it was held
    // resumes that peel; anywhere else starts a new one.
    const resume = st.mode === 'peeling' && Math.hypot(hit.x - m.grab.x, hit.y - m.grab.y) < 1;
    if (resume || edge.dist < edgeZone(st)) {
      if (!resume) {
        st.peel.theta = 0;
        m.grab = { x: hit.x, y: hit.y };
        m.inward = { x: edge.nx, y: edge.ny };
        m.target = { x: hit.x, y: hit.y };
        m.targetVel = { x: 0, y: 0 };
        m.lastF = -Infinity;
      }
      st.mode = 'peeling';
      this.sfx.tick();
    } else {
      // Grabbed from the middle: pluck it straight off.
      this.liftOff(st, hit.x, hit.y);
    }
  };

  private onMove = (e: PointerEvent) => {
    if (this.isOtherPointer(e)) return;
    this.setNdc(e);
    if (this.orbitDrag) {
      const o = this.orbitDrag;
      this.userOrbit.yaw = clamp(o.yaw - (e.clientX - o.x) * 0.0035, -0.6, 0.6);
      this.userOrbit.pitch = clamp(o.pitch + (e.clientY - o.y) * 0.003, -0.42, 0.22);
      return;
    }
    if (!this.held && e.pointerType === 'mouse') this.updateHover();
  };

  private onUp = (e: PointerEvent) => {
    if (this.isOtherPointer(e)) return;
    this.activePointer = null;
    if (e.pointerType === 'touch') {
      // On touch screens only the release counts as a user activation.
      this.sfx.unlock();
      this.requestGyro();
    }
    this.setNdc(e);
    if (this.orbitDrag) {
      this.orbitDrag = null;
      this.setCursor('');
      return;
    }
    if (this.clickToDrop) return;
    const st = this.held;
    this.held = null;
    this.setCursor('');
    // A peel that didn't get far enough rolls back by itself (see stepPeel).
    if (st?.mode === 'carried') this.drop(st);
    if (e.pointerType === 'touch') this.hasPointer = false;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const st = this.held;
    if (st?.mode === 'carried') {
      this.motion.get(st)!.yawGoal -= clamp(e.deltaY, -60, 60) * 0.006;
      return;
    }
    // Otherwise the wheel tilts the view.
    this.userOrbit.pitch = clamp(this.userOrbit.pitch - e.deltaY * 0.0015, -0.42, 0.22);
    this.userOrbit.yaw = clamp(this.userOrbit.yaw - e.deltaX * 0.0015, -0.6, 0.6);
  };

  private onKey = (e: KeyboardEvent) => {
    const st = this.held;
    if (st?.mode !== 'carried') return;
    const step = Math.PI / 12;
    const key = e.key.toLowerCase();
    if (key === 'q' || key === 'arrowleft') this.motion.get(st)!.yawGoal += step;
    if (key === 'e' || key === 'r' || key === 'arrowright') this.motion.get(st)!.yawGoal -= step;
    if (key === 'escape') this.dropHeld();
  };

  private setCursor(c: string) {
    this.world.renderer.domElement.style.cursor = c;
  }

  private updateHover() {
    const hit = this.pick();
    this.setCursor(hit ? 'grab' : '');
    if (!hit || hit.sticker.mode !== 'stuck' || hit.sticker === this.invite) {
      this.setHover(null);
      return;
    }
    const st = hit.sticker;
    const edge = edgeInfo(st.src, hit.x, hit.y);
    if (edge.dist > edgeZone(st)) {
      this.setHover(null);
      return;
    }
    // Lift the edge a little under the cursor, like it's eager to come off.
    if (this.hovered?.sticker !== st) {
      this.setHover({ sticker: st, grab: { x: hit.x, y: hit.y }, inward: { x: edge.nx, y: edge.ny } });
    } else {
      // Slide the lifted spot along the edge as you move.
      const m = this.motion.get(st)!;
      m.grab = lerp2(m.grab, { x: hit.x, y: hit.y }, 0.35);
      m.inward = normalize2(lerp2(m.inward, { x: edge.nx, y: edge.ny }, 0.35));
      this.liftEdge(st, m, HOVER_REACH);
    }
  }

  private setHover(h: { sticker: Sticker; grab: Vec2; inward: Vec2 } | null) {
    if (this.hovered && this.hovered.sticker !== h?.sticker) {
      const m = this.motion.get(this.hovered.sticker);
      if (m) m.hoverGoal = 0;
    }
    this.hovered = h;
    if (!h) return;
    const m = this.motion.get(h.sticker)!;
    if (m.hover < 0.02) {
      m.grab = h.grab;
      m.inward = h.inward;
    }
    m.r = curlRadius(h.sticker);
    m.hoverGoal = 1;
  }

  // ---------------------------------------------------------------- state changes

  /** Pop free of the surface and into your hand. */
  private liftOff(st: Sticker, gx: number, gy: number) {
    const m = this.motion.get(st)!;
    st.pivot.copy(st.worldPoint(gx, gy, this.hit));
    st.grab.set(gx, gy);
    st.mode = 'carried';
    st.tilt.identity();
    m.vel.set(0, 0, 0);
    m.thetaVel = 0;
    m.bendVel = 0;
    m.yawVel = 0;
    m.yawGoal = st.yaw;
    m.hover = 0;
    m.hoverGoal = 0;
    st.bendReach = farthest(st, gx, gy);
    st.bend = 0;
    st.dirty = true;
    this.sfx.pop();
    this.onChange?.();
  }

  /** Change the held point of a flying sticker without it jumping. */
  private retarget(st: Sticker, gx: number, gy: number) {
    st.pivot.copy(st.worldPoint(gx, gy, this.hit));
    st.grab.set(gx, gy);
    st.bendReach = farthest(st, gx, gy);
    st.dirty = true;
  }

  /**
   * The highest surface under a sticker's footprint is what it sticks to;
   * whatever hangs off that surface wraps over its edge.
   */
  footprint(st: Sticker, cx: number, cz: number, { sheets = true } = {}) {
    const pts = st.src.points;
    let best: Surface | null = null;
    const stride = Math.max(2, Math.floor(pts.length / 2 / 60) * 2);
    for (let i = 0; i < pts.length; i += stride) {
      const w = rotateToWorld(pts[i], pts[i + 1], st.yaw, v2);
      const hit = this.world.surfaceAt(cx + w.x, cz + w.y);
      if (!hit || (!sheets && hit.name.startsWith(SHEET_PREFIX))) continue;
      if (!best || hit.top > best.top) best = hit;
    }
    return { top: best?.top ?? 0, surface: best };
  }

  /** Stacking height for a sticker about to rest at (cx, cz) on a surface at `top`. */
  private layerAt(st: Sticker, cx: number, cz: number, top: number) {
    let layer = LAYER / 2;
    const rad = st.radius() * 0.8;
    for (const o of this.stickers) {
      if (o === st || o.mode !== 'stuck') continue;
      if (Math.abs(o.baseY - o.layer - top) > 0.05) continue;
      if (Math.hypot(o.x - cx, o.z - cz) < rad + o.radius() * 0.8) layer = Math.max(layer, o.layer + LAYER);
    }
    return layer;
  }

  private drop(st: Sticker) {
    const m = this.motion.get(st)!;
    const c = st.centreUnderPivot(this.centre);
    const { top, surface } = this.footprint(st, c.x, c.y);
    st.x = c.x;
    st.z = c.y;
    st.layer = this.layerAt(st, c.x, c.y, top);
    st.baseY = top + st.layer;
    st.surface = surface?.name ?? 'desk';
    st.support = surface;
    st.mode = 'dropping';
    m.thetaVel = 0;
    m.dropT = 0;
    m.dropFrom = st.pivot.y;
    m.slapped = false;
    this.onChange?.();
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number) {
    const now = performance.now();
    if (this.tweens.length) this.tweens = this.tweens.filter((t) => t(now));
    this.updateView(dt);

    for (const st of this.stickers) {
      const m = this.motion.get(st)!;
      // Springs settle; once a sticker stops moving, stop rebuilding it.
      const before = st.dirty ? null : st.pose(this.poseA);
      switch (st.mode) {
        case 'stuck':
          if (st === this.invite) this.stepInvite(st, m, dt);
          else this.stepHover(st, m, dt);
          break;
        case 'peeling':
          this.stepPeel(st, m, dt);
          break;
        case 'carried':
          this.stepCarried(st, m, dt);
          break;
        case 'dropping':
          this.stepDrop(st, m, dt);
          break;
      }
      if (before && st.dirty && samePose(before, st.pose(this.poseB))) st.dirty = false;
      if (st.update()) this.world.shadowsDirty = true;
    }
  }

  /** Camera: intro shot, user tilt, and parallax from the pointer or gyro. */
  private updateView(dt: number) {
    const parallax = this.hasPointer && !this.orbitDrag && !this.reduceMotion;
    let px = parallax ? this.ndc.x : 0;
    let py = parallax ? this.ndc.y : 0;
    if (this.gyro) {
      px = this.gyro.x;
      py = this.gyro.y;
    }
    // Let go of a tilt and the desk swings back, like a lazy susan.
    if (!this.orbitDrag) {
      const k = 1 - Math.exp(-dt * 2.2);
      this.userOrbit.yaw -= this.userOrbit.yaw * k;
      this.userOrbit.pitch -= this.userOrbit.pitch * k;
      if (Math.abs(this.userOrbit.yaw) + Math.abs(this.userOrbit.pitch) < 3e-4) this.userOrbit.yaw = this.userOrbit.pitch = 0; // ~half a pixel
    }
    // Opening shot: start low and turned, settle into the top-down view.
    let introYaw = 0;
    let introPitch = 0;
    if (this.intro < 1) {
      this.intro = Math.min(1, this.intro + dt / 2.4);
      const e = 1 - easeInOutCubic(this.intro);
      introYaw = 0.5 * e;
      introPitch = -0.5 * e;
    }
    const orbit = this.world.orbit;
    orbit.tYaw = this.userOrbit.yaw - px * 0.05 + introYaw;
    orbit.tPitch = this.userOrbit.pitch - py * 0.035 + introPitch;
    if (this.intro < 1) this.world.kick(orbit.tYaw - orbit.yaw, orbit.tPitch - orbit.pitch);
    this.world.tick(dt);
  }

  /** Hovering near an edge lifts it a little; moving away lets it settle. */
  private stepHover(st: Sticker, m: Motion, dt: number) {
    if (springHover(m, dt)) this.liftEdge(st, m, HOVER_REACH);
  }

  /** The opening screen's corner: lifts, then flutters every few seconds. */
  private stepInvite(st: Sticker, m: Motion, dt: number) {
    if (m.hover < 0.95) {
      springHover(m, dt);
    } else {
      // Driven directly (not through the spring) so between flutters it is
      // perfectly still and the idle scene costs nothing to draw.
      const flutter = inviteFlutter(this.inviteClock());
      if (flutter === 0 && m.hover === 1) return;
      m.hover = 1 + flutter;
      m.hoverVel = 0;
    }
    this.liftEdge(st, m, INVITE_REACH);
  }

  /** Shape a stuck sticker as a small peel at its grab point. */
  private liftEdge(st: Sticker, m: Motion, reach: number) {
    const a = Math.max(0, m.hover) * reach;
    const sol = solvePeel({
      grab: m.grab,
      target: { x: m.grab.x + m.inward.x * a, y: m.grab.y + m.inward.y * a },
      inward: m.inward,
      r: m.r,
    });
    Object.assign(st.peel, { dx: sol.dx, dy: sol.dy, f: sol.f, r: sol.r, theta: sol.theta });
    st.dirty = true;
  }

  private stepPeel(st: Sticker, m: Motion, dt: number) {
    const holding = this.held === st;
    let goal = m.grab;
    if (holding) {
      // Aim at the height the grabbed point has already been lifted to, so
      // it stays exactly under the cursor.
      const z = deform(m.grab.x, m.grab.y, st.peel, scratch).z;
      const p = this.rayToPlane(st.baseY + Math.max(0, z), this.hit);
      goal = p ? st.toLocal(p.x, p.z) : m.target;
    }
    // Spring the target: snappy while held, bouncy when let go so the flap
    // slaps back down.
    const k = holding ? 900 : 380;
    const c = holding ? 2 * Math.sqrt(k) : 2 * 0.42 * Math.sqrt(k);
    const steps = 3;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      m.targetVel.x += (k * (goal.x - m.target.x) - c * m.targetVel.x) * h;
      m.targetVel.y += (k * (goal.y - m.target.y) - c * m.targetVel.y) * h;
      m.target.x += m.targetVel.x * h;
      m.target.y += m.targetVel.y * h;
    }
    const sol = solvePeel({ grab: m.grab, target: m.target, inward: m.inward, r: m.r });

    // Smooth the fold direction so switching between "fold back" and
    // "pull away" never snaps.
    let dx = sol.dx;
    let dy = sol.dy;
    if (Math.abs(st.peel.theta) >= 1e-3) {
      const blend = 1 - Math.exp(-dt * 30);
      const d = normalize2({ x: st.peel.dx + (sol.dx - st.peel.dx) * blend, y: st.peel.dy + (sol.dy - st.peel.dy) * blend });
      dx = d.x;
      dy = d.y;
    }
    // Keep the grabbed point consistent with the smoothed direction.
    const f = m.grab.x * dx + m.grab.y * dy + (sol.f - (m.grab.x * sol.dx + m.grab.y * sol.dy));
    Object.assign(st.peel, { dx, dy, f, r: sol.r, theta: sol.theta });
    st.dirty = true;

    const speed = m.lastF === -Infinity ? 0 : (f - m.lastF) / Math.max(dt, 1e-3);
    m.lastF = f;
    if (holding) {
      this.sfx.crackle(speed, dt);
      const ext = extent(st.src, dx, dy);
      const peeled = (f - ext.lo) / (ext.hi - ext.lo);
      const tension = sol.outward ? sol.tension : 0;
      const popAt = Math.max(0.9, 0.24 * Math.min(st.src.width, st.src.height));
      if (peeled > POP_FRACTION || tension > popAt) this.liftOff(st, m.grab.x, m.grab.y);
    } else if (Math.hypot(m.target.x - m.grab.x, m.target.y - m.grab.y) < 0.004 && Math.hypot(m.targetVel.x, m.targetVel.y) < 0.05) {
      // Rolled all the way back down.
      st.mode = 'stuck';
      st.peel.theta = 0;
      m.hover = m.hoverVel = m.hoverGoal = 0;
      st.dirty = true;
    }
  }

  private stepCarried(st: Sticker, m: Motion, dt: number) {
    if (this.held === st) {
      const p = this.rayToPlane(this.carryHeight(), this.hit);
      if (p) m.goal.copy(p);
    }
    springVec(st.pivot, m.vel, m.goal, dt, 520, 0.85);

    // Unfold: the curl springs out flat with a little overshoot.
    const kt = 300;
    const ct = 2 * 0.32 * Math.sqrt(kt);
    m.thetaVel += (-kt * st.peel.theta - ct * m.thetaVel) * dt;
    st.peel.theta += m.thetaVel * dt;
    if (Math.abs(st.peel.theta) < 1e-3 && Math.abs(m.thetaVel) < 1e-2) st.peel.theta = 0;

    // A held sticker droops a touch away from your fingers.
    const droop = -0.16 * Math.min(1, st.bendReach / 5);
    const kb = 220;
    const cb = 2 * 0.4 * Math.sqrt(kb);
    m.bendVel += (kb * (droop - st.bend) - cb * m.bendVel) * dt;
    st.bend += m.bendVel * dt;

    // Swing: held off-centre, the body trails behind the held point like a
    // pendulum. Torque = r x v, with r from the pivot to the centre.
    if (Math.hypot(st.grab.x, st.grab.y) > 0.4) {
      const r = rotateToWorld(-st.grab.x, -st.grab.y, st.yaw, v2);
      m.yawVel += (r.y * m.vel.x - r.x * m.vel.z) * 0.0026;
    }
    const ky = 60;
    const cy = 2 * 0.55 * Math.sqrt(ky);
    m.yawVel += (ky * (m.yawGoal - st.yaw) - cy * m.yawVel) * dt;
    st.yaw += m.yawVel * dt;

    // ...and the whole thing leans into the direction of travel.
    const speed = Math.hypot(m.vel.x, m.vel.z);
    const target = this.tiltGoal.identity();
    if (speed > 1e-3) {
      target.setFromAxisAngle(this.tiltAxis.set(m.vel.z / speed, 0, -m.vel.x / speed), Math.min(0.32, speed * 0.0042));
    }
    st.tilt.slerp(target, 1 - Math.exp(-dt * 10));
    st.dirty = true;
  }

  private stepDrop(st: Sticker, m: Motion, dt: number) {
    m.dropT += dt;
    const t = m.dropT;
    if (t < DROP_FALL) {
      // Falls (accelerating) while the edges spring up...
      const e = (t / DROP_FALL) ** 2;
      st.pivot.y = m.dropFrom + (st.baseY - m.dropFrom) * e;
      st.bend += (SLAP_LIFT - st.bend) * Math.min(1, dt * 30);
      st.peel.theta *= Math.max(0, 1 - dt * 25);
    } else {
      // ...then the edges slap down and wobble flat.
      st.pivot.y = st.baseY;
      st.peel.theta = 0;
      if (!m.slapped) {
        m.slapped = true;
        const speed = (m.dropFrom - st.baseY) / DROP_FALL;
        this.sfx.slap(0.4 + speed / 40);
        // A tiny camera kick sells the impact.
        this.world.kick(0, -0.004);
        navigator.vibrate?.(12);
      }
      const u = t - DROP_FALL;
      st.bend = SLAP_LIFT * Math.exp(-u / 0.045) * Math.cos((u / 0.1) * Math.PI * 2);
    }
    st.tilt.slerp(this.identity, Math.min(1, dt * 25));
    st.yaw += (m.yawGoal - st.yaw) * Math.min(1, dt * 20);
    st.dirty = true;

    if (t > DROP_FALL + DROP_SETTLE) {
      const c = st.centreUnderPivot(this.centre);
      st.x = c.x;
      st.z = c.y;
      st.mode = 'stuck';
      st.bend = 0;
      st.tilt.identity();
      m.hover = m.hoverVel = m.hoverGoal = 0;
      this.onChange?.();
    }
  }

  private carryHeight() {
    let top = 0;
    for (const s of this.world.surfaces) top = Math.max(top, s.top);
    return top + CARRY_LIFT;
  }

  private inviteClock() {
    return (performance.now() - this.inviteStart) / 1000;
  }

  // ---------------------------------------------------------------- queries

  get sheetName() {
    return this.sheet?.name ?? '';
  }

  /** On a sheet (this pack's, or one that's sliding away)? */
  isOnSheet(st: Sticker) {
    return st.surface.startsWith(SHEET_PREFIX);
  }

  /** Is anything mid-gesture or mid-animation? (If not, the loop may sleep.) */
  busy() {
    if (this.held || this.orbitDrag || this.intro < 1 || this.tweens.length) return true;
    return this.stickers.some((s) => s.mode !== 'stuck');
  }

  /** Is the user dragging something right now? (Those frames get full rate.) */
  manipulating() {
    return !!(this.held || this.orbitDrag);
  }

  /** Seconds until something wants to animate on its own (the invite flutter). */
  nextWakeIn(): number | null {
    if (!this.invite) return null;
    const t = this.inviteClock();
    const period = flutterPeriod(t);
    return period - (t % period);
  }

  /** World position of the inviting corner (for the "peel me" note). */
  invitePoint(out: THREE.Vector3): THREE.Vector3 | null {
    const st = this.invite;
    if (!st || this.intro < 1) return null;
    const m = this.motion.get(st)!;
    return st.worldPoint(m.grab.x, m.grab.y, out);
  }

  // ---------------------------------------------------------------- actions

  /** Everything off the sheet flies away, one after another. */
  peelAll() {
    const off = this.stickers.filter((s) => !this.isOnSheet(s) && s.mode === 'stuck').sort((a, b) => b.layer - a.layer);
    const t0 = performance.now();
    off.forEach((st, i) => {
      const start = t0 + i * 70;
      let away: THREE.Vector3 | null = null;
      this.animate((now) => {
        if (now < start) return true;
        if (!this.stickers.includes(st)) return false;
        if (!away) {
          if (st.mode !== 'stuck') return false;
          const p = st.src.points;
          const k = Math.floor(Math.random() * (p.length / 2)) * 2;
          this.liftOff(st, p[k], p[k + 1]);
          away = new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
        }
        if (this.held === st) return false; // caught mid-flight: it's yours now
        const t = (now - start) / 1000;
        this.motion
          .get(st)!
          .goal.copy(st.pivot)
          .addScaledVector(away, 6)
          .setY(st.pivot.y + 3 + t * 30);
        if (t <= 0.9) return true;
        this.remove(st);
        return false;
      });
    });
  }

  /** Stick down whatever is in hand right now, where it is. */
  dropHeld() {
    const st = this.held;
    if (st?.mode !== 'carried') return;
    this.held = null;
    this.clickToDrop = false;
    this.activePointer = null;
    this.setCursor('');
    this.drop(st);
  }

  /**
   * Put a freshly made sticker in your hand: it follows the mouse until you
   * click to stick it down. On touch screens it lands on the notebook.
   */
  give(st: Sticker) {
    this.wake();
    // Only one sticker in hand at a time.
    this.dropHeld();
    const carry = this.carryHeight();
    const nb = this.world.notebookSurface;
    const touch = this.lastPointerType === 'touch' || !this.hasPointer;
    const at = (!touch && this.rayToPlane(carry, new THREE.Vector3())) || new THREE.Vector3(nb.x, carry, nb.z);
    const m = this.motion.get(st)!;
    st.yaw = nb.yaw + (Math.random() - 0.5) * 0.3;
    st.mode = 'carried';
    st.grab.set(0, 0);
    st.pivot.copy(at);
    st.bendReach = farthest(st, 0, 0);
    st.dirty = true;
    m.goal.copy(at);
    m.yawGoal = st.yaw;
    this.sfx.pop();
    if (touch) {
      st.pivot.y = carry + 6;
      this.drop(st);
    } else {
      this.held = st;
      this.clickToDrop = true;
    }
  }
}

function blankMotion(): Motion {
  return {
    grab: { x: 0, y: 0 },
    inward: { x: 1, y: 0 },
    target: { x: 0, y: 0 },
    targetVel: { x: 0, y: 0 },
    lastF: -Infinity,
    r: 0.3,
    hover: 0,
    hoverVel: 0,
    hoverGoal: 0,
    vel: new THREE.Vector3(),
    goal: new THREE.Vector3(),
    thetaVel: 0,
    bendVel: 0,
    yawVel: 0,
    yawGoal: 0,
    dropT: 0,
    dropFrom: 0,
    slapped: false,
  };
}

/**
 * Under-damped spring for the hover lift, so a corner wobbles a little as it
 * comes up. Snaps to rest when close; returns false if nothing changed.
 */
function springHover(m: Motion, dt: number) {
  const goal = m.hoverGoal;
  if (Math.abs(goal - m.hover) < 2e-3 && Math.abs(m.hoverVel) < 2e-2) {
    if (m.hover === goal && m.hoverVel === 0) return false;
    m.hover = goal;
    m.hoverVel = 0;
    return true;
  }
  const k = 260;
  const c = 2 * 0.5 * Math.sqrt(k);
  m.hoverVel += (k * (goal - m.hover) - c * m.hoverVel) * dt;
  m.hover += m.hoverVel * dt;
  return true;
}

/** Damped spring on a vector, sub-stepped for stiffness. */
function springVec(x: THREE.Vector3, v: THREE.Vector3, goal: THREE.Vector3, dt: number, k: number, zeta: number) {
  const c = 2 * zeta * Math.sqrt(k);
  const steps = 3;
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    v.x += (k * (goal.x - x.x) - c * v.x) * h;
    v.y += (k * (goal.y - x.y) - c * v.y) * h;
    v.z += (k * (goal.z - x.z) - c * v.z) * h;
    x.addScaledVector(v, h);
  }
}

/** Every 5s for the first half minute, then every 12s. */
function flutterPeriod(t: number) {
  return t < 30 ? 5 : 12;
}

/** A one-second decaying wobble at the start of each period, else 0. */
function inviteFlutter(t: number) {
  const u = t % flutterPeriod(t);
  return u < 1 ? Math.sin(u * 15) * Math.exp(-u * 5) * 0.9 : 0;
}

/** How far in from the die line (cm) a press counts as grabbing the edge. */
function edgeZone(st: Sticker) {
  return Math.min(1.25, 0.32 * Math.min(st.src.width, st.src.height));
}

function curlRadius(st: Sticker) {
  return clamp(0.075 * Math.min(st.src.width, st.src.height), 0.2, 0.36);
}

/** Distance from the held point to the furthest part of the sticker. */
function farthest(st: Sticker, gx: number, gy: number) {
  const p = st.src.points;
  let best = 0.5;
  for (let i = 0; i < p.length; i += 2) best = Math.max(best, Math.hypot(p[i] - gx, p[i + 1] - gy));
  return best;
}

function samePose(a: Float64Array, b: Float64Array) {
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false;
  return true;
}
