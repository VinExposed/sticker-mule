/**
 * Compositions are stored relative to the notebook, so a layout made on a
 * phone (notebook at the top) restores correctly on a laptop (notebook on the
 * left). The payload is deflated and base64url'd into the URL hash; user art
 * rides along as small PNGs.
 */

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
  /** user art: design id -> PNG data URL */
  u?: Record<string, string>;
}

const round = (n: number, p = 100) => Math.round(n * p) / p;

export function compact(c: Composition): Composition {
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
    const c = JSON.parse(text) as Composition;
    if (c.v !== 1 || !Array.isArray(c.s)) return null;
    return c;
  } catch {
    return null;
  }
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
