import { STICKER_ART } from './stickers/art';
import { buildSticker, canvas, rasterizeSvg, type Finish, type StickerSource } from './stickers/factory';

/**
 * Every sticker design the app knows about, keyed by `<design>:<finish>`.
 * Built-in designs come from SVG; user designs from a bitmap that we keep a
 * small WebP of so compositions can be saved and shared.
 */
export class Library {
  private cache = new Map<string, Promise<StickerSource>>();
  private art = new Map<string, { canvas: HTMLCanvasElement; foil: HTMLCanvasElement | null; name: string }>();
  /** User designs: id -> small image data URL. */
  readonly custom = new Map<string, string>();

  get builtins() {
    return STICKER_ART.map((a) => ({ id: a.id, name: a.name, finish: a.finish }));
  }

  async source(design: string, finish?: Finish): Promise<StickerSource> {
    const def = STICKER_ART.find((a) => a.id === design);
    const f: Finish = finish ?? def?.finish ?? 'gloss';
    const key = `${design}:${f}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.build(design, f);
      this.cache.set(key, p);
    }
    return p;
  }

  private async build(design: string, finish: Finish): Promise<StickerSource> {
    let a = this.art.get(design);
    if (!a) {
      const def = STICKER_ART.find((x) => x.id === design);
      if (def) {
        const [c, foil] = await Promise.all([rasterizeSvg(def.svg), def.foil ? rasterizeSvg(def.foil) : Promise.resolve(null)]);
        a = { canvas: c, foil, name: def.name };
      } else if (this.custom.has(design)) {
        const c = await loadBitmap(this.custom.get(design)!);
        a = { canvas: c, foil: null, name: 'Yours' };
      } else {
        throw new Error(`unknown sticker ${design}`);
      }
      this.art.set(design, a);
    }
    // Give the main thread a breather between stickers so loading a pack
    // never blocks input for long.
    await new Promise((r) => setTimeout(r, 0));
    // User art: foil the light parts so holo looks intentional.
    const foil = a.foil ?? (finish === 'holo' && this.custom.has(design) ? lightAreas(a.canvas) : null);
    return buildSticker({
      key: `${design}:${finish}`,
      name: a.name,
      finish,
      art: a.canvas,
      foilArt: foil,
      size: design.startsWith('u-') ? 5 : sizeFor(design),
    });
  }

  /** Register a user drawing/upload. Returns its design id. */
  addCustom(art: HTMLCanvasElement): string {
    const small = downscale(art, 320);
    // WebP keeps share links short; browsers that can't encode it give PNG.
    const url = small.toDataURL('image/webp', 0.86);
    const id = `u-${hash(url)}`;
    this.custom.set(id, url);
    this.art.set(id, { canvas: art, foil: null, name: 'Yours' });
    return id;
  }

  /** Register user art that arrived in a saved/shared composition. */
  addCustomFromUrl(id: string, url: string) {
    if (!this.custom.has(id)) this.custom.set(id, url);
  }
}

/** Slight size variety, like a real pack. */
function sizeFor(id: string) {
  switch (id) {
    case 'peel-me':
      return 3.5;
    case 'bolt':
    case 'cactus':
      return 3.75;
    case 'star':
      return 3.45;
    default:
      return 3.6;
  }
}

function loadBitmap(url: string): Promise<HTMLCanvasElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const scale = 768 / Math.max(img.width, img.height);
      const c = canvas(img.width * scale, img.height * scale);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      res(c);
    };
    img.onerror = rej;
    img.src = url;
  });
}

function downscale(src: HTMLCanvasElement, max: number) {
  const s = Math.min(1, max / Math.max(src.width, src.height));
  const c = canvas(src.width * s, src.height * s);
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function lightAreas(src: HTMLCanvasElement) {
  const c = canvas(src.width, src.height);
  const g = c.getContext('2d')!;
  g.drawImage(src, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) / 255;
    const v = d[i + 3] > 10 ? Math.round(Math.min(1, Math.max(0, (l - 0.55) / 0.3)) * 255) : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
