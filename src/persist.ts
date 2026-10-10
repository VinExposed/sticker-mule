/**
 * The saved form of a notebook, and how it travels: deflated and base64url'd
 * into the URL hash (or localStorage), with any user art riding along as a
 * small image. See composition.ts for how it maps to the desk.
 */

const FINISHES = ['gloss', 'matte', 'holo'];

export interface SavedSticker {
  /** design id */
  d: string;
  /** finish */
  f: string;
  /** notebook-local x, z (cm), yaw (rad), layer (cm) */
  x: number;
  z: number;
  a: number;
  l: number;
}

export interface Composition {
  v: 1;
  s: SavedSticker[];
  /** user art: design id -> image data URL */
  u?: Record<string, string>;
}

const round = (n: number, p = 100) => Math.round(n * p) / p;

function compact(c: Composition): Composition {
  return {
    v: 1,
    s: c.s.map((s) => ({ ...s, x: round(s.x), z: round(s.z), a: round(s.a, 1000), l: round(s.l, 1000) })),
    u: c.u && Object.keys(c.u).length ? c.u : undefined,
  };
}

export async function encode(c: Composition): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(compact(c)));
  if (typeof CompressionStream === 'undefined') return 'j' + b64url(json);
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  return 'z' + b64url(buf);
}

export async function decode(s: string): Promise<Composition | null> {
  try {
    const kind = s[0];
    const bytes = unb64url(s.slice(1));
    let text: string;
    if (kind === 'z') {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      text = await new Response(stream).text();
    } else {
      text = new TextDecoder().decode(bytes);
    }
    return sanitize(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * A link can contain anything, so only keep what we'd have written: known
 * finishes, finite numbers in range, plain ids, and art that is an inline
 * image (never a URL that would make the browser fetch from elsewhere).
 */
function sanitize(raw: unknown): Composition | null {
  const c = raw as Partial<Composition> | null;
  if (!c || c.v !== 1 || !Array.isArray(c.s)) return null;
  const id = /^[a-z0-9-]{1,40}$/;
  const finite = (n: unknown, limit: number): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= limit;
  const s = c.s.filter(
    (t): t is SavedSticker =>
      !!t &&
      typeof t.d === 'string' &&
      id.test(t.d) &&
      FINISHES.includes(t.f) &&
      finite(t.x, 100) &&
      finite(t.z, 100) &&
      finite(t.a, 100) &&
      finite(t.l, 5),
  );
  const u: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.u ?? {})) {
    if (id.test(k) && typeof v === 'string' && /^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(v)) u[k] = v;
  }
  return Object.keys(u).length ? { v: 1, s, u } : { v: 1, s };
}

function b64url(bytes: Uint8Array) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s: string) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const KEY = 'peel.composition.v1';

export function saveLocal(encoded: string) {
  try {
    localStorage.setItem(KEY, encoded);
  } catch {
    /* storage full or blocked: not fatal */
  }
}

export function loadLocal(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function clearLocal() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
