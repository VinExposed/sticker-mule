import { describe, expect, it } from 'vitest';
import { decode, encode, type Composition } from './persist';

const comp: Composition = {
  v: 1,
  s: [
    { d: 'mule', f: 'gloss', x: 1.23456, z: -4.5, a: 0.123456, l: 0.006 },
    { d: 'u-abc', f: 'holo', x: -2, z: 3.333333, a: -1, l: 0.018 },
  ],
  u: { 'u-abc': 'data:image/webp;base64,AAAA' },
};

describe('persist', () => {
  it('round-trips through the URL encoding', async () => {
    const back = await decode(await encode(comp));
    expect(back?.s.map((s) => s.d)).toEqual(['mule', 'u-abc']);
    expect(back?.s[0].x).toBeCloseTo(1.23, 2);
    expect(back?.s[1].a).toBe(-1);
    expect(back?.u?.['u-abc']).toBe('data:image/webp;base64,AAAA');
  });

  it('only uses URL-safe characters', async () => {
    expect(await encode(comp)).toMatch(/^[zj][A-Za-z0-9_-]+$/);
  });

  it('drops an empty art table', async () => {
    const back = await decode(await encode({ v: 1, s: [], u: {} }));
    expect(back).toEqual({ v: 1, s: [] });
  });

  it('drops entries a link could use to cause trouble', async () => {
    const evil = {
      v: 1,
      s: [
        { d: 'mule', f: 'gloss', x: 1, z: 2, a: 0, l: 0.006 },
        { d: 'mule', f: 'gold', x: 1, z: 2, a: 0, l: 0.006 },
        { d: '../x:y', f: 'gloss', x: 1, z: 2, a: 0, l: 0.006 },
        { d: 'mule', f: 'gloss', x: null, z: 2, a: 0, l: 0.006 },
        { d: 'mule', f: 'gloss', x: 1e9, z: 2, a: 0, l: 0.006 },
        { d: 'mule', f: 'gloss', x: 1, z: 2, a: 0, l: -1 },
      ],
      u: { 'u-1': 'https://tracker.example/pixel.png', 'u-2': 'data:image/webp;base64,AAAA' },
    };
    const back = await decode('j' + btoa(JSON.stringify(evil)));
    expect(back?.s).toHaveLength(1);
    expect(back?.u).toEqual({ 'u-2': 'data:image/webp;base64,AAAA' });
  });

  it('rejects garbage instead of throwing', async () => {
    expect(await decode('')).toBeNull();
    expect(await decode('z!!!not-base64')).toBeNull();
    expect(await decode('j' + btoa('{"v":2,"s":[]}'))).toBeNull();
  });
});
