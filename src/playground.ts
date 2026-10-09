import * as THREE from 'three';
import type { Sfx } from './audio';
import { solvePeel, type Vec2 } from './peel/model';
import { buildSheet, layoutPack, SHEET, type Slot } from './scene/sheet';
import type { Surface, World } from './scene/world';
import { covers, edgeInfo, extent, type StickerSource } from './stickers/factory';
import { holoUniforms } from './stickers/materials';
import { Sticker } from './stickers/sticker';

/** Per-sticker animation state that only the controller cares about. */
interface Motion {
  // Peeling.
  grab: Vec2;
  inward: Vec2;
  target: Vec2;
  targetVel: Vec2;
  lastF: number;
  r: number;
  releasing: boolean;
  // Hover/invite lift (0..1) while stuck.
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

const CARRY_LIFT = 3.4;
const LAYER = 0.012;

export class Playground {
  readonly stickers: Sticker[] = [];
  private motion = new Map<Sticker, Motion>();
  private sheet: Sheet | null = null;
  private packNo = 0;
  private rc = new THREE.Raycaster();
  private ndc = new THREE.Vector2(0, 0);
  private hasPointer = false;
  private held: Sticker | null = null;
  private orbitDrag: { x: number; y: number; yaw: number; pitch: number } | null = null;
  private userOrbit = { yaw: 0, pitch: 0 };
  private intro = 0;
  private gyro: { x: number; y: number; base: { b: number; g: number } | null } | null = null;
  private hovered: { sticker: Sticker; grab: Vec2; inward: Vec2 } | null = null;
  private invite: Sticker | null = null;
  private clickToDrop = false;
  private lastPointerType = 'mouse';
  private inviteClock = 0;
  private maxAniso: number;
  onFirstPeel: (() => void) | null = null;
  onChange: (() => void) | null = null;

  constructor(
    readonly world: World,
    readonly sfx: Sfx,
  ) {
    this.maxAniso = world.renderer.capabilities.getMaxAnisotropy();
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
    const portrait = window.innerHeight > window.innerWidth * 1.05;
    const nb = portrait ? { x: 0, z: -6.2, yaw: 0.02 } : { x: -7.4, z: 0, yaw: 0.035 };
    const sh = portrait ? { x: 0.6, z: 14.4, yaw: -0.05 } : { x: 9.6, z: 0.6, yaw: -0.07 };
    const sheetName = this.sheet?.name;
    // Everything that isn't on the sheet travels with the notebook.
    this.moveSurface(this.world.notebookSurface, nb.x, nb.z, nb.yaw, (s) => s.surface !== sheetName);
    this.world.setNotebookPose(nb.x, nb.z, nb.yaw);
    if (this.sheet) {
      this.moveSurface(this.sheet.surface, sh.x, sh.z, sh.yaw, (s) => s.surface === sheetName);
      this.sheet.mesh.position.set(sh.x, 0, sh.z);
      this.sheet.mesh.rotation.y = sh.yaw;
    }
    this.sheetPose = sh;
    // Leave room for the toolbar at the bottom of the screen.
    const min = portrait ? new THREE.Vector2(-8.5, -18.6) : new THREE.Vector2(-15.7, -11.4);
    const max = portrait ? new THREE.Vector2(8.5, 27.5) : new THREE.Vector2(17, 12.2);
    this.world.frame(min, max);
  }
  private sheetPose = { x: 9.6, z: 0.6, yaw: -0.07 };

  /** Move a surface and the stuck stickers that belong to it. */
  private moveSurface(surf: Surface, x: number, z: number, yaw: number, owns: (s: Sticker) => boolean) {
    const old = { x: surf.x, z: surf.z, yaw: surf.yaw };
    Object.assign(surf, { x, z, yaw });
    const c = Math.cos(old.yaw);
    const sn = Math.sin(old.yaw);
    const c2 = Math.cos(yaw);
    const s2 = Math.sin(yaw);
    for (const s of this.stickers) {
      if (s.mode !== 'stuck' || !owns(s)) continue;
      const dx = s.x - old.x;
      const dz = s.z - old.z;
      const lx = c * dx - sn * dz;
      const lz = sn * dx + c * dz;
      s.x = x + c2 * lx + s2 * lz;
      s.z = z - s2 * lx + c2 * lz;
      s.yaw += yaw - old.yaw;
      s.dirty = true;
    }
  }

  /** Replace the sheet with a fresh pack. */
  newPack(sources: StickerSource[], seed = Date.now()) {
    this.packNo++;
    const old = this.sheet;
    if (old) {
      // Old sheet and whatever's left on it slide off the desk.
      const leftovers = this.stickers.filter((s) => s.surface === old.name && s.mode === 'stuck');
      this.world.surfaces.splice(this.world.surfaces.indexOf(old.surface), 1);
      this.slideAway(old, leftovers);
    }
    const slots = layoutPack(sources, seed);
    const built = buildSheet(slots, this.packNo);
    const name = `sheet-${this.packNo}`;
    const surface: Surface = { name, x: 0, z: 0, yaw: 0, w: SHEET.w, d: SHEET.d, top: SHEET.t, edge: 0.04 };
    this.world.surfaces.push(surface);
    this.world.scene.add(built.mesh);
    this.sheet = { mesh: built.mesh, surface, name, dispose: built.dispose };
    const sp = this.sheetPose;
    Object.assign(surface, sp);
    built.mesh.position.set(sp.x, 0, sp.z);
    built.mesh.rotation.y = sp.yaw;
    const placed = this.placeOnSheet(slots);
    if (old) this.slideIn(built.mesh, placed);
    return placed;
  }

  private placeOnSheet(slots: Slot[]) {
    const sheet = this.sheet!;
    const out: Sticker[] = [];
    const { x: sx, z: sz, yaw: syaw } = sheet.surface;
    const c = Math.cos(syaw);
    const s = Math.sin(syaw);
    for (const slot of slots) {
      const st = this.add(slot.src);
      st.x = sx + c * slot.x + s * slot.y;
      st.z = sz - s * slot.x + c * slot.y;
      st.yaw = syaw + slot.yaw;
      st.surface = sheet.name;
      st.layer = 0.006;
      st.baseY = SHEET.t + st.layer;
      st.dirty = true;
      out.push(st);
    }
    return out;
  }

  add(src: StickerSource) {
    const st = new Sticker(src, this.maxAniso);
    st.heightField = this.world.heightAt;
    this.stickers.push(st);
    this.world.scene.add(st.root);
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

  private slideAway(old: Sheet, leftovers: Sticker[]) {
    const start = performance.now();
    const from = old.mesh.position.clone();
    const offs = leftovers.map((s) => ({ s, x: s.x, z: s.z }));
    const dir = new THREE.Vector3(1, 0, -0.25).normalize();
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / 650);
      const e = t * t * t;
      const dx = dir.x * 50 * e;
      const dz = dir.z * 50 * e;
      old.mesh.position.set(from.x + dx, 0, from.z + dz);
      for (const o of offs) {
        o.s.x = o.x + dx;
        o.s.z = o.z + dz;
        o.s.dirty = true;
      }
      if (t < 1) requestAnimationFrame(step);
      else {
        this.world.scene.remove(old.mesh);
        old.dispose();
        for (const o of offs) if (this.stickers.includes(o.s)) this.remove(o.s);
      }
    };
    requestAnimationFrame(step);
  }

  private slideIn(mesh: THREE.Mesh, stickers: Sticker[]) {
    const start = performance.now();
    const to = mesh.position.clone();
    const offs = stickers.map((s) => ({ s, x: s.x, z: s.z }));
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / 700);
      const e = 1 - Math.pow(1 - t, 4);
      const dz = (1 - e) * 34;
      const dx = (1 - e) * -4;
      mesh.position.set(to.x + dx, 0, to.z + dz);
      for (const o of offs) {
        o.s.x = o.x + dx;
        o.s.z = o.z + dz;
        o.s.dirty = true;
      }
      if (t < 1) requestAnimationFrame(step);
    };
    step();
  }

  /** One sticker's corner is lifted on the opening screen, asking to be peeled. */
  setInvite(st: Sticker | null) {
    if (this.invite && this.invite !== st) this.motion.get(this.invite)!.hoverGoal = 0;
    this.invite = st;
    if (!st) return;
    // Pick the corner nearest the viewer's lower-right.
    const p = st.src.points;
    let best = 0;
    let bi = 0;
    const c = Math.cos(st.yaw);
    const s = Math.sin(st.yaw);
    for (let i = 0; i < p.length; i += 2) {
      // World-ish direction: +x right, +z toward viewer.
      const wx = c * p[i] + s * p[i + 1];
      const wz = -s * p[i] + c * p[i + 1];
      const score = -wx * 0.7 + wz;
      if (score > best) {
        best = score;
        bi = i;
      }
    }
    const gx = p[bi];
    const gy = p[bi + 1];
    const e = edgeInfo(st.src, gx, gy);
    const m = this.motion.get(st)!;
    m.grab = { x: gx, y: gy };
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
      meshes.push(s.front, s.back);
    }
    for (const s of this.stickers) s.root.updateMatrixWorld();
    const hits = this.rc.intersectObjects(meshes, false);
    for (const h of hits) {
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
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
    return this.rc.ray.intersectPlane(plane, out);
  }

  /** Phones: tilt the device to catch the light on the holo foil. */
  private enableGyro() {
    if (this.gyro || !('DeviceOrientationEvent' in window)) return;
    const start = () => {
      this.gyro = { x: 0, y: 0, base: null };
      window.addEventListener('deviceorientation', (e) => {
        if (e.beta == null || e.gamma == null || !this.gyro) return;
        const g = this.gyro;
        g.base ??= { b: e.beta, g: e.gamma };
        // Slowly re-centre so however you hold the phone becomes "level".
        g.base.b += (e.beta - g.base.b) * 0.01;
        g.base.g += (e.gamma - g.base.g) * 0.01;
        g.x = clamp((e.gamma - g.base.g) / 25, -1, 1);
        g.y = clamp(-(e.beta - g.base.b) / 25, -1, 1);
      });
    };
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof DOE.requestPermission === 'function') {
      DOE.requestPermission().then((r) => r === 'granted' && start()).catch(() => {});
    } else start();
  }

  private onDown = (e: PointerEvent) => {
    this.sfx.unlock();
    if (e.pointerType === 'touch') this.enableGyro();
    this.setNdc(e);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    this.lastPointerType = e.pointerType;
    if (this.held) {
      if (this.clickToDrop && this.held.mode === 'carried') {
        const st = this.held;
        this.held = null;
        this.clickToDrop = false;
        this.drop(st);
      }
      return;
    }
    const hit = e.button === 0 ? this.pick() : null;
    if (!hit) {
      this.orbitDrag = { x: e.clientX, y: e.clientY, yaw: this.userOrbit.yaw, pitch: this.userOrbit.pitch };
      this.world.renderer.domElement.style.cursor = 'grabbing';
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
    this.world.renderer.domElement.style.cursor = 'grabbing';
    // Bring it to the top of whatever it's stacked with.
    this.raise(st);

    if (st.mode === 'dropping' || st.mode === 'carried') {
      // Caught mid-air.
      this.retarget(st, hit.x, hit.y);
      st.mode = 'carried';
      m.yawGoal = st.yaw;
      return;
    }

    const edge = edgeInfo(st.src, hit.x, hit.y);
    const zone = Math.min(1.25, 0.32 * Math.min(st.src.width, st.src.height));
    m.r = curlRadius(st);
    if (st.mode === 'peeling' || edge.dist < zone) {
      // Grab an edge: start peeling from exactly where you pressed.
      if (st.mode !== 'peeling') {
        m.grab = { x: hit.x, y: hit.y };
        m.inward = { x: edge.nx, y: edge.ny };
        m.target = { x: hit.x, y: hit.y };
        m.targetVel = { x: 0, y: 0 };
        m.lastF = -Infinity;
      }
      m.releasing = false;
      st.mode = 'peeling';
      this.sfx.tick();
    } else {
      // Grabbed from the middle: pluck it straight off.
      this.liftOff(st, hit.x, hit.y, 0.4);
    }
  };

  private onMove = (e: PointerEvent) => {
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
    this.setNdc(e);
    if (this.orbitDrag) {
      this.orbitDrag = null;
      this.world.renderer.domElement.style.cursor = '';
      return;
    }
    if (this.clickToDrop) return;
    const st = this.held;
    this.held = null;
    this.world.renderer.domElement.style.cursor = '';
    if (!st) return;
    const m = this.motion.get(st)!;
    if (st.mode === 'peeling') {
      m.releasing = true;
    } else if (st.mode === 'carried') {
      this.drop(st);
    }
    if (e.pointerType === 'touch') this.hasPointer = false;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const st = this.held;
    if (st && st.mode === 'carried') {
      const m = this.motion.get(st)!;
      m.yawGoal -= clamp(e.deltaY, -60, 60) * 0.006;
      return;
    }
    // Otherwise the wheel tilts the view.
    this.userOrbit.pitch = clamp(this.userOrbit.pitch - e.deltaY * 0.0015, -0.42, 0.22);
    this.userOrbit.yaw = clamp(this.userOrbit.yaw - e.deltaX * 0.0015, -0.6, 0.6);
  };

  private onKey = (e: KeyboardEvent) => {
    const st = this.held;
    if (!st || st.mode !== 'carried') return;
    const m = this.motion.get(st)!;
    if (e.key === 'q' || e.key === 'Q' || e.key === 'ArrowLeft') m.yawGoal += Math.PI / 12;
    if (e.key === 'e' || e.key === 'E' || e.key === 'r' || e.key === 'R' || e.key === 'ArrowRight') m.yawGoal -= Math.PI / 12;
  };

  private updateHover() {
    const hit = this.pick();
    if (!hit || hit.sticker.mode !== 'stuck') {
      this.setHover(null);
      this.world.renderer.domElement.style.cursor = hit ? 'grab' : '';
      return;
    }
    const st = hit.sticker;
    this.world.renderer.domElement.style.cursor = 'grab';
    const edge = edgeInfo(st.src, hit.x, hit.y);
    const zone = Math.min(1.25, 0.32 * Math.min(st.src.width, st.src.height));
    if (edge.dist > zone || st === this.invite) {
      this.setHover(null);
      return;
    }
    // Lift the edge a little under the cursor, like it's eager to come off.
    const m = this.motion.get(st)!;
    if (!this.hovered || this.hovered.sticker !== st) {
      this.setHover({ sticker: st, grab: { x: hit.x, y: hit.y }, inward: { x: edge.nx, y: edge.ny } });
    } else {
      // Slide the lifted spot along the edge as you move.
      m.grab = lerp2(m.grab, { x: hit.x, y: hit.y }, 0.35);
      m.inward = norm2(lerp2(m.inward, { x: edge.nx, y: edge.ny }, 0.35));
    }
  }

  private setHover(h: { sticker: Sticker; grab: Vec2; inward: Vec2 } | null) {
    if (this.hovered && (!h || this.hovered.sticker !== h.sticker)) {
      const m = this.motion.get(this.hovered.sticker);
      if (m) m.hoverGoal = 0;
    }
    this.hovered = h;
    if (h) {
      const m = this.motion.get(h.sticker)!;
      if (m.hover < 0.02) {
        m.grab = h.grab;
        m.inward = h.inward;
      }
      m.r = curlRadius(h.sticker);
      m.hoverGoal = 1;
    }
  }

  // ---------------------------------------------------------------- state changes

  private raise(st: Sticker) {
    // Stuck stickers get re-layered on drop; nothing to do until then.
    void st;
  }

  /** Pop free of the surface and into your hand. */
  private liftOff(st: Sticker, gx: number, gy: number, popStrength: number) {
    const m = this.motion.get(st)!;
    const p = st.worldPoint(gx, gy);
    st.grab.set(gx, gy);
    st.mode = 'carried';
    st.pivot.copy(p);
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
    void popStrength;
    this.onChange?.();
  }

  /** Change the held point of a flying sticker without it jumping. */
  private retarget(st: Sticker, gx: number, gy: number) {
    const p = st.worldPoint(gx, gy);
    st.grab.set(gx, gy);
    st.pivot.copy(p);
    st.bendReach = farthest(st, gx, gy);
    st.dirty = true;
  }

  private drop(st: Sticker) {
    const m = this.motion.get(st)!;
    // Where will it land? Centre under the current pose.
    const c = Math.cos(st.yaw);
    const s = Math.sin(st.yaw);
    const cx = st.pivot.x - (c * st.grab.x + s * st.grab.y);
    const cz = st.pivot.z - (-s * st.grab.x + c * st.grab.y);
    // Rest on the highest thing under the footprint (and drape over the rest).
    const pts = st.src.points;
    let h0 = 0;
    const stride = Math.max(2, Math.floor(pts.length / 2 / 60) * 2);
    for (let i = 0; i < pts.length; i += stride) {
      const wx = cx + c * pts[i] + s * pts[i + 1];
      const wz = cz - s * pts[i] + c * pts[i + 1];
      h0 = Math.max(h0, this.world.heightAt(wx, wz));
    }
    const surf = this.world.surfaceAt(cx, cz);
    // Stack on top of any stickers already there.
    let layer = LAYER * 0.5;
    const rad = st.radius() * 0.8;
    for (const o of this.stickers) {
      if (o === st || o.mode !== 'stuck') continue;
      if (Math.abs(o.baseY - o.layer - h0) > 0.05) continue;
      if (Math.hypot(o.x - cx, o.z - cz) < rad + o.radius() * 0.8) layer = Math.max(layer, o.layer + LAYER);
    }
    st.x = cx;
    st.z = cz;
    st.layer = layer;
    st.baseY = h0 + layer;
    st.surface = surf?.name ?? 'desk';
    st.mode = 'dropping';
    m.dropT = 0;
    m.dropFrom = st.pivot.y;
    m.slapped = false;
    this.onChange?.();
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number, time: number) {
    holoUniforms.uTime.value = time;
    this.inviteClock += dt;

    // Camera: user tilt plus a little parallax from the pointer (or the
    // phone's gyro) so the foil always has something to play with.
    let px = this.hasPointer && !this.orbitDrag ? this.ndc.x : 0;
    let py = this.hasPointer && !this.orbitDrag ? this.ndc.y : 0;
    if (this.gyro) {
      px = this.gyro.x;
      py = this.gyro.y;
    }
    const idle = Math.sin(time * 0.35) * 0.015;
    // Let go of a tilt and the desk swings back, like a lazy susan.
    if (!this.orbitDrag) {
      const k = 1 - Math.exp(-dt * 2.2);
      this.userOrbit.yaw -= this.userOrbit.yaw * k;
      this.userOrbit.pitch -= this.userOrbit.pitch * k;
    }
    // Opening shot: start low and turned, settle into the top-down view.
    let introYaw = 0;
    let introPitch = 0;
    if (this.intro < 1) {
      this.intro = Math.min(1, this.intro + dt / 2.4);
      const e = 1 - easeInOut(this.intro);
      introYaw = 0.5 * e;
      introPitch = -0.5 * e;
    }
    this.world.orbit.tYaw = this.userOrbit.yaw - px * 0.05 + idle + introYaw;
    this.world.orbit.tPitch = this.userOrbit.pitch - py * 0.035 + introPitch;
    if (this.intro < 1) {
      this.world.orbit.yaw = this.world.orbit.tYaw;
      this.world.orbit.pitch = this.world.orbit.tPitch;
    }
    this.world.tick(dt);

    for (const st of this.stickers) {
      const m = this.motion.get(st)!;
      switch (st.mode) {
        case 'stuck':
          this.stepStuck(st, m, dt);
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
      st.update();
    }
  }

  private stepStuck(st: Sticker, m: Motion, dt: number) {
    if (m.hover < 0.001 && m.hoverGoal === 0) {
      if (Math.abs(st.peel.theta) > 0) {
        st.peel.theta = 0;
        st.dirty = true;
      }
      return;
    }
    // Under-damped so the corner wobbles a little as it lifts.
    const k = 260;
    const c = 2 * 0.5 * Math.sqrt(k);
    let goal = m.hoverGoal;
    let reach = 0.12;
    if (st === this.invite) {
      // Every few seconds, the corner flutters as if someone breathed on it.
      const t = this.inviteClock % 3.2;
      const flutter = t < 0.9 ? Math.sin(t * 15) * Math.exp(-t * 3.2) * 0.9 : 0;
      goal = 1 + flutter;
      reach = 0.4;
    }
    m.hoverVel += (k * (goal - m.hover) - c * m.hoverVel) * dt;
    m.hover += m.hoverVel * dt;
    const a = Math.max(0, m.hover);
    const sol = solvePeel({
      grab: m.grab,
      target: { x: m.grab.x + m.inward.x * reach * a, y: m.grab.y + m.inward.y * reach * a },
      inward: m.inward,
      r: m.r,
    });
    Object.assign(st.peel, { dx: sol.dx, dy: sol.dy, f: sol.f, r: sol.r, theta: sol.theta });
    st.dirty = true;
  }

  private stepPeel(st: Sticker, m: Motion, dt: number) {
    let goal: Vec2;
    const holding = this.held === st;
    if (holding) {
      const hitY = st.baseY + Math.max(0, peelGrabZ(st, m));
      const p = this.rayToPlane(hitY, new THREE.Vector3());
      goal = p ? st.toLocal(p.x, p.z) : m.target;
    } else {
      goal = m.grab;
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
    const blend = 1 - Math.exp(-dt * 30);
    let dx = st.peel.dx + (sol.dx - st.peel.dx) * blend;
    let dy = st.peel.dy + (sol.dy - st.peel.dy) * blend;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    if (Math.abs(st.peel.theta) < 1e-3) {
      dx = sol.dx;
      dy = sol.dy;
    }
    // Keep the grabbed point consistent with the smoothed direction.
    const ug = m.grab.x * dx + m.grab.y * dy;
    const ugSol = m.grab.x * sol.dx + m.grab.y * sol.dy;
    const f = ug + (sol.f - ugSol);
    Object.assign(st.peel, { dx, dy, f, r: sol.r, theta: sol.theta });
    st.dirty = true;

    const ext = extent(st.src, dx, dy);
    const peeled = (f - ext.lo) / (ext.hi - ext.lo);
    if (holding) {
      const speed = m.lastF === -Infinity ? 0 : (f - m.lastF) / Math.max(dt, 1e-3);
      this.sfx.crackle(speed, dt);
    }
    m.lastF = f;

    if (holding) {
      const tension = sol.outward ? sol.tension : 0;
      const popAt = Math.max(0.9, 0.24 * Math.min(st.src.width, st.src.height));
      if (peeled > 0.7 || tension > popAt) {
        this.liftOff(st, m.grab.x, m.grab.y, peeled);
      }
    } else if (Math.hypot(m.target.x - m.grab.x, m.target.y - m.grab.y) < 0.004 && Math.hypot(m.targetVel.x, m.targetVel.y) < 0.05) {
      st.mode = 'stuck';
      st.peel.theta = 0;
      m.hover = 0;
      m.hoverVel = 0;
      m.hoverGoal = 0;
      st.dirty = true;
    }
  }

  private stepCarried(st: Sticker, m: Motion, dt: number) {
    if (this.held === st) {
      const p = this.rayToPlane(this.carryHeight(), new THREE.Vector3());
      if (p) m.goal.copy(p);
    }
    this.springPivot(st, m, dt, 520, 0.85);

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

    // Swing: the body trails behind the held point like a pendulum, and the
    // whole thing leans into the direction of travel.
    const gl = Math.hypot(st.grab.x, st.grab.y);
    const acc = m.vel;
    if (gl > 0.4) {
      const c = Math.cos(st.yaw);
      const s = Math.sin(st.yaw);
      // Vector from pivot to the centre, in world XZ.
      const rx = -(c * st.grab.x + s * st.grab.y);
      const rz = -(-s * st.grab.x + c * st.grab.y);
      const torque = (rz * acc.x - rx * acc.z) * 0.0026;
      m.yawVel += torque;
    }
    const ky = 60;
    const cy = 2 * 0.55 * Math.sqrt(ky);
    m.yawVel += (ky * (m.yawGoal - st.yaw) - cy * m.yawVel) * dt;
    st.yaw += m.yawVel * dt;

    const v = m.vel;
    const speed = Math.hypot(v.x, v.z);
    const ang = Math.min(0.32, speed * 0.0042);
    const target = new THREE.Quaternion();
    if (speed > 1e-3) target.setFromAxisAngle(new THREE.Vector3(v.z / speed, 0, -v.x / speed), ang);
    st.tilt.slerp(target, 1 - Math.exp(-dt * 10));
    st.dirty = true;
  }

  private stepDrop(st: Sticker, m: Motion, dt: number) {
    m.dropT += dt;
    const T1 = 0.12;
    const t = m.dropT;
    if (t < T1) {
      const e = (t / T1) * (t / T1);
      st.pivot.y = m.dropFrom + (st.baseY - m.dropFrom) * e;
      // Edges spring up as the middle comes down.
      st.bend = st.bend + (0.42 - st.bend) * Math.min(1, dt * 30);
    } else {
      st.pivot.y = st.baseY;
      if (!m.slapped) {
        m.slapped = true;
        const speed = (m.dropFrom - st.baseY) / T1;
        this.sfx.slap(0.4 + speed / 40);
        // A tiny camera kick sells the impact.
        this.world.orbit.pitch -= 0.004;
        if ('vibrate' in navigator) navigator.vibrate?.(12);
      }
      const u = t - T1;
      st.bend = 0.42 * Math.exp(-u / 0.045) * Math.cos((u / 0.1) * Math.PI * 2);
    }
    st.tilt.slerp(new THREE.Quaternion(), Math.min(1, dt * 25));
    m.thetaVel *= 0.7;
    st.peel.theta *= Math.max(0, 1 - dt * 25);
    if (t > T1) st.peel.theta = 0;
    // Settle the spin onto the goal.
    st.yaw += (m.yawGoal - st.yaw) * Math.min(1, dt * 20);
    st.dirty = true;

    if (t > T1 + 0.3) {
      const c = Math.cos(st.yaw);
      const s = Math.sin(st.yaw);
      st.x = st.pivot.x - (c * st.grab.x + s * st.grab.y);
      st.z = st.pivot.z - (-s * st.grab.x + c * st.grab.y);
      st.mode = 'stuck';
      st.bend = 0;
      st.tilt.identity();
      st.peel.theta = 0;
      m.hover = 0;
      m.hoverVel = 0;
      m.hoverGoal = 0;
      st.dirty = true;
      this.onChange?.();
    }
  }

  private springPivot(st: Sticker, m: Motion, dt: number, k: number, zeta: number) {
    const c = 2 * zeta * Math.sqrt(k);
    const steps = 3;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      m.vel.x += (k * (m.goal.x - st.pivot.x) - c * m.vel.x) * h;
      m.vel.y += (k * (m.goal.y - st.pivot.y) - c * m.vel.y) * h;
      m.vel.z += (k * (m.goal.z - st.pivot.z) - c * m.vel.z) * h;
      st.pivot.addScaledVector(m.vel, h);
    }
  }

  private carryHeight() {
    let top = 0;
    for (const s of this.world.surfaces) top = Math.max(top, s.top);
    return top + CARRY_LIFT;
  }

  // ---------------------------------------------------------------- utilities

  /** World position of the inviting corner (for the "peel me" note). */
  invitePoint(out: THREE.Vector3): THREE.Vector3 | null {
    const st = this.invite;
    if (!st || this.intro < 1) return null;
    const m = this.motion.get(st)!;
    return st.worldPoint(m.grab.x, m.grab.y, out);
  }

  /** Everything off the notebook flies away, one after another. */
  peelAll() {
    const sheet = this.sheet?.name;
    const off = this.stickers.filter((s) => s.surface !== sheet && s.mode === 'stuck').sort((a, b) => b.layer - a.layer);
    off.forEach((st, i) => {
      window.setTimeout(() => {
        if (!this.stickers.includes(st) || st.mode !== 'stuck') return;
        const p = st.src.points;
        const k = Math.floor(Math.random() * (p.length / 2)) * 2;
        this.liftOff(st, p[k], p[k + 1], 1);
        const m = this.motion.get(st)!;
        const away = new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
        const start = performance.now();
        const fly = () => {
          const t = (performance.now() - start) / 1000;
          m.goal.copy(st.pivot).addScaledVector(away, 6).setY(st.pivot.y + 3 + t * 30);
          if (t > 0.9) this.remove(st);
          else requestAnimationFrame(fly);
        };
        fly();
      }, i * 70);
    });
  }

  getSheetName() {
    return this.sheet?.name ?? '';
  }

  /**
   * Put a freshly made sticker in your hand: it follows the mouse until you
   * click to stick it down. On touch screens it lands on the notebook.
   */
  give(st: Sticker) {
    const carry = this.carryHeight();
    const nb = this.world.notebookSurface;
    const touch = this.lastPointerType === 'touch' || !this.hasPointer;
    const at = (!touch && this.rayToPlane(carry, new THREE.Vector3())) || new THREE.Vector3(nb.x, carry, nb.z);
    st.yaw = nb.yaw + (Math.random() - 0.5) * 0.3;
    this.hand(st, at);
    this.sfx.pop();
    if (touch) {
      st.pivot.y = carry + 6;
      this.drop(st);
    } else {
      this.held = st;
      this.clickToDrop = true;
    }
  }

  private hand(st: Sticker, at: THREE.Vector3) {
    const m = this.motion.get(st)!;
    st.mode = 'carried';
    st.grab.set(0, 0);
    st.pivot.copy(at);
    st.bendReach = farthest(st, 0, 0);
    m.goal.copy(at);
    m.yawGoal = st.yaw;
    st.dirty = true;
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
    releasing: false,
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

function curlRadius(st: Sticker) {
  return clamp(0.075 * Math.min(st.src.width, st.src.height), 0.2, 0.36);
}

function peelGrabZ(st: Sticker, m: Motion) {
  const p = st.peel;
  if (Math.abs(p.theta) < 1e-4) return 0;
  const u = m.grab.x * p.dx + m.grab.y * p.dy;
  const dist = p.f - u;
  if (dist <= 0) return 0;
  const arc = p.r * p.theta;
  if (dist <= arc) return p.r * (1 - Math.cos(dist / p.r));
  return p.r * (1 - Math.cos(p.theta)) + (dist - arc) * Math.sin(p.theta);
}

function farthest(st: Sticker, gx: number, gy: number) {
  const p = st.src.points;
  let best = 0.5;
  for (let i = 0; i < p.length; i += 2) best = Math.max(best, Math.hypot(p[i] - gx, p[i + 1] - gy));
  return best;
}

function easeInOut(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function clamp(x: number, a: number, b: number) {
  return Math.min(b, Math.max(a, x));
}

function lerp2(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function norm2(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / l, y: a.y / l };
}
