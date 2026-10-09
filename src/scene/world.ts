import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { installPcss } from './pcss';
import { canvasTexture, clothTexture, deskTextures, pageEdgeTexture } from './textures';

/** A flat area stickers can stick to. Rectangle in its own frame. */
export interface Surface {
  name: string;
  x: number;
  z: number;
  yaw: number;
  w: number;
  d: number;
  top: number;
  /** How fast the edge falls away (cm). */
  edge: number;
}

const SHADOW_SPAN = 70;
const SHADOW_NEAR = 30;
const SHADOW_FAR = 110;

export const NOTEBOOK = { w: 15.2, d: 21, t: 1.15 };

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly key: THREE.DirectionalLight;
  readonly surfaces: Surface[] = [];
  readonly notebook = new THREE.Group();
  readonly notebookSurface: Surface;

  /** Where the camera looks and how far it sits. */
  private target = new THREE.Vector3();
  private distance = 60;
  /** Orbit offsets (radians): user tilt + pointer parallax, smoothed. */
  orbit = { yaw: 0, pitch: 0, tYaw: 0, tPitch: 0 };
  private bounds = new THREE.Box2();

  constructor(container: HTMLElement) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.BasicShadowMap;
    installPcss(SHADOW_SPAN, SHADOW_FAR - SHADOW_NEAR, 0.2);
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
    key.shadow.mapSize.set(4096, 4096);
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
      edge: 0.18,
    };
    this.surfaces.push(this.notebookSurface);
  }

  private buildDesk() {
    const { map } = deskTextures();
    map.repeat.set(5, 5);
    const desk = new THREE.Mesh(
      new THREE.PlaneGeometry(260, 260),
      new THREE.MeshStandardMaterial({ map, roughness: 0.92, metalness: 0 }),
    );
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
    return new THREE.Mesh(
      g,
      new THREE.MeshStandardMaterial({ color: '#ff5a1f', roughness: 0.42, side: THREE.DoubleSide }),
    );
  }

  /** Height of whatever is under (x, z). */
  heightAt = (x: number, z: number): number => {
    let h = 0;
    for (const s of this.surfaces) {
      const c = Math.cos(s.yaw);
      const sn = Math.sin(s.yaw);
      const dx = x - s.x;
      const dz = z - s.z;
      const lx = Math.abs(c * dx - sn * dz) - s.w / 2;
      const lz = Math.abs(sn * dx + c * dz) - s.d / 2;
      const out = Math.max(lx, lz);
      if (out > s.edge) continue;
      const k = out <= 0 ? 1 : 1 - smooth(out / s.edge);
      h = Math.max(h, s.top * k);
    }
    return h;
  };

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

  frame(min: THREE.Vector2, max: THREE.Vector2) {
    this.bounds.set(min, max);
    this.resize();
  }

  resize() {
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
    this.orbit.yaw += (this.orbit.tYaw - this.orbit.yaw) * k;
    this.orbit.pitch += (this.orbit.tPitch - this.orbit.pitch) * k;
    this.updateCamera();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

function smooth(t: number) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}
