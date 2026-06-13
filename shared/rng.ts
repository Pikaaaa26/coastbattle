// Deterministic seeded RNG so every player gets the identical generated map.

export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

export function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  next: () => number; // [0,1)
  int: (n: number) => number; // [0,n)
  range: (a: number, b: number) => number; // inclusive [a,b]
  chance: (p: number) => boolean;
  pick: <T>(arr: T[]) => T;
  shuffle: <T>(arr: T[]) => T[];
}

export function makeRng(seed: number | string): Rng {
  const s = typeof seed === 'string' ? xmur3(seed)() : seed >>> 0;
  const r = mulberry32(s || 1);
  const api: Rng = {
    next: r,
    int: (n) => Math.floor(r() * n),
    range: (a, b) => a + Math.floor(r() * (b - a + 1)),
    chance: (p) => r() < p,
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    shuffle: (arr) => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
  return api;
}

export function randomSeed(): number {
  // Only used to *create* a game seed (host side); thereafter deterministic.
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
}
