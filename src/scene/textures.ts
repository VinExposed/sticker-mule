import * as THREE from 'three';
import { canvas, grain } from '../stickers/factory';

/** Small deterministic PRNG so textures look the same on every load. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function canvasTexture(c: HTMLCanvasElement, srgb: boolean, repeat = 1) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  return t;
}

/** Soft desk mat: warm, very fine grain with a few long fibres. */
export function deskTexture() {
  const size = 1024;
  const r = rng(7);
  const color = canvas(size, size);
  const g = color.getContext('2d')!;
  g.fillStyle = '#d8d2c7';
  g.fillRect(0, 0, size, size);
  grain(g, size, size, 0.07);
  // Mottling.
  for (let i = 0; i < 260; i++) {
    const x = r() * size;
    const y = r() * size;
    const rad = 20 + r() * 90;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    const a = 0.025 * r();
    const tone = r() > 0.5 ? `rgba(255,250,240,${a})` : `rgba(90,80,70,${a})`;
    grad.addColorStop(0, tone);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    for (const ox of [-size, 0, size])
      for (const oy of [-size, 0, size]) {
        g.save();
        g.translate(ox, oy);
        g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
        g.restore();
      }
  }
  // Fibres.
  g.lineCap = 'round';
  for (let i = 0; i < 500; i++) {
    const x = r() * size;
    const y = r() * size;
    const len = 4 + r() * 18;
    const a = r() * Math.PI * 2;
    g.strokeStyle = r() > 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(70,60,50,0.07)';
    g.lineWidth = 0.6 + r() * 0.6;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(a + 0.5) * len * 0.5, y + Math.sin(a + 0.5) * len * 0.5, x + Math.cos(a) * len, y + Math.sin(a) * len);
    g.stroke();
  }
  return canvasTexture(color, true, 1);
}

/** Bookcloth: near-black with soft mottling and a faint woven grain. */
export function clothTexture() {
  const size = 1024;
  const r = rng(3);
  const c = canvas(size, size);
  const g = c.getContext('2d')!;
  g.fillStyle = '#26252c';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 400; i++) {
    const x = r() * size;
    const y = r() * size;
    const rad = 30 + r() * 140;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    const a = 0.012 * r();
    grad.addColorStop(0, r() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 1.5})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    // Draw wrapped so the texture tiles without seams.
    for (const ox of [-size, 0, size])
      for (const oy of [-size, 0, size]) {
        g.save();
        g.translate(ox, oy);
        g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
        g.restore();
      }
  }
  // Threads: short, slightly irregular strokes in two directions.
  for (let i = 0; i < 9000; i++) {
    const x = r() * size;
    const y = r() * size;
    const h = r() > 0.5;
    const len = 3 + r() * 9;
    g.fillStyle = r() > 0.5 ? `rgba(255,255,255,${0.02 + r() * 0.03})` : `rgba(0,0,0,${0.05 + r() * 0.06})`;
    if (h) g.fillRect(x, y, len, 1);
    else g.fillRect(x, y, 1, len);
  }
  return c;
}

/** Page edges: tight horizontal lines in warm cream. */
export function pageEdgeTexture() {
  const c = canvas(64, 512);
  const g = c.getContext('2d')!;
  const r = rng(11);
  g.fillStyle = '#efe7d6';
  g.fillRect(0, 0, 64, 512);
  for (let y = 0; y < 512; y += 2) {
    const v = 200 + r() * 40;
    g.fillStyle = `rgba(${v - 20},${v - 28},${v - 45},${0.25 + r() * 0.35})`;
    g.fillRect(0, y, 64, 1);
  }
  return c;
}

/** The cover's foil-stamped wordmark. */
export function stampTexture() {
  const c = canvas(680, 240);
  const g = c.getContext('2d')!;
  g.font = '900 150px "Arial Black", "Helvetica Neue", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const w = g.measureText('peel').width;
  g.fillStyle = '#36343c';
  g.fillText('peel', 340 - 22, 118);
  g.beginPath();
  g.arc(340 - 22 + w / 2 + 34, 160, 20, 0, Math.PI * 2);
  g.fill();
  return c;
}
