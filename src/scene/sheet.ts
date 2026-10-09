import * as THREE from 'three';
import { canvas, type StickerSource } from '../stickers/factory';
import { rng } from './textures';

export const SHEET = { w: 13.4, d: 18.6, t: 0.035 };
const PX = 90; // texture pixels per cm

export interface Slot {
  src: StickerSource;
  /** Sheet-local centre (cm, x right, y down) and rotation. */
  x: number;
  y: number;
  yaw: number;
}

/** Arrange a pack in a loose 3 x 4 grid under a printed header. */
export function layoutPack(sources: StickerSource[], seed: number): Slot[] {
  const r = rng(seed);
  const cols = 3;
  const rows = 4;
  const header = 2.6;
  const margin = 0.55;
  const cw = (SHEET.w - margin * 2) / cols;
  const ch = (SHEET.d - header - margin * 1.2) / rows;
  const slots: Slot[] = [];
  for (let i = 0; i < Math.min(sources.length, cols * rows); i++) {
    const c = i % cols;
    const row = Math.floor(i / cols);
    slots.push({
      src: sources[i],
      x: -SHEET.w / 2 + margin + cw * (c + 0.5) + (r() - 0.5) * 0.3,
      y: -SHEET.d / 2 + header + ch * (row + 0.5) + (r() - 0.5) * 0.25,
      yaw: (r() - 0.5) * 0.32,
    });
  }
  return slots;
}

export function buildSheet(slots: Slot[], packNo: number) {
  const W = Math.round(SHEET.w * PX);
  const H = Math.round(SHEET.d * PX);
  const color = canvas(W, H);
  const rough = canvas(W, H);
  const g = color.getContext('2d')!;
  const rg = rough.getContext('2d')!;

  // Vinyl face.
  g.fillStyle = '#f8f6f1';
  g.fillRect(0, 0, W, H);
  rg.fillStyle = '#9a9a9a';
  rg.fillRect(0, 0, W, H);

  // Header print.
  const ink = '#1a181d';
  g.fillStyle = ink;
  g.font = `900 ${0.95 * PX}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
  g.textBaseline = 'alphabetic';
  g.fillText('peel', 0.7 * PX, 1.55 * PX);
  const pw = g.measureText('peel').width;
  g.fillStyle = '#ff5a1f';
  g.beginPath();
  g.arc(0.7 * PX + pw + 0.2 * PX, 1.45 * PX, 0.13 * PX, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = ink;
  g.font = `600 ${0.27 * PX}px "Helvetica Neue", Arial, sans-serif`;
  g.textAlign = 'right';
  g.fillText(`STRANGE CHARACTERS  ·  PACK ${String(packNo).padStart(2, '0')}`, W - 0.7 * PX, 1.0 * PX);
  g.fillStyle = 'rgba(26,24,29,0.55)';
  g.font = `500 ${0.22 * PX}px "Helvetica Neue", Arial, sans-serif`;
  g.fillText(`${slots.length} die-cut vinyl stickers — peel, stick, repeat`, W - 0.7 * PX, 1.45 * PX);
  g.textAlign = 'left';
  g.fillStyle = 'rgba(26,24,29,0.12)';
  g.fillRect(0.7 * PX, 1.95 * PX, W - 1.4 * PX, 2);

  // Little registration marks in the corners, like a real print sheet.
  g.strokeStyle = 'rgba(26,24,29,0.35)';
  g.lineWidth = 2;
  for (const [cx, cy] of [
    [0.35, 0.35],
    [SHEET.w - 0.35, 0.35],
    [0.35, SHEET.d - 0.35],
    [SHEET.w - 0.35, SHEET.d - 0.35],
  ]) {
    g.beginPath();
    g.arc(cx * PX, cy * PX, 0.09 * PX, 0, Math.PI * 2);
    g.moveTo(cx * PX - 0.16 * PX, cy * PX);
    g.lineTo(cx * PX + 0.16 * PX, cy * PX);
    g.moveTo(cx * PX, cy * PX - 0.16 * PX);
    g.lineTo(cx * PX, cy * PX + 0.16 * PX);
    g.stroke();
  }

  // Kiss-cut holes: where each sticker sits there's glossy liner underneath.
  for (const s of slots) {
    const sil = silhouette(s.src.front);
    const draw = (ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, ox = 0, oy = 0, grow = 0) => {
      ctx.save();
      ctx.translate((s.x + SHEET.w / 2) * PX + ox, (s.y + SHEET.d / 2) * PX + oy);
      ctx.rotate(-s.yaw);
      const w = s.src.width * PX + grow * 2;
      const h = s.src.height * PX + grow * 2;
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();
    };
    draw(g, tint(sil, 'rgba(60,50,40,0.55)'), 0, 0, 1.2);
    draw(g, tint(sil, '#d6c4a2'), 1.4, 1.8, -0.6);
    draw(rg, tint(sil, '#303030'), 0, 0, 0);
  }

  // A barely-there grain so the vinyl doesn't look like flat CG white.
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  const r = rng(packNo * 13 + 1);
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * 5;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  const map = new THREE.CanvasTexture(color);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const roughnessMap = new THREE.CanvasTexture(rough);
  roughnessMap.anisotropy = 8;

  const shape = roundedRect(SHEET.w, SHEET.d, 0.45);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: SHEET.t, bevelEnabled: false, curveSegments: 8 });
  // Shape is in XY; lay it on the desk with +y in the shape = -z in the world.
  geo.rotateX(-Math.PI / 2);
  // Map cap UVs from shape coordinates.
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, pos.getX(i) / SHEET.w + 0.5, -pos.getZ(i) / SHEET.d + 0.5);
  }
  const mat = new THREE.MeshStandardMaterial({ map, roughnessMap, roughness: 1, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = true;
  return {
    mesh,
    dispose() {
      geo.dispose();
      mat.dispose();
      map.dispose();
      roughnessMap.dispose();
    },
  };
}

function roundedRect(w: number, h: number, r: number) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function silhouette(front: HTMLCanvasElement) {
  return front;
}

function tint(src: HTMLCanvasElement, color: string) {
  const c = canvas(src.width, src.height);
  const g = c.getContext('2d')!;
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}
