/**
 * Turns artwork (an SVG or any bitmap) into a die-cut sticker: a white border
 * grown from the art's silhouette, a back side, an optional foil mask, and a
 * low-res mask + distance field used for hit testing and choosing which way a
 * sticker wants to peel.
 */

export type Finish = 'gloss' | 'matte' | 'holo';

export interface StickerSource {
  key: string;
  name: string;
  finish: Finish;
  front: HTMLCanvasElement;
  back: HTMLCanvasElement;
  /** White where holographic foil shows. Always present; empty for non-holo. */
  foil: HTMLCanvasElement;
  /** Physical size in cm. */
  width: number;
  height: number;
  /** Coarse coverage grid (row-major, `mw` x `mh`), 1 = sticker. */
  mask: Uint8Array;
  mw: number;
  mh: number;
  /** Distance to the nearest edge in cm for each mask cell (0 outside). */
  dist: Float32Array;
  /** Centres of covered mask cells in local cm, packed [x0,y0,x1,y1,...]. */
  points: Float32Array;
  /** Original art bitmap (for persistence of user stickers). */
  art?: HTMLCanvasElement;
}

const RES = 768;

export async function rasterizeSvg(svg: string, size = RES): Promise<HTMLCanvasElement> {
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const c = canvas(size, size);
    c.getContext('2d')!.drawImage(img, 0, 0, size, size);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Union of the silhouette shifted around a disc: a cheap Minkowski dilation. */
function dilate(src: HTMLCanvasElement, radius: number, color: string): HTMLCanvasElement {
  const out = canvas(src.width, src.height);
  const g = out.getContext('2d')!;
  const rings = Math.max(1, Math.ceil(radius / 6));
  for (let ring = 1; ring <= rings; ring++) {
    const rr = (radius * ring) / rings;
    const steps = Math.max(12, Math.ceil(rr * 0.9));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      g.drawImage(src, Math.cos(a) * rr, Math.sin(a) * rr);
    }
  }
  g.drawImage(src, 0, 0);
  // Harden the alpha so the die line is crisp, then tint.
  const img = g.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i];
    d[i] = a < 40 ? 0 : a > 140 ? 255 : Math.round(((a - 40) / 100) * 255);
  }
  g.putImageData(img, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, out.width, out.height);
  return out;
}

function padded(src: CanvasImageSource, w: number, h: number, pad: number): HTMLCanvasElement {
  const c = canvas(w + pad * 2, h + pad * 2);
  c.getContext('2d')!.drawImage(src, pad, pad, w, h);
  return c;
}

function bbox(c: HTMLCanvasElement) {
  const { width: w, height: h } = c;
  const d = c.getContext('2d')!.getImageData(0, 0, w, h).data;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w, h };
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function crop(src: HTMLCanvasElement, b: { x: number; y: number; w: number; h: number }, pad: number) {
  const c = canvas(b.w + pad * 2, b.h + pad * 2);
  c.getContext('2d')!.drawImage(src, b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2, 0, 0, c.width, c.height);
  return c;
}

function noise(g: CanvasRenderingContext2D, w: number, h: number, amount: number) {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const n = (Math.random() - 0.5) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

export interface BuildOptions {
  key: string;
  name: string;
  finish: Finish;
  /** Art bitmap with transparent background. */
  art: HTMLCanvasElement;
  /** White where foil should show (same size as art). */
  foilArt?: HTMLCanvasElement | null;
  /** Longest side of the finished sticker in cm. */
  size?: number;
  keepArt?: boolean;
}

export function buildSticker(o: BuildOptions): StickerSource {
  const S = Math.max(o.art.width, o.art.height);
  const border = Math.round(S * 0.042);
  const pad = border + 6;
  const art = padded(o.art, o.art.width, o.art.height, pad);

  const cut = dilate(art, border, '#fbfaf6');
  const edge = dilate(cut, 2.5, 'rgba(120,110,100,0.35)');

  const full = canvas(art.width, art.height);
  const g = full.getContext('2d')!;
  g.drawImage(edge, 0, 0);
  g.drawImage(cut, 0, 0);
  g.drawImage(art, 0, 0);

  const b = bbox(full);
  const front = crop(full, b, 2);

  // Back: the adhesive side. Off-white, a touch of grain, same outline.
  const back = canvas(front.width, front.height);
  {
    const bg = back.getContext('2d')!;
    bg.drawImage(crop(cut, b, 2), 0, 0);
    bg.globalCompositeOperation = 'source-in';
    bg.fillStyle = '#f1f1ee';
    bg.fillRect(0, 0, back.width, back.height);
    bg.globalCompositeOperation = 'source-over';
    noise(bg, back.width, back.height, 10);
  }

  // Foil: holo stickers are printed on holographic vinyl, so the die-cut
  // border is foil, plus whatever the art marks as foil.
  const foil = canvas(front.width, front.height);
  if (o.finish === 'holo') {
    const fg = foil.getContext('2d')!;
    const ring = canvas(full.width, full.height);
    const rg = ring.getContext('2d')!;
    rg.drawImage(cut, 0, 0);
    rg.globalCompositeOperation = 'destination-out';
    rg.drawImage(art, 0, 0);
    fg.drawImage(crop(ring, b, 2), 0, 0);
    if (o.foilArt) {
      const fa = padded(o.foilArt, o.art.width, o.art.height, pad);
      // Only foil where the art actually is.
      const fc = fa.getContext('2d')!;
      fc.globalCompositeOperation = 'destination-in';
      fc.drawImage(art, 0, 0);
      fg.drawImage(crop(fa, b, 2), 0, 0);
    }
  }

  const longest = Math.max(front.width, front.height);
  const size = o.size ?? 5.6;
  const width = (front.width / longest) * size;
  const height = (front.height / longest) * size;

  const m = buildMask(front, width, height);
  return {
    key: o.key,
    name: o.name,
    finish: o.finish,
    front,
    back,
    foil,
    width,
    height,
    ...m,
    art: o.keepArt ? o.art : undefined,
  };
}

function buildMask(front: HTMLCanvasElement, width: number, height: number) {
  const long = 96;
  const mw = Math.max(8, Math.round((front.width / Math.max(front.width, front.height)) * long));
  const mh = Math.max(8, Math.round((front.height / Math.max(front.width, front.height)) * long));
  const small = canvas(mw, mh);
  const sg = small.getContext('2d')!;
  sg.drawImage(front, 0, 0, mw, mh);
  const d = sg.getImageData(0, 0, mw, mh).data;
  const mask = new Uint8Array(mw * mh);
  for (let i = 0; i < mw * mh; i++) mask[i] = d[i * 4 + 3] > 127 ? 1 : 0;

  // Two-pass chamfer distance (to the nearest uncovered cell), in cells.
  const INF = 1e9;
  const dist = new Float32Array(mw * mh);
  for (let i = 0; i < dist.length; i++) dist[i] = mask[i] ? INF : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= mw || y >= mh ? 0 : dist[y * mw + x]);
  const D = Math.SQRT2;
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const i = y * mw + x;
      if (!dist[i]) continue;
      dist[i] = Math.min(dist[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + D, at(x + 1, y - 1) + D);
    }
  }
  for (let y = mh - 1; y >= 0; y--) {
    for (let x = mw - 1; x >= 0; x--) {
      const i = y * mw + x;
      if (!dist[i]) continue;
      dist[i] = Math.min(dist[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + D, at(x - 1, y + 1) + D);
    }
  }
  const cell = width / mw;
  const pts: number[] = [];
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const i = y * mw + x;
      // Cell centre sits half a cell inside the true edge.
      if (mask[i]) {
        dist[i] = (dist[i] - 0.5) * cell;
        pts.push(((x + 0.5) / mw - 0.5) * width, ((y + 0.5) / mh - 0.5) * height);
      }
    }
  }
  return { mask, mw, mh, dist, points: new Float32Array(pts) };
}

/** Is local point (cm) on the sticker? */
export function covers(s: StickerSource, x: number, y: number): boolean {
  const mx = Math.floor((x / s.width + 0.5) * s.mw);
  const my = Math.floor((y / s.height + 0.5) * s.mh);
  if (mx < 0 || my < 0 || mx >= s.mw || my >= s.mh) return false;
  return s.mask[my * s.mw + mx] === 1;
}

/** Edge distance (cm) and the inward direction (toward the sticker's interior). */
export function edgeInfo(s: StickerSource, x: number, y: number) {
  const fx = (x / s.width + 0.5) * s.mw - 0.5;
  const fy = (y / s.height + 0.5) * s.mh - 0.5;
  const sample = (ix: number, iy: number) => {
    const cx = Math.min(s.mw - 1, Math.max(0, ix));
    const cy = Math.min(s.mh - 1, Math.max(0, iy));
    if (ix < 0 || iy < 0 || ix >= s.mw || iy >= s.mh) return 0;
    return s.dist[cy * s.mw + cx];
  };
  const ix = Math.round(fx);
  const iy = Math.round(fy);
  // Wide central difference so the gradient is smooth across chamfer steps.
  const k = 2;
  let gx = sample(ix + k, iy) - sample(ix - k, iy);
  let gy = sample(ix, iy + k) - sample(ix, iy - k);
  gx += 0.5 * (sample(ix + k, iy + k) - sample(ix - k, iy + k) + sample(ix + k, iy - k) - sample(ix - k, iy - k));
  gy += 0.5 * (sample(ix + k, iy + k) - sample(ix + k, iy - k) + sample(ix - k, iy + k) - sample(ix - k, iy - k));
  let len = Math.hypot(gx, gy);
  if (len < 1e-6) {
    // Flat region (deep inside): fall back to "toward the centre of mass".
    gx = -x;
    gy = -y;
    len = Math.hypot(gx, gy) || 1;
  }
  return { dist: sample(ix, iy), nx: gx / len, ny: gy / len };
}

/** Furthest extent of the sticker along a direction (for "fully peeled?"). */
export function extent(s: StickerSource, dx: number, dy: number) {
  let lo = Infinity;
  let hi = -Infinity;
  const p = s.points;
  for (let i = 0; i < p.length; i += 2) {
    const u = p[i] * dx + p[i + 1] * dy;
    if (u < lo) lo = u;
    if (u > hi) hi = u;
  }
  const half = (s.width / s.mw) * 0.5;
  return { lo: lo - half, hi: hi + half };
}
