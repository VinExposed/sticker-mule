import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { installPcss, PcssMinMax, pcssSearchUv } from './pcss';
import { canvasTexture, clothTexture, deskTexture, pageEdgeTexture, stampTexture } from './textures';

/** A flat area stickers can stick to. Rectangle in its own frame. */
export interface Surface {
  name: string;
  x: number;
  z: number;
  yaw: number;
  w: number;
  d: number;
  top: number;
}

const SHADOW_SPAN = 70;
const SHADOW_MAP = 1024;
/** Light's angular size (tan): how fast shadows soften with height. */
const LIGHT_SIZE = 0.2;
const SHADOW_NEAR = 30;
const SHADOW_FAR = 110;

/** Hardcover A5-ish notebook, cm. */
const NOTEBOOK = { w: 15.2, d: 21, t: 1.15 };

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly key: THREE.DirectionalLight;
  readonly surfaces: Surface[] = [];
  readonly notebook = new THREE.Group();
  readonly notebookSurface: Surface;
  private readonly minMax: PcssMinMax;
  /** Renders nothing on screen: used to refresh the shadow map on its own. */
  private readonly offscreen = new THREE.WebGLRenderTarget(1, 1);
  private readonly nowhere = new THREE.PerspectiveCamera(1, 1, 0.1, 0.2);

  /** Orbit offsets (radians) from the top-down view, and where they're easing to. */
  readonly orbit = { yaw: 0, pitch: 0, tYaw: 0, tPitch: 0 };
  /** Set when anything that casts a shadow moved this frame. */
  shadowsDirty = true;
  /** Set when anything on screen changed. Idle frames draw nothing. */
  needsRender = true;

  /** Where the camera looks and how far it sits. */
  private target = new THREE.Vector3();
  private distance = 60;
  private bounds = new THREE.Box2();
  /** The orbit was nudged directly (intro, slap kick): redraw even if settled. */
  private cameraMoved = false;

  // Adaptive resolution.
  private maxRatio = Math.min(window.devicePixelRatio, 1.5);
  private pixelRatio = this.maxRatio;
  private slowFrames = 0;
  private fastFrames = 0;
  private lastRendered = false;

  constructor(container: HTMLElement) {
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      // Let dual-GPU laptops stay on the integrated GPU: the scene is light,
      // and the discrete one means heat and fans.
      powerPreference: 'default',
    });
    renderer.setPixelRatio(this.pixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    // Shadows are only re-rendered when something actually moved.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.type = THREE.BasicShadowMap;
    installPcss(SHADOW_SPAN, LIGHT_SIZE);
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 0.92;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.32;
    this.scene.background = new THREE.Color('#cfc8bc');

    this.camera = new THREE.PerspectiveCamera(26, 1, 5, 400);

    // Key light: a big soft window-ish light from the upper left.
    const key = new THREE.DirectionalLight('#fff4e6', 2.6);
    key.position.set(-26, 60, -22);
    key.castShadow = true;
    key.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -SHADOW_SPAN / 2;
    sc.right = sc.top = SHADOW_SPAN / 2;
    sc.near = SHADOW_NEAR;
    sc.far = SHADOW_FAR;
    key.shadow.bias = -0.0003;
    key.shadow.normalBias = 0.025;
    key.shadow.intensity = 0.82;
    this.scene.add(key, key.target);
    this.key = key;

    const hemi = new THREE.HemisphereLight('#f4f1ff', '#a89c8c', 0.35);
    this.scene.add(hemi);

    this.minMax = new PcssMinMax(renderer, SHADOW_MAP, pcssSearchUv(SHADOW_SPAN, LIGHT_SIZE) * SHADOW_MAP);
    this.buildDesk();
    this.buildNotebook();
    this.notebookSurface = {
      name: 'notebook',
      x: 0,
      z: 0,
      yaw: 0,
      w: NOTEBOOK.w,
      d: NOTEBOOK.d,
      top: NOTEBOOK.t,
    };
    this.surfaces.push(this.notebookSurface);
    this.track(this.scene);
  }

  private buildDesk() {
    const map = deskTexture();
    map.repeat.set(5, 5);
    const desk = new THREE.Mesh(
      new THREE.PlaneGeometry(260, 260),
      // Lambert: the desk is matte anyway, and it covers most of the screen.
      new THREE.MeshLambertMaterial({ map }),
    );
    // Drawn last so GPUs without hidden-surface removal skip the parts under
    // the notebook and sheet.
    desk.renderOrder = 1;
    desk.rotation.x = -Math.PI / 2;
    desk.receiveShadow = true;
    this.scene.add(desk);
  }

  private buildNotebook() {
    const { w, d, t } = NOTEBOOK;
    const cloth = canvasTexture(clothTexture(), true, 2);
    const cover = new THREE.MeshStandardMaterial({
      map: cloth,
      roughness: 0.72,
      metalness: 0,
    });
    const board = 0.24;
    const top = new THREE.Mesh(new RoundedBoxGeometry(w, board, d, 4, 0.11), cover);
    top.position.y = t - board / 2;
    const bottom = new THREE.Mesh(new RoundedBoxGeometry(w, board, d, 4, 0.11), cover);
    bottom.position.y = board / 2;
    const spine = new THREE.Mesh(new RoundedBoxGeometry(0.6, t, d, 4, 0.28), cover);
    spine.position.set(-w / 2 + 0.3, t / 2, 0);

    const pageMap = canvasTexture(pageEdgeTexture(), true, 1);
    pageMap.wrapS = pageMap.wrapT = THREE.ClampToEdgeWrapping;
    pageMap.rotation = Math.PI / 2;
    pageMap.center.set(0.5, 0.5);
    const pagesMat = new THREE.MeshStandardMaterial({ map: pageMap, roughness: 0.95 });
    const pagesTop = new THREE.MeshStandardMaterial({ color: '#f3ecdc', roughness: 0.95 });
    const pages = new THREE.Mesh(new THREE.BoxGeometry(w - 0.55, t - board * 2 + 0.02, d - 0.5), [
      pagesMat,
      pagesMat,
      pagesTop,
      pagesTop,
      pagesMat,
      pagesMat,
    ]);
    pages.position.set(0.05, t / 2, 0);

    // Elastic closure band.
    const bandMat = new THREE.MeshStandardMaterial({ color: '#141317', roughness: 0.55, metalness: 0 });
    const bandX = w / 2 - 1.7;
    const bw = 0.75;
    const bandTop = new THREE.Mesh(new RoundedBoxGeometry(bw, 0.07, d + 0.16, 2, 0.03), bandMat);
    bandTop.position.set(bandX, t + 0.035, 0);
    const bandFront = new THREE.Mesh(new RoundedBoxGeometry(bw, t + 0.07, 0.07, 2, 0.03), bandMat);
    bandFront.position.set(bandX, (t + 0.07) / 2, d / 2 + 0.07);
    const bandBack = bandFront.clone();
    bandBack.position.z = -d / 2 - 0.07;

    // Ribbon bookmark trailing out of the pages onto the desk.
    const ribbon = this.ribbon();

    // Gloss-stamped wordmark near the bottom of the cover: barely there until
    // it catches the light.
    const stamp = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 1.2),
      new THREE.MeshStandardMaterial({
        map: canvasTexture(stampTexture(), true, 1),
        transparent: true,
        roughness: 0.22,
        metalness: 0.5,
        depthWrite: false,
      }),
    );
    stamp.rotation.x = -Math.PI / 2;
    stamp.position.set(-0.35, t + 0.002, d / 2 - 2.1);
    stamp.receiveShadow = true;
    this.notebook.add(stamp);

    for (const m of [top, bottom, spine, pages, bandTop, bandFront, bandBack, ribbon]) {
      m.castShadow = true;
      m.receiveShadow = true;
      this.notebook.add(m);
    }
    this.scene.add(this.notebook);
  }

  private ribbon() {
    const { w, d, t } = NOTEBOOK;
    const pts = [
      new THREE.Vector3(w * 0.12, t * 0.55, d / 2 - 0.4),
      new THREE.Vector3(w * 0.12, t * 0.5, d / 2 + 0.3),
      new THREE.Vector3(w * 0.14, 0.25, d / 2 + 1.0),
      new THREE.Vector3(w * 0.18, 0.03, d / 2 + 2.2),
      new THREE.Vector3(w * 0.27, 0.02, d / 2 + 3.6),
      new THREE.Vector3(w * 0.33, 0.02, d / 2 + 4.6),
    ];
    const curve = new THREE.CatmullRomCurve3(pts);
    const segs = 60;
    const half = 0.32;
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const p = curve.getPoint(i / segs);
      const tan = curve.getTangent(i / segs);
      const side = new THREE.Vector3(tan.z, 0, -tan.x).normalize();
      pos.push(p.x - side.x * half, p.y + 0.01, p.z - side.z * half, p.x + side.x * half, p.y + 0.01, p.z + side.z * half);
    }
    for (let i = 0; i < segs; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: '#ff5a1f', roughness: 0.42, side: THREE.DoubleSide }));
  }

  surfaceAt(x: number, z: number): Surface | null {
    let best: Surface | null = null;
    for (const s of this.surfaces) {
      const c = Math.cos(s.yaw);
      const sn = Math.sin(s.yaw);
      const dx = x - s.x;
      const dz = z - s.z;
      const lx = Math.abs(c * dx - sn * dz) - s.w / 2;
      const lz = Math.abs(sn * dx + c * dz) - s.d / 2;
      if (lx <= 0 && lz <= 0 && (!best || s.top > best.top)) best = s;
    }
    return best;
  }

  setNotebookPose(x: number, z: number, yaw: number) {
    this.notebook.position.set(x, 0, z);
    this.notebook.rotation.y = yaw;
    Object.assign(this.notebookSurface, { x, z, yaw });
  }

  /** Fit the camera to a region of the desk (world XZ). */
  fitView(min: THREE.Vector2, max: THREE.Vector2) {
    this.bounds.set(min, max);
    this.resize();
  }

  resize() {
    this.shadowsDirty = true;
    this.needsRender = true;
    const el = this.renderer.domElement.parentElement!;
    const w = el.clientWidth;
    const h = el.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    const size = this.bounds.getSize(new THREE.Vector2());
    const center = this.bounds.getCenter(new THREE.Vector2());
    this.target.set(center.x, 0, center.y + size.y * 0.02);
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const margin = 1.03;
    const distV = (size.y * margin) / 2 / Math.tan(vfov / 2);
    const distH = (size.x * margin) / 2 / Math.tan(hfov / 2);
    this.distance = Math.max(distV, distH) + 2;
    this.camera.updateProjectionMatrix();
    this.updateCamera();
  }

  updateCamera() {
    const pitch = THREE.MathUtils.degToRad(68) + this.orbit.pitch;
    const yaw = this.orbit.yaw;
    const r = this.distance;
    this.camera.position.set(
      this.target.x + Math.sin(yaw) * Math.cos(pitch) * r,
      this.target.y + Math.sin(pitch) * r,
      this.target.z + Math.cos(yaw) * Math.cos(pitch) * r,
    );
    this.camera.lookAt(this.target);
  }

  tick(dt: number) {
    const k = 1 - Math.exp(-dt * 6);
    const ey = this.orbit.tYaw - this.orbit.yaw;
    const ep = this.orbit.tPitch - this.orbit.pitch;
    if (Math.abs(ey) + Math.abs(ep) < 5e-5) {
      // Within a fraction of a pixel: land exactly, draw once, then stop.
      if (ey === 0 && ep === 0 && !this.cameraMoved) return;
      this.orbit.yaw = this.orbit.tYaw;
      this.orbit.pitch = this.orbit.tPitch;
    } else {
      this.orbit.yaw += ey * k;
      this.orbit.pitch += ep * k;
    }
    this.cameraMoved = false;
    this.updateCamera();
    this.needsRender = true;
  }

  /** Nudge the camera directly, bypassing the easing (intro, slap kick). */
  kick(yaw: number, pitch: number) {
    this.orbit.yaw += yaw;
    this.orbit.pitch += pitch;
    this.cameraMoved = true;
  }

  /**
   * Drop resolution on GPUs that can't keep up; creep back when they can.
   * Only frames that follow a drawn frame count, since idle frames are free.
   */
  adapt(dt: number) {
    const measured = this.lastRendered;
    this.lastRendered = this.needsRender || this.shadowsDirty;
    if (!measured) return;
    if (dt > 1 / 50) this.slowFrames++;
    else this.slowFrames = Math.max(0, this.slowFrames - 1);
    if (dt < 1 / 58) this.fastFrames++;
    else this.fastFrames = 0;
    let next = this.pixelRatio;
    if (this.slowFrames > 20) next = Math.max(0.75, this.pixelRatio - 0.25);
    else if (this.fastFrames > 600) next = Math.min(this.maxRatio, this.pixelRatio + 0.25);
    if (next !== this.pixelRatio) {
      this.pixelRatio = next;
      this.renderer.setPixelRatio(next);
      this.needsRender = true;
      this.slowFrames = 0;
      this.fastFrames = 0;
    }
  }

  /**
   * Refresh the shadow map, then its min/max summary, before the main pass
   * reads them. Three only renders shadows inside render(), so this renders
   * the scene into a 1x1 target from a camera pointed at nothing.
   */
  private updateShadows() {
    const r = this.renderer;
    r.shadowMap.needsUpdate = true;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.offscreen);
    this.nowhere.position.set(0, -1000, 0);
    this.nowhere.lookAt(0, -2000, 0);
    r.render(this.scene, this.nowhere);
    r.setRenderTarget(prev);
    const depth = this.key.shadow.map?.depthTexture;
    if (depth) this.minMax.update(depth, this.key.shadow.matrix);
  }

  /** Let a newly added object's materials use the shadow min/max texture. */
  track(obj: THREE.Object3D) {
    obj.traverse((o) => {
      const mat = (o as THREE.Mesh).material;
      if (mat) for (const m of Array.isArray(mat) ? mat : [mat]) this.minMax.patch(m);
    });
  }

  /** Is there something waiting to be drawn? */
  pending() {
    return this.needsRender || this.shadowsDirty;
  }

  /** Draw if anything changed (or always, when `force`, e.g. for a snapshot). */
  render(force = false): boolean {
    if (this.shadowsDirty) {
      this.shadowsDirty = false;
      this.needsRender = true;
      this.updateShadows();
    }
    if (!this.needsRender && !force) return false;
    this.needsRender = false;
    this.renderer.render(this.scene, this.camera);
    return true;
  }
}
