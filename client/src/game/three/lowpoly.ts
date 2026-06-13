// Low-poly diorama model library (three.js). Flat-shaded primitives, per-tile building
// modules, and a destroyed (ruin) counterpart for every tile.
import * as THREE from 'three';
import type { BuildingType, TerrainType } from '@shared/types';

// ---------- palette ----------
export const P = {
  grass: '#6fc25b',
  grassDark: '#5aa94a',
  sand: '#e8d191',
  dirt: '#9a6b42',
  dirtDark: '#7a5232',
  rock: '#8d93a0',
  rockDark: '#6d7380',
  snow: '#eef3f8',
  waterDeep: '#1d6fa3',
  waterShallow: '#3ea7c9',
  waterSide: '#15506f',
  toxic: '#4a5a22',
  toxicGlow: '#8aff4a',
  concrete: '#b9bfc7',
  concreteDark: '#8e949c',
  steel: '#9aa6b4',
  steelDark: '#5f6a78',
  hull: '#d9dee5',
  roofRed: '#c4574e',
  warnYellow: '#f2c84b',
  fire: '#ff7a2a',
  char: '#2a241e',
  charDark: '#1a1612',
  trunk: '#7a5232',
  leaf: '#4e9a44',
  leafDark: '#3d7a36',
} as const;

const matCache = new Map<string, THREE.MeshStandardMaterial>();
export function mat(color: string, opts: { emissive?: string; opacity?: number; rough?: number } = {}) {
  const key = `${color}|${opts.emissive || ''}|${opts.opacity ?? 1}|${opts.rough ?? 0.85}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      flatShading: true,
      roughness: opts.rough ?? 0.85,
      metalness: 0.05,
    });
    if (opts.emissive) {
      m.emissive = new THREE.Color(opts.emissive);
      m.emissiveIntensity = 1;
    }
    if (opts.opacity !== undefined && opts.opacity < 1) {
      m.transparent = true;
      m.opacity = opts.opacity;
    }
    matCache.set(key, m);
  }
  return m;
}

// ---------- primitive helpers (all cast/receive shadows) ----------
function setSh(m: THREE.Mesh) {
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
export function box(w: number, h: number, d: number, color: string, x = 0, y = 0, z = 0, e?: string): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, { emissive: e }));
  m.position.set(x, y, z);
  return setSh(m);
}
export function cyl(rt: number, rb: number, h: number, color: string, x = 0, y = 0, z = 0, seg = 8, e?: string): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat(color, { emissive: e }));
  m.position.set(x, y, z);
  return setSh(m);
}
export function cone(r: number, h: number, color: string, x = 0, y = 0, z = 0, seg = 6): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), mat(color));
  m.position.set(x, y, z);
  return setSh(m);
}
export function dome(r: number, color: string, x = 0, y = 0, z = 0, opacity = 1): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(r, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
    mat(color, { opacity }),
  );
  m.position.set(x, y, z);
  return setSh(m);
}
// triangular prism (gable roof): 3-seg cylinder laid on its side
export function gable(len: number, r: number, color: string, x = 0, y = 0, z = 0, alongX = true): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 3), mat(color));
  m.rotation.z = alongX ? Math.PI / 2 : 0;
  m.rotation.x = alongX ? 0 : Math.PI / 2;
  m.rotation.y = alongX ? 0 : 0;
  if (!alongX) m.rotation.z = Math.PI / 6;
  else m.rotation.x = Math.PI / 6 + Math.PI / 2 - Math.PI / 2; // keep flat edge down
  m.position.set(x, y, z);
  return setSh(m);
}

export interface Anim {
  spin?: { obj: THREE.Object3D; axis: 'x' | 'y' | 'z'; speed: number }[];
  sway?: { obj: THREE.Object3D; axis: 'x' | 'y' | 'z'; amp: number; speed: number; base?: number }[];
  blink?: { mesh: THREE.Mesh; speed: number }[];
  radiation?: { points: THREE.Points; speed: number; phase: number }[];
  smoke?: THREE.Vector3[]; // local anchors for smoke puffs
  flame?: THREE.Vector3[]; // local anchors for fire flicker
  bob?: { obj: THREE.Object3D; axis: 'x' | 'y' | 'z'; base: number; amp: number; speed: number }[];
  pulse?: { mesh: THREE.Mesh; speed: number; baseOpacity: number; amp: number }[];
}
export function getAnim(g: THREE.Object3D): Anim {
  return ((g.userData.anim ||= {}) as Anim);
}

// deterministic hash 0..1
export function hash01(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 1442695040888963407) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

// ===================== TERRAIN =====================
export const LAND_TOP = 0.3; // y of land surface
export const WATER_TOP = 0.12;

export interface TerrainNeighbors {
  n?: TerrainType;
  e?: TerrainType;
  s?: TerrainType;
  w?: TerrainType;
  ne?: TerrainType;
  se?: TerrainType;
  sw?: TerrainType;
  nw?: TerrainType;
}

function terrainIsWater(t?: TerrainType) {
  return t === 'deep' || t === 'reef' || t === undefined;
}
function terrainIsRock(t?: TerrainType) {
  return t === 'mountain' || t === 'rubble' || t === 'irradiated';
}
type TerrainDir = 'n' | 'e' | 's' | 'w';
type TerrainCorner = 'nw' | 'ne' | 'sw' | 'se';

const terrainMatCache = new Map<string, THREE.MeshStandardMaterial>();
const TEX = 96;

function terrainEdgeClass(t?: TerrainType) {
  if (terrainIsWater(t)) return 'w';
  if (terrainIsRock(t)) return 'r';
  return 'l';
}
function terrainSignature(ctx: TerrainNeighbors) {
  return (['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'] as const).map((d) => terrainEdgeClass(ctx[d])).join('');
}
function jitter(seed: number, salt: number) {
  return hash01(seed, salt, 913);
}
function canvasMaterial(key: string, draw: (c: CanvasRenderingContext2D, seed: number) => void, seed: number, water = false) {
  let m = terrainMatCache.get(key);
  if (m) return m;
  const cv = document.createElement('canvas');
  cv.width = TEX;
  cv.height = TEX;
  const c = cv.getContext('2d')!;
  draw(c, seed);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapNearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  m = new THREE.MeshStandardMaterial({
    map: tex,
    color: new THREE.Color('#ffffff'),
    flatShading: true,
    roughness: water ? 0.58 : 0.92,
    metalness: water ? 0.02 : 0.01,
    transparent: water,
    opacity: water ? 0.94 : 1,
  });
  terrainMatCache.set(key, m);
  return m;
}
function fill(c: CanvasRenderingContext2D, color: string, alpha = 1) {
  c.save();
  c.globalAlpha = alpha;
  c.fillStyle = color;
  c.fillRect(0, 0, TEX, TEX);
  c.restore();
}
function noiseSpecks(c: CanvasRenderingContext2D, seed: number, colors: string[], count: number, alpha = 0.28, max = 5) {
  c.save();
  c.globalAlpha = alpha;
  for (let i = 0; i < count; i++) {
    c.fillStyle = colors[Math.floor(jitter(seed, i + 1) * colors.length)];
    const x = jitter(seed, i + 100) * TEX;
    const y = jitter(seed, i + 200) * TEX;
    const w = 1 + jitter(seed, i + 300) * max;
    const h = 1 + jitter(seed, i + 400) * max;
    c.fillRect(x, y, w, h);
  }
  c.restore();
}
function poly(c: CanvasRenderingContext2D, pts: [number, number][], color: string, alpha = 1) {
  c.save();
  c.globalAlpha = alpha;
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) c.lineTo(x, y);
  c.closePath();
  c.fill();
  c.restore();
}
function edgeRect(c: CanvasRenderingContext2D, dir: TerrainDir, color: string, size: number, alpha = 1) {
  c.save();
  c.globalAlpha = alpha;
  c.fillStyle = color;
  if (dir === 'n') c.fillRect(0, 0, TEX, size);
  if (dir === 's') c.fillRect(0, TEX - size, TEX, size);
  if (dir === 'w') c.fillRect(0, 0, size, TEX);
  if (dir === 'e') c.fillRect(TEX - size, 0, size, TEX);
  c.restore();
}
function cornerPatch(c: CanvasRenderingContext2D, corner: TerrainCorner, color: string, size: number, alpha = 1) {
  const x = corner === 'nw' || corner === 'sw' ? 0 : TEX - size;
  const y = corner === 'nw' || corner === 'ne' ? 0 : TEX - size;
  c.save();
  c.globalAlpha = alpha;
  c.fillStyle = color;
  c.fillRect(x, y, size, size);
  c.restore();
}
function drawGrass(c: CanvasRenderingContext2D, seed: number, ctx: TerrainNeighbors) {
  fill(c, jitter(seed, 9) > 0.5 ? P.grass : P.grassDark);
  poly(c, [[0, 0], [TEX, 0], [TEX, 24], [26, TEX], [0, TEX]], '#79cf68', 0.18);
  poly(c, [[18, 0], [TEX, 0], [TEX, TEX], [66, TEX]], '#4e9b42', 0.13);
  noiseSpecks(c, seed, ['#7ed76b', '#4e9942', '#82d76e', '#5eaf4e'], 54, 0.26, 4);

  for (const dir of ['n', 'e', 's', 'w'] as TerrainDir[]) {
    if (terrainIsWater(ctx[dir])) {
      edgeRect(c, dir, P.sand, 8, 0.78);
      edgeRect(c, dir, '#f4dfab', 3, 0.42);
    } else if (terrainIsRock(ctx[dir])) {
      edgeRect(c, dir, '#6c764a', 14, 0.5);
      edgeRect(c, dir, P.dirt, 4, 0.35);
    }
  }
  for (const dir of ['nw', 'ne', 'sw', 'se'] as TerrainCorner[]) {
    if (terrainIsWater(ctx[dir])) cornerPatch(c, dir, P.sand, 10, 0.55);
  }
  c.save();
  c.lineWidth = 2;
  c.lineCap = 'round';
  for (let i = 0; i < 12; i++) {
    const x = 12 + jitter(seed, 500 + i) * 72;
    const y = 12 + jitter(seed, 600 + i) * 72;
    const len = 5 + jitter(seed, 700 + i) * 8;
    const a = jitter(seed, 800 + i) * Math.PI;
    c.strokeStyle = jitter(seed, 900 + i) > 0.5 ? '#386f30' : '#7edc6e';
    c.globalAlpha = 0.48;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    c.stroke();
  }
  c.restore();
}
function drawWater(c: CanvasRenderingContext2D, seed: number, terrain: TerrainType, ctx: TerrainNeighbors) {
  const reef = terrain === 'reef';
  fill(c, reef ? P.waterShallow : P.waterDeep);
  poly(c, [[0, 0], [TEX, 0], [TEX, 28], [32, 58], [0, 42]], reef ? '#5fc6d7' : '#2d83ad', 0.34);
  poly(c, [[0, 58], [56, 44], [TEX, TEX], [0, TEX]], reef ? '#2698bc' : '#155b85', 0.28);
  noiseSpecks(c, seed, [reef ? '#a9eced' : '#7bc9dd', '#1f82aa', '#ffffff'], reef ? 34 : 22, reef ? 0.18 : 0.1, 5);
  c.save();
  c.lineWidth = 3;
  c.lineCap = 'round';
  for (let i = 0; i < (reef ? 5 : 4); i++) {
    c.globalAlpha = reef ? 0.24 : 0.18;
    c.strokeStyle = reef ? '#d0ffff' : '#98d8ee';
    const x = 12 + jitter(seed, 1000 + i) * 72;
    const y = 14 + jitter(seed, 1100 + i) * 68;
    const w = 16 + jitter(seed, 1200 + i) * 25;
    c.beginPath();
    c.moveTo(x, y);
    c.quadraticCurveTo(x + w * 0.4, y - 6, x + w, y + 1);
    c.stroke();
  }
  c.restore();
  if (reef) {
    poly(c, [[16, 62], [44, 45], [80, 54], [67, 73], [34, 77]], '#b9f2ee', 0.2);
    poly(c, [[8, 34], [27, 20], [61, 24], [46, 40]], '#74d9df', 0.18);
    noiseSpecks(c, seed + 44, ['#bdf5f0', '#7bdbe3', '#e8ffff'], 16, 0.18, 3);
  }
  for (const dir of ['n', 'e', 's', 'w'] as TerrainDir[]) {
    if (!terrainIsWater(ctx[dir])) {
      edgeRect(c, dir, '#d9f4f2', 5, 0.62);
      edgeRect(c, dir, '#ffffff', 2, 0.35);
    }
  }
}
function drawStone(c: CanvasRenderingContext2D, seed: number, terrain: TerrainType, ctx: TerrainNeighbors) {
  if (terrain === 'rubble') {
    fill(c, '#3a342c');
    noiseSpecks(c, seed, [P.char, '#5b4b3d', '#211b16', '#786451'], 70, 0.42, 6);
    for (let i = 0; i < 8; i++) poly(c, [[jitter(seed, i) * TEX, jitter(seed, i + 10) * TEX], [jitter(seed, i + 20) * TEX, jitter(seed, i + 30) * TEX], [jitter(seed, i + 40) * TEX, jitter(seed, i + 50) * TEX]], i % 2 ? P.char : '#5a4a3c', 0.4);
    return;
  }
  if (terrain === 'irradiated') {
    fill(c, P.toxic);
    noiseSpecks(c, seed, ['#60742b', '#263414', '#42551d'], 74, 0.34, 7);
    c.save();
    for (let i = 0; i < 8; i++) {
      c.globalAlpha = 0.12 + jitter(seed, i + 60) * 0.14;
      c.fillStyle = jitter(seed, i + 70) > 0.4 ? '#8aff4a' : '#263414';
      c.beginPath();
      c.ellipse(
        12 + jitter(seed, i + 80) * 72,
        12 + jitter(seed, i + 90) * 72,
        6 + jitter(seed, i + 100) * 14,
        4 + jitter(seed, i + 110) * 10,
        jitter(seed, i + 120) * Math.PI,
        0,
        Math.PI * 2,
      );
      c.fill();
    }
    c.restore();
    return;
  }
  fill(c, P.rock);
  poly(c, [[0, 0], [TEX, 0], [80, 42], [28, 28], [0, 64]], '#a1a8b4', 0.45);
  poly(c, [[0, 70], [48, 42], [TEX, TEX], [0, TEX]], '#6e7480', 0.35);
  noiseSpecks(c, seed, ['#b0b7c2', '#6d7380', '#7f8793'], 44, 0.36, 5);
  for (const dir of ['n', 'e', 's', 'w'] as TerrainDir[]) {
    if (terrainIsWater(ctx[dir])) edgeRect(c, dir, P.sand, 11, 0.55);
  }
}
function terrainTopMaterial(terrain: TerrainType, gx: number, gy: number, ctx: TerrainNeighbors) {
  const variant = Math.floor(hash01(gx, gy, 777) * 16);
  const signature = terrainSignature(ctx);
  const key = `${terrain}|${signature}|${variant}`;
  const seed = gx * 1009 + gy * 9176 + variant * 271;
  if (terrain === 'deep' || terrain === 'reef') return canvasMaterial(key, (c, s) => drawWater(c, s, terrain, ctx), seed, true);
  if (terrain === 'land') return canvasMaterial(key, (c, s) => drawGrass(c, s, ctx), seed);
  return canvasMaterial(key, (c, s) => drawStone(c, s, terrain, ctx), seed);
}

const BEACH_TOP = WATER_TOP + 0.015;
const BEACH_INSET = 0.34;

export function hasWaterNeighbor(ctx: TerrainNeighbors) {
  return (['n', 'e', 's', 'w'] as const).some((d) => terrainIsWater(ctx[d]));
}

export function shorelineInteriorRect(ctx: TerrainNeighbors) {
  return {
    minX: terrainIsWater(ctx.w) ? -0.5 + BEACH_INSET : -0.5,
    maxX: terrainIsWater(ctx.e) ? 0.5 - BEACH_INSET : 0.5,
    minZ: terrainIsWater(ctx.n) ? -0.5 + BEACH_INSET : -0.5,
    maxZ: terrainIsWater(ctx.s) ? 0.5 - BEACH_INSET : 0.5,
  };
}

function addShorelineShelves(g: THREE.Group, ctx: TerrainNeighbors) {
  const low = BEACH_TOP;
  const high = LAND_TOP + 0.014;
  const inner = 0.5 - BEACH_INSET;
  const rect = shorelineInteriorRect(ctx);
  const bankMat = mat(P.sand);
  bankMat.side = THREE.DoubleSide;
  const addBank = (pts: [number, number, number][]) => {
    const verts: number[] = [];
    if (pts.length === 4) {
      // quad: two triangles
      verts.push(...pts[0], ...pts[1], ...pts[2], ...pts[0], ...pts[2], ...pts[3]);
    } else {
      // triangle: single face
      verts.push(...pts[0], ...pts[1], ...pts[2]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.computeVertexNormals();
    const bank = new THREE.Mesh(geo, bankMat);
    bank.castShadow = false;
    bank.receiveShadow = true;
    g.add(bank);
  };

  if (terrainIsWater(ctx.n)) {
    addBank([[rect.minX, low, -0.5], [rect.maxX, low, -0.5], [rect.maxX, high, -inner], [rect.minX, high, -inner]]);
  }
  if (terrainIsWater(ctx.s)) {
    addBank([[rect.maxX, low, 0.5], [rect.minX, low, 0.5], [rect.minX, high, inner], [rect.maxX, high, inner]]);
  }
  if (terrainIsWater(ctx.w)) {
    addBank([[-0.5, low, rect.maxZ], [-0.5, low, rect.minZ], [-inner, high, rect.minZ], [-inner, high, rect.maxZ]]);
  }
  if (terrainIsWater(ctx.e)) {
    addBank([[0.5, low, rect.minZ], [0.5, low, rect.maxZ], [inner, high, rect.maxZ], [inner, high, rect.minZ]]);
  }

  // -- OUTER corners (both adjacent cardinals are water) --
  // Single quad per corner, split along the low-to-low diagonal so we get
  // one flat sandbar triangle at water level + one smooth slope triangle.
  if (terrainIsWater(ctx.n) && terrainIsWater(ctx.w)) {
    addBank([[-inner, low, -0.5], [-0.5, low, -0.5], [-0.5, low, -inner], [-inner, high, -inner]]);
  } else if (terrainIsWater(ctx.nw) && !terrainIsWater(ctx.n) && !terrainIsWater(ctx.w)) {
    addBank([[-0.5, low, -0.5], [-0.5, high, -inner], [-inner, high, -inner], [-inner, high, -0.5]]);
  }

  if (terrainIsWater(ctx.n) && terrainIsWater(ctx.e)) {
    addBank([[0.5, low, -inner], [0.5, low, -0.5], [inner, low, -0.5], [inner, high, -inner]]);
  } else if (terrainIsWater(ctx.ne) && !terrainIsWater(ctx.n) && !terrainIsWater(ctx.e)) {
    addBank([[0.5, low, -0.5], [inner, high, -0.5], [inner, high, -inner], [0.5, high, -inner]]);
  }

  if (terrainIsWater(ctx.s) && terrainIsWater(ctx.w)) {
    addBank([[-0.5, low, inner], [-0.5, low, 0.5], [-inner, low, 0.5], [-inner, high, inner]]);
  } else if (terrainIsWater(ctx.sw) && !terrainIsWater(ctx.s) && !terrainIsWater(ctx.w)) {
    addBank([[-0.5, low, 0.5], [-inner, high, 0.5], [-inner, high, inner], [-0.5, high, inner]]);
  }

  if (terrainIsWater(ctx.s) && terrainIsWater(ctx.e)) {
    addBank([[inner, low, 0.5], [0.5, low, 0.5], [0.5, low, inner], [inner, high, inner]]);
  } else if (terrainIsWater(ctx.se) && !terrainIsWater(ctx.s) && !terrainIsWater(ctx.e)) {
    addBank([[0.5, low, 0.5], [0.5, high, inner], [inner, high, inner], [inner, high, 0.5]]);
  }
}

function addShorelineGrassPlateau(g: THREE.Group, gx: number, gy: number, ctx: TerrainNeighbors) {
  const inner = 0.5 - BEACH_INSET;
  const { minX, maxX, minZ, maxZ } = shorelineInteriorRect(ctx);
  
  const pts: [number, number][] = [];

  if (terrainIsWater(ctx.sw) && !terrainIsWater(ctx.s) && !terrainIsWater(ctx.w)) {
    pts.push([minX, inner], [-inner, inner], [-inner, maxZ]);
  } else {
    pts.push([minX, maxZ]);
  }

  if (terrainIsWater(ctx.se) && !terrainIsWater(ctx.s) && !terrainIsWater(ctx.e)) {
    pts.push([inner, maxZ], [inner, inner], [maxX, inner]);
  } else {
    pts.push([maxX, maxZ]);
  }

  if (terrainIsWater(ctx.ne) && !terrainIsWater(ctx.n) && !terrainIsWater(ctx.e)) {
    pts.push([maxX, -inner], [inner, -inner], [inner, minZ]);
  } else {
    pts.push([maxX, minZ]);
  }

  if (terrainIsWater(ctx.nw) && !terrainIsWater(ctx.n) && !terrainIsWater(ctx.w)) {
    pts.push([-inner, minZ], [-inner, -inner], [minX, -inner]);
  } else {
    pts.push([minX, minZ]);
  }

  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], -pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    shape.lineTo(pts[i][0], -pts[i][1]);
  }

  const geo = new THREE.ShapeGeometry(shape);
  const pos = geo.attributes.position;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const pz = -pos.getY(i);
    const u = (px - minX) / Math.max(0.001, maxX - minX);
    const v = (maxZ - pz) / Math.max(0.001, maxZ - minZ);
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

  const grass = new THREE.Mesh(geo, terrainTopMaterial('land', gx, gy, ctx));
  grass.rotation.x = -Math.PI / 2;
  grass.position.set(0, LAND_TOP + 0.004, 0);
  grass.receiveShadow = true;
  g.add(grass);
}

export function buildTerrainCell(terrain: TerrainType, gx: number, gy: number, ctx: TerrainNeighbors = {}): THREE.Group {
  const g = new THREE.Group();
  const r = hash01(gx, gy);
  if (terrain === 'deep' || terrain === 'reef') {
    const deep = terrain === 'deep';
    const h = WATER_TOP;
    const water = new THREE.Mesh(
      new THREE.BoxGeometry(1, h, 1),
      [
        mat(P.waterSide), mat(P.waterSide),
        terrainTopMaterial(terrain, gx, gy, ctx),
        mat(P.waterSide), mat(P.waterSide), mat(P.waterSide),
      ],
    );
    water.position.y = h / 2;
    water.receiveShadow = true;
    water.userData.water = { phase: r * Math.PI * 2 };
    g.add(water);
    void deep;
    return g;
  }

  const hasCardinalWater = hasWaterNeighbor(ctx);
  const hasInnerCorner = !hasCardinalWater && (
    (terrainIsWater(ctx.nw) && !terrainIsWater(ctx.n) && !terrainIsWater(ctx.w)) ||
    (terrainIsWater(ctx.ne) && !terrainIsWater(ctx.n) && !terrainIsWater(ctx.e)) ||
    (terrainIsWater(ctx.sw) && !terrainIsWater(ctx.s) && !terrainIsWater(ctx.w)) ||
    (terrainIsWater(ctx.se) && !terrainIsWater(ctx.s) && !terrainIsWater(ctx.e))
  );
  const shoreline = terrain === 'land' && (hasCardinalWater || hasInnerCorner);
  const slabTop = shoreline ? BEACH_TOP : LAND_TOP;
  // land slab: procedural top texture + dirt sides (rubble = permanently scorched ground)
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(1, slabTop, 1),
    [mat(P.dirt), mat(P.dirt), shoreline ? mat(P.sand) : terrainTopMaterial(terrain, gx, gy, ctx), mat(P.dirtDark), mat(P.dirtDark), mat(P.dirt)],
  );
  slab.position.y = slabTop / 2;
  setSh(slab);
  g.add(slab);
  if (shoreline) {
    addShorelineShelves(g, ctx);
    addShorelineGrassPlateau(g, gx, gy, ctx);
  }
  if (terrain === 'rubble') {
    // permanent wreck field — broken slabs and char
    const debris = 1 + Math.floor(hash01(gx, gy, 60) * 2);
    for (let k = 0; k < debris; k++) {
      const w = 0.1 + hash01(gx, gy, 61 + k) * 0.12;
      const db = box(w, 0.05 + hash01(gx, gy, 67 + k) * 0.06, w, k % 2 ? P.char : '#4a4036',
        (hash01(gx, gy, 71 + k) - 0.5) * 0.5, LAND_TOP + 0.04, (hash01(gx, gy, 73 + k) - 0.5) * 0.5);
      db.rotation.y = hash01(gx, gy, 79 + k) * Math.PI;
      g.add(db);
    }
    return g;
  }

  if (terrain === 'mountain') {
    const peakH = 0.54 + r * 0.34;
    const peakR = 0.36 + hash01(gx, gy, 671) * 0.12;
    const peak = new THREE.Mesh(new THREE.ConeGeometry(peakR, peakH, 5 + Math.floor(hash01(gx, gy, 672) * 2)), mat(hash01(gx, gy, 673) > 0.45 ? P.rock : '#7d8490'));
    peak.position.y = LAND_TOP + peakH / 2 - 0.03;
    peak.rotation.y = r * Math.PI;
    setSh(peak);
    g.add(peak);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(peakR * 0.42, 0.18 + hash01(gx, gy, 674) * 0.08, 5), mat(P.snow));
    cap.position.y = LAND_TOP + peakH - 0.14;
    cap.rotation.y = r * Math.PI;
    setSh(cap);
    g.add(cap);
    if (hash01(gx, gy, 675) > 0.45) {
      const shoulder = new THREE.Mesh(new THREE.ConeGeometry(0.18 + hash01(gx, gy, 676) * 0.08, 0.3 + hash01(gx, gy, 677) * 0.18, 5), mat(P.rockDark));
      shoulder.position.set((hash01(gx, gy, 678) - 0.5) * 0.42, LAND_TOP + 0.18, (hash01(gx, gy, 679) - 0.5) * 0.42);
      shoulder.rotation.y = hash01(gx, gy, 680) * Math.PI;
      setSh(shoulder);
      g.add(shoulder);
    }
    const boulder = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 0), mat(P.rockDark));
    boulder.position.set(0.3 - r * 0.2, LAND_TOP + 0.05, -0.28);
    setSh(boulder);
    g.add(boulder);
  } else if (terrain === 'irradiated') {
    const pts: number[] = [];
    const count = 10 + Math.floor(hash01(gx, gy, 681) * 8);
    for (let k = 0; k < count; k++) {
      const a = hash01(gx, gy, 690 + k) * Math.PI * 2;
      const d = 0.08 + hash01(gx, gy, 710 + k) * 0.34;
      pts.push(
        Math.cos(a) * d,
        LAND_TOP + 0.045 + hash01(gx, gy, 730 + k) * 0.16,
        Math.sin(a) * d,
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const material = new THREE.PointsMaterial({
      color: new THREE.Color(P.toxicGlow),
      size: 0.055,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const cloud = new THREE.Points(geo, material);
    cloud.userData.disposeMaterial = true;
    g.add(cloud);
    getAnim(g).radiation = [{ points: cloud, speed: 2.8, phase: r * Math.PI * 2 }];
  }
  return g;
}

// decorative trees/rocks for empty land cells
export function buildDecoration(gx: number, gy: number): THREE.Group | null {
  const r = hash01(gx, gy, 7);
  if (r > 0.24) return null;
  const g = new THREE.Group();
  const n = r < 0.08 ? 2 : 1;
  for (let k = 0; k < n; k++) {
    const rx = (hash01(gx, gy, 11 + k) - 0.5) * 0.5;
    const rz = (hash01(gx, gy, 23 + k) - 0.5) * 0.5;
    const kind = hash01(gx, gy, 31 + k);
    if (kind < 0.42) {
      const th = 0.14 + hash01(gx, gy, 41 + k) * 0.1;
      g.add(cyl(0.035, 0.05, th, P.trunk, rx, LAND_TOP + th / 2, rz, 5));
      const lh = 0.26 + hash01(gx, gy, 43 + k) * 0.18;
      g.add(cone(0.16 + hash01(gx, gy, 47 + k) * 0.06, lh, hash01(gx, gy, 53 + k) > 0.5 ? P.leaf : P.leafDark, rx, LAND_TOP + th + lh / 2 - 0.02, rz));
    } else if (kind < 0.72) {
      const th = 0.12 + hash01(gx, gy, 61 + k) * 0.08;
      g.add(cyl(0.035, 0.045, th, P.trunk, rx, LAND_TOP + th / 2, rz, 5));
      const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(0.14 + hash01(gx, gy, 63 + k) * 0.08, 1), mat(hash01(gx, gy, 65 + k) > 0.45 ? '#63bf58' : P.leaf));
      crown.position.set(rx, LAND_TOP + th + 0.08, rz);
      crown.scale.y = 0.72 + hash01(gx, gy, 67 + k) * 0.35;
      setSh(crown);
      g.add(crown);
      if (hash01(gx, gy, 69 + k) > 0.55) {
        const crown2 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09 + hash01(gx, gy, 70 + k) * 0.05, 0), mat(P.leafDark));
        crown2.position.set(rx + 0.08, LAND_TOP + th + 0.04, rz - 0.04);
        setSh(crown2);
        g.add(crown2);
      }
    } else {
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 0), mat(P.rockDark));
      rock.position.set(rx, LAND_TOP + 0.05, rz);
      setSh(rock);
      g.add(rock);
      if (hash01(gx, gy, 75 + k) > 0.45) {
        const rock2 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.05, 0), mat(P.rock));
        rock2.position.set(rx + 0.09, LAND_TOP + 0.035, rz - 0.04);
        setSh(rock2);
        g.add(rock2);
      }
    }
  }
  return g;
}

// ===================== BUILDINGS =====================
// Each footprint cell gets its own module so destroyed cells swap to ruins independently.
// Modules are built in LOCAL cell space (origin = cell center at land top, y up).

const PAD_H = 0.05;
function padBase(g: THREE.Group, color = '#3c424c') {
  const pad = box(0.94, PAD_H, 0.94, color, 0, PAD_H / 2, 0);
  pad.castShadow = false;
  g.add(pad);
}
function buildingFloorColor(type: BuildingType) {
  switch (type) {
    case 'base':
      return '#303a45';
    case 'powerplant':
      return '#29323a';
    case 'silo':
      return '#2d333d';
    case 'napalm':
      return '#33291e';
    case 'artillery':
      return '#3c3b32';
    case 'research':
      return '#263748';
    case 'nuclear':
      return '#30363c';
    case 'radar':
      return '#28313a';
    case 'sonar':
      return '#1d4152';
    case 'shield':
      return '#223342';
    case 'turret':
      return '#2c333b';
    case 'repair':
      return '#34312b';
    case 'jammer':
      return '#2c2440';
    default:
      return '#303a45';
  }
}
export function buildBuildingFootprintBase(type: BuildingType, w: number, h: number): THREE.Group {
  const g = new THREE.Group();
  const cx = (w - 1) / 2;
  const cz = (h - 1) / 2;
  const pad = box(Math.max(0.94, w - 0.06), PAD_H, Math.max(0.94, h - 0.06), '#3c424c', cx, PAD_H / 2, cz);
  pad.castShadow = false;
  g.add(pad);
  const floor = box(Math.max(0.76, w - 0.22), 0.025, Math.max(0.76, h - 0.22), buildingFloorColor(type), cx, PAD_H + 0.012, cz);
  floor.castShadow = false;
  g.add(floor);
  return g;
}
function windows(g: THREE.Group, x: number, y: number, z: number, n: number, dx: number, lit = '#ffd35a') {
  for (let i = 0; i < n; i++) g.add(box(0.05, 0.07, 0.02, lit, x + i * dx, y, z, lit));
}
function sideWindows(g: THREE.Group, x: number, y: number, z: number, n: number, dz: number, lit = '#ffd35a') {
  for (let i = 0; i < n; i++) g.add(box(0.02, 0.07, 0.05, lit, x, y, z + i * dz, lit));
}
function insetPad(g: THREE.Group, color: string = P.concreteDark, w = 0.76, d = 0.76) {
  const fp = g.userData.footprint as { w: number; h: number; cellIdx: number } | undefined;
  if (fp) {
    if (fp.cellIdx !== 0) return;
    const p = box(Math.max(w, fp.w - (1 - w)), 0.025, Math.max(d, fp.h - (1 - d)), color, (fp.w - 1) / 2, PAD_H + 0.017, (fp.h - 1) / 2);
    p.castShadow = false;
    g.add(p);
    return;
  }
  const p = box(w, 0.025, d, color, 0, PAD_H + 0.012, 0);
  p.castShadow = false;
  g.add(p);
}
function deckEdge(g: THREE.Group, color: string = P.steelDark, y = PAD_H + 0.09) {
  g.add(box(0.78, 0.035, 0.035, color, 0, y, -0.39));
  g.add(box(0.78, 0.035, 0.035, color, 0, y, 0.39));
  g.add(box(0.035, 0.035, 0.78, color, -0.39, y, 0));
  g.add(box(0.035, 0.035, 0.78, color, 0.39, y, 0));
}
function cornerPosts(g: THREE.Group, color: string = P.steelDark, h = 0.28, inset = 0.36) {
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.add(cyl(0.015, 0.018, h, color, sx * inset, PAD_H + h / 2, sz * inset, 4));
    }
  }
}
function warningStripe(g: THREE.Group, z = -0.36) {
  const stripeA = box(0.34, 0.018, 0.045, P.warnYellow, -0.12, PAD_H + 0.07, z, P.warnYellow);
  stripeA.rotation.y = 0.28;
  const stripeB = box(0.34, 0.018, 0.045, '#222831', 0.14, PAD_H + 0.071, z);
  stripeB.rotation.y = 0.28;
  g.add(stripeA, stripeB);
}
function tinyAntenna(g: THREE.Group, x: number, z: number, h = 0.38, color: string = P.steel) {
  const mast = cyl(0.01, 0.014, h, color, x, PAD_H + h / 2 + 0.02, z, 4);
  g.add(mast);
  const tip = box(0.035, 0.035, 0.035, '#ff4a4a', x, PAD_H + h + 0.045, z, '#ff3030');
  g.add(tip);
  return tip;
}

// RUIN: per-tile destroyed counterpart (seeded variety)
export function buildRuin(gx: number, gy: number): THREE.Group {
  const g = new THREE.Group();
  padBase(g, P.charDark);
  const scorch = new THREE.Mesh(new THREE.CircleGeometry(0.46, 8), mat(P.char));
  scorch.rotation.x = -Math.PI / 2;
  scorch.position.y = PAD_H + 0.005;
  scorch.receiveShadow = true;
  g.add(scorch);
  const n = 3 + Math.floor(hash01(gx, gy, 3) * 3);
  for (let k = 0; k < n; k++) {
    const w = 0.1 + hash01(gx, gy, 5 + k) * 0.16;
    const h = 0.06 + hash01(gx, gy, 7 + k) * 0.14;
    const b = box(w, h, w * (0.7 + hash01(gx, gy, 11 + k) * 0.6), hash01(gx, gy, 13 + k) > 0.4 ? P.char : '#3a322a',
      (hash01(gx, gy, 17 + k) - 0.5) * 0.55, PAD_H + h / 2, (hash01(gx, gy, 19 + k) - 0.5) * 0.55);
    b.rotation.y = hash01(gx, gy, 23 + k) * Math.PI;
    g.add(b);
  }
  // broken wall corner
  const wall = box(0.3, 0.22, 0.05, '#46413a', 0.2, PAD_H + 0.11, -0.22);
  wall.rotation.y = hash01(gx, gy, 29) * 0.6;
  g.add(wall);
  // rebar
  for (let k = 0; k < 2; k++) {
    const reb = cyl(0.012, 0.012, 0.3, '#222', -0.15 + k * 0.18, PAD_H + 0.15, 0.15, 4);
    reb.rotation.z = 0.4 + hash01(gx, gy, 31 + k) * 0.5;
    g.add(reb);
  }
  getAnim(g).smoke = [new THREE.Vector3(0, 0.25, 0)];
  return g;
}

// cellIdx = index into footprint (row-major over rotated w×h)
export function buildBuildingCellModule(
  type: BuildingType,
  cellIdx: number,
  w: number,
  h: number,
  color: string,
): THREE.Group {
  const g = new THREE.Group();
  g.userData.footprint = { w, h, cellIdx };
  const Y = PAD_H;
  const cx = cellIdx % w;
  const cy = Math.floor(cellIdx / w);
  const first = cellIdx === 0;
  const a = getAnim(g);

  switch (type) {
    case 'base': {
      insetPad(g, '#303a45');
      if (cellIdx === 0) {
        // stepped command tower + team flag
        g.add(box(0.58, 0.24, 0.58, P.concrete, 0, Y + 0.13, 0));
        g.add(box(0.48, 0.09, 0.48, P.concreteDark, 0, Y + 0.29, 0));
        g.add(box(0.38, 0.24, 0.38, P.concrete, 0, Y + 0.44, 0));
        g.add(cyl(0.22, 0.24, 0.08, P.steelDark, 0, Y + 0.6, 0, 8));
        g.add(box(0.2, 0.16, 0.2, '#d7e2ed', 0, Y + 0.71, 0));
        g.add(cone(0.16, 0.16, color, 0, Y + 0.87, 0, 4));
        windows(g, -0.12, Y + 0.45, 0.2, 3, 0.12);
        sideWindows(g, 0.2, Y + 0.45, -0.1, 2, 0.13);
        const pole = cyl(0.015, 0.015, 0.62, P.hull, 0.18, Y + 0.77, 0.16, 5);
        g.add(pole);
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.15), mat(color, { opacity: 0.95 }));
        flag.position.set(0.32, Y + 1.06, 0.16);
        flag.material.side = THREE.DoubleSide;
        g.add(flag);
        a.sway = [{ obj: flag, axis: 'y', amp: 0.25, speed: 4 }];
      } else if (cellIdx === 1) {
        // barracks with gable roof and porch
        g.add(box(0.68, 0.23, 0.5, P.concrete, 0, Y + 0.125, 0));
        const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.72, 3), mat(P.roofRed));
        roof.rotation.z = Math.PI / 2;
        roof.rotation.x = Math.PI;
        roof.position.set(0, Y + 0.31, 0);
        setSh(roof);
        g.add(roof);
        windows(g, -0.2, Y + 0.12, 0.26, 4, 0.13);
        g.add(box(0.54, 0.035, 0.13, P.steelDark, 0, Y + 0.09, -0.32));
        for (let k = 0; k < 3; k++) g.add(cyl(0.01, 0.012, 0.2, P.steelDark, -0.22 + k * 0.22, Y + 0.17, -0.34, 4));
      } else if (cellIdx === 2) {
        // comms hut + antenna cluster
        g.add(box(0.46, 0.24, 0.42, '#495464', -0.08, Y + 0.13, 0.04));
        g.add(box(0.5, 0.055, 0.46, P.steel, -0.08, Y + 0.28, 0.04));
        windows(g, -0.22, Y + 0.15, 0.26, 2, 0.14, '#9fdcff');
        const mast = cyl(0.012, 0.018, 0.52, P.steel, 0.22, Y + 0.46, -0.15, 5);
        g.add(mast);
        for (let k = 0; k < 3; k++) {
          const arm = box(0.2 - k * 0.035, 0.018, 0.018, P.steel, 0.22, Y + 0.62 - k * 0.08, -0.15);
          arm.rotation.y = k % 2 ? Math.PI / 2 : 0;
          g.add(arm);
        }
        const light = box(0.04, 0.04, 0.04, '#ff4444', 0.22, Y + 0.74, -0.15, '#ff2222');
        g.add(light);
        a.blink = [{ mesh: light, speed: 3 }];
      } else {
        // depot: crates + helipad target
        const padc = new THREE.Mesh(new THREE.CircleGeometry(0.3, 12), mat(P.concreteDark));
        padc.rotation.x = -Math.PI / 2;
        padc.position.y = Y + 0.006;
        g.add(padc);
        g.add(box(0.42, 0.025, 0.055, P.hull, 0, Y + 0.018, 0));
        g.add(box(0.055, 0.025, 0.42, P.hull, 0, Y + 0.019, 0));
        g.add(box(0.16, 0.14, 0.16, '#8a6a3a', -0.18, Y + 0.09, 0.16));
        g.add(box(0.13, 0.11, 0.13, '#9a7a46', 0.02, Y + 0.075, 0.22));
        g.add(box(0.2, 0.1, 0.13, P.steelDark, 0.18, Y + 0.07, -0.18));
        g.add(cyl(0.045, 0.045, 0.18, '#b33d35', -0.28, Y + 0.09, -0.22, 7));
      }
      break;
    }
    case 'powerplant': {
      insetPad(g, '#29323a');
      if (cellIdx === 0) {
        g.add(box(0.68, 0.34, 0.58, P.steelDark, 0, Y + 0.18, 0));
        const roofv = box(0.7, 0.05, 0.6, P.steel, 0, Y + 0.38, 0);
        g.add(roofv);
        for (let k = 0; k < 3; k++) g.add(box(0.08, 0.04, 0.42, '#44505d', -0.22 + k * 0.22, Y + 0.43, 0));
        windows(g, -0.2, Y + 0.2, 0.31, 4, 0.13);
        sideWindows(g, 0.35, Y + 0.2, -0.14, 3, 0.14, '#ffd35a');
      } else if (cellIdx === 1) {
        // Concrete foundation base
        g.add(box(0.5, 0.08, 0.5, P.concreteDark, 0, Y + 0.04, 0));
        // Four corner steel support legs
        g.add(cyl(0.015, 0.015, 0.2, P.steelDark, -0.18, Y + 0.14, -0.18, 4));
        g.add(cyl(0.015, 0.015, 0.2, P.steelDark, 0.18, Y + 0.14, -0.18, 4));
        g.add(cyl(0.015, 0.015, 0.2, P.steelDark, -0.18, Y + 0.14, 0.18, 4));
        g.add(cyl(0.015, 0.015, 0.2, P.steelDark, 0.18, Y + 0.14, 0.18, 4));

        // Central pylon mast (rotated 45 degrees for lattice structural feel)
        const mast = cyl(0.03, 0.02, 0.72, P.steel, 0, Y + 0.4, 0, 4);
        mast.rotation.y = Math.PI / 4;
        g.add(mast);

        // Lower wide crossarm
        const armLow = box(0.55, 0.022, 0.022, P.steel, 0, Y + 0.52, 0);
        g.add(armLow);

        // Upper narrow crossarm
        const armHigh = box(0.38, 0.022, 0.022, P.steel, 0, Y + 0.7, 0);
        g.add(armHigh);

        // Glass insulator disks hanging off the arms
        g.add(cyl(0.025, 0.025, 0.08, '#7fd0ff', -0.24, Y + 0.46, 0, 4));
        g.add(cyl(0.025, 0.025, 0.08, '#7fd0ff', 0.24, Y + 0.46, 0, 4));
        g.add(cyl(0.025, 0.025, 0.08, '#7fd0ff', -0.16, Y + 0.64, 0, 4));
        g.add(cyl(0.025, 0.025, 0.08, '#7fd0ff', 0.16, Y + 0.64, 0, 4));

        // Warning beacon at the peak
        const beacon = cyl(0.025, 0.025, 0.06, '#ff5a5a', 0, Y + 0.79, 0, 4);
        g.add(beacon);
        a.blink = [{ mesh: beacon, speed: 4.5 }];
      } else {
        // transformer yard
        deckEdge(g, P.steelDark, Y + 0.08);
        g.add(box(0.55, 0.06, 0.5, P.concreteDark, 0, Y + 0.04, 0));
        for (let k = 0; k < 3; k++) g.add(cyl(0.055, 0.065, 0.24, P.steel, -0.18 + k * 0.18, Y + 0.18, 0, 8));
        g.add(box(0.42, 0.04, 0.04, P.warnYellow, 0, Y + 0.32, 0, P.warnYellow));
        const cable = box(0.56, 0.025, 0.025, P.steelDark, 0, Y + 0.25, -0.22);
        cable.rotation.y = 0.24;
        g.add(cable);
        const bolt = box(0.06, 0.12, 0.02, P.warnYellow, 0.25, Y + 0.22, 0.22, P.warnYellow);
        g.add(bolt);
        a.blink = [{ mesh: bolt, speed: 5 }];
      }
      break;
    }
    case 'silo': {
      insetPad(g, '#2d333d');
      const ring = cyl(0.34, 0.38, 0.12, P.concreteDark, 0, Y + 0.06, 0, 10);
      g.add(ring);
      g.add(cyl(0.24, 0.26, 0.06, '#151b22', 0, Y + 0.14, 0, 10));
      const hatchL = box(0.3, 0.03, 0.6, P.steelDark, -0.18, Y + 0.13, 0);
      hatchL.rotation.z = 0.5;
      g.add(hatchL);
      const hatchR = box(0.24, 0.028, 0.52, P.steel, 0.24, Y + 0.12, 0);
      hatchR.rotation.z = -0.35;
      g.add(hatchR);
      g.add(cyl(0.09, 0.09, 0.42, P.hull, 0.04, Y + 0.3, 0, 8));
      g.add(cone(0.09, 0.16, '#d04a42', 0.04, Y + 0.58, 0, 8));
      for (let k = 0; k < 4; k++) {
        const an = (k / 4) * Math.PI * 2 + Math.PI / 4;
        g.add(box(0.055, 0.025, 0.055, P.warnYellow, Math.cos(an) * 0.36, Y + 0.08, Math.sin(an) * 0.36, P.warnYellow));
      }
      const lamp = box(0.04, 0.04, 0.04, '#ff5a5a', 0.34, Y + 0.13, 0.34, '#ff3a3a');
      g.add(lamp);
      a.blink = [{ mesh: lamp, speed: 4 }];
      break;
    }
    case 'napalm': {
      insetPad(g, '#33291e');
      if (cellIdx === 0) {
        // fuel drums
        deckEdge(g, '#5a3420', Y + 0.09);
        for (let k = 0; k < 5; k++) {
          const dr = cyl(0.075, 0.075, 0.24, k % 2 ? '#d06a2a' : '#b5642e', -0.24 + (k % 3) * 0.2, Y + 0.13, Math.floor(k / 3) * 0.18 - 0.08, 8);
          g.add(dr);
          g.add(cyl(0.08, 0.08, 0.025, '#7a3f1c', -0.24 + (k % 3) * 0.2, Y + 0.26, Math.floor(k / 3) * 0.18 - 0.08, 8));
        }
        const pipe = cyl(0.018, 0.018, 0.64, '#4d2b18', 0, Y + 0.22, -0.28, 6);
        pipe.rotation.z = Math.PI / 2;
        g.add(pipe);
        warningStripe(g, 0.34);
      } else {
        // incendiary launcher rack
        g.add(box(0.56, 0.1, 0.42, P.steelDark, 0, Y + 0.06, 0));
        const rack = new THREE.Group();
        for (let k = 0; k < 4; k++) {
          const t = cyl(0.042, 0.05, 0.46, k % 2 ? '#db7332' : P.steel, -0.18 + k * 0.12, 0.22, 0, 6);
          t.rotation.x = -0.75;
          rack.add(t);
        }
        rack.position.y = Y;
        g.add(rack);
        for (let k = 0; k < 2; k++) {
          const skid = box(0.08, 0.08, 0.46, '#222831', -0.24 + k * 0.48, Y + 0.12, 0);
          g.add(skid);
        }
        const pilot = box(0.05, 0.05, 0.05, P.fire, 0.2, Y + 0.4, -0.12, P.fire);
        g.add(pilot);
        a.flame = [new THREE.Vector3(0.2, Y + 0.4, -0.12)];
      }
      break;
    }
    case 'artillery': {
      insetPad(g, '#3c3b32');
      if (cellIdx === 0) {
        // gun platform
        for (let k = 0; k < 8; k++) {
          const an = (k / 8) * Math.PI * 2;
          const bag = box(0.15, 0.075, 0.08, '#b8a06a', Math.cos(an) * 0.36, Y + 0.07, Math.sin(an) * 0.36);
          bag.rotation.y = an;
          g.add(bag);
        }
        g.add(cyl(0.3, 0.34, 0.1, P.steelDark, 0, Y + 0.1, 0, 10));
        const mount = box(0.26, 0.16, 0.26, P.steel, 0, Y + 0.23, 0);
        g.add(mount);
        const barrelG = new THREE.Group();
        const barrel = cyl(0.045, 0.06, 0.74, P.steelDark, 0, 0.37, 0, 8);
        barrelG.add(barrel);
        const muzzle = cyl(0.058, 0.058, 0.08, '#20252c', 0, 0.75, 0, 8);
        barrelG.add(muzzle);
        barrelG.position.set(0, Y + 0.29, 0);
        barrelG.rotation.z = -1.05;
        g.add(barrelG);
        a.sway = [{ obj: barrelG, axis: 'z', amp: 0.05, speed: 1.4, base: -1.05 }];
      } else if (cellIdx === 1) {
        // shell crates and stacked rounds
        for (let k = 0; k < 3; k++) g.add(box(0.14, 0.1, 0.3, '#6a5a3a', -0.18 + k * 0.18, Y + 0.08, 0.05));
        for (let k = 0; k < 4; k++) {
          const shell = cone(0.045, 0.18, '#c9b25a', -0.24 + k * 0.12, Y + 0.2, -0.23, 5);
          shell.rotation.z = k % 2 ? 0.1 : -0.08;
          g.add(shell);
        }
        g.add(box(0.48, 0.04, 0.05, P.steelDark, 0, Y + 0.18, 0.27));
      } else if (cellIdx === 2) {
        g.add(box(0.54, 0.2, 0.42, P.concreteDark, 0, Y + 0.12, 0));
        g.add(box(0.58, 0.05, 0.46, P.concrete, 0, Y + 0.245, 0));
        windows(g, -0.18, Y + 0.14, 0.22, 3, 0.18, '#ffcf4d');
        const mapGlow = box(0.12, 0.018, 0.16, '#52e0a0', 0.18, Y + 0.28, -0.1, '#2ec07f');
        g.add(mapGlow);
        a.blink = [{ mesh: mapGlow, speed: 2.3 }];
      } else {
        // spare carriage and earthworks
        for (let k = 0; k < 7; k++) {
          const an = (k / 7) * Math.PI * 2;
          const bag = box(0.14, 0.08, 0.08, '#b8a06a', Math.cos(an) * 0.3, Y + 0.07, Math.sin(an) * 0.3);
          bag.rotation.y = an;
          g.add(bag);
        }
        g.add(box(0.46, 0.08, 0.16, P.steelDark, 0, Y + 0.1, -0.06));
        for (let k = 0; k < 2; k++) g.add(cyl(0.07, 0.07, 0.06, '#222831', -0.16 + k * 0.32, Y + 0.07, 0.08, 8));
      }
      break;
    }
    case 'research': {
      insetPad(g, '#263748');
      if (cellIdx === 0) {
        g.add(cyl(0.32, 0.34, 0.1, P.concrete, 0, Y + 0.06, 0, 12));
        g.add(dome(0.31, '#bfe0f0', 0, Y + 0.11, 0, 0.88));
        const rib1 = box(0.58, 0.018, 0.028, P.hull, 0, Y + 0.25, 0);
        const rib2 = box(0.028, 0.018, 0.58, P.hull, 0, Y + 0.252, 0);
        g.add(rib1, rib2);
        const sample = new THREE.Mesh(new THREE.OctahedronGeometry(0.08, 0), mat('#8aff4a', { emissive: '#66d830' }));
        sample.position.set(-0.22, Y + 0.12, -0.24);
        g.add(sample);
        a.spin = [{ obj: sample, axis: 'y', speed: 1.2 }];
      } else {
        g.add(box(0.58, 0.26, 0.46, '#3a6886', 0, Y + 0.14, 0));
        g.add(box(0.62, 0.045, 0.5, '#274a62', 0, Y + 0.3, 0));
        windows(g, -0.14, Y + 0.16, 0.24, 3, 0.14, '#9fe8ff');
        sideWindows(g, -0.3, Y + 0.16, -0.12, 2, 0.16, '#9fe8ff');
        const dishG = new THREE.Group();
        const dish = cyl(0.16, 0.025, 0.06, P.hull, 0, 0.03, 0, 8);
        dishG.add(dish);
        dishG.add(cyl(0.012, 0.012, 0.18, P.steelDark, 0, -0.06, 0.06, 4));
        dishG.position.set(0.12, Y + 0.34, -0.1);
        dishG.rotation.z = -0.6;
        g.add(dishG);
        tinyAntenna(g, -0.22, -0.16, 0.26, P.steel);
        a.spin = [{ obj: dishG, axis: 'y', speed: 0.8 }];
      }
      break;
    }
    case 'nuclear': {
      insetPad(g, '#30363c');
      if (cellIdx === 0) {
        g.add(cyl(0.38, 0.4, 0.08, P.concreteDark, 0, Y + 0.05, 0, 12));
        g.add(dome(0.35, P.concrete, 0, Y + 0.08, 0));
        for (let k = 0; k < 6; k++) {
          const an = (k / 6) * Math.PI * 2;
          g.add(box(0.045, 0.07, 0.08, P.warnYellow, Math.cos(an) * 0.34, Y + 0.13, Math.sin(an) * 0.34, P.warnYellow));
        }
      } else if (cellIdx === 1) {
        const tower = cyl(0.2, 0.3, 0.72, P.concrete, 0, Y + 0.36, 0, 10);
        g.add(tower);
        g.add(cyl(0.16, 0.22, 0.08, P.concreteDark, 0, Y + 0.74, 0, 10));
        const pipe = cyl(0.022, 0.022, 0.52, P.steel, -0.3, Y + 0.28, 0.12, 6);
        pipe.rotation.x = Math.PI / 2;
        g.add(pipe);
        a.smoke = [new THREE.Vector3(0, Y + 0.81, 0)];
      } else if (cellIdx === 2) {
        g.add(box(0.58, 0.31, 0.5, P.steelDark, 0, Y + 0.16, 0));
        g.add(box(0.62, 0.05, 0.54, P.steel, 0, Y + 0.34, 0));
        windows(g, -0.15, Y + 0.2, 0.26, 3, 0.15);
        sideWindows(g, -0.3, Y + 0.19, -0.12, 2, 0.16);
        const warn = box(0.06, 0.06, 0.06, '#ff3b3b', 0.22, Y + 0.42, 0.18, '#ff2020');
        g.add(warn);
        a.blink = [{ mesh: warn, speed: 6 }];
      } else if (cellIdx === 3) {
        g.add(dome(0.24, P.concreteDark, 0, Y + 0.07, 0));
        g.add(cyl(0.25, 0.27, 0.05, '#1e242a', 0, Y + 0.045, 0, 10));
        warningStripe(g, -0.32);
      } else if (cellIdx === 4) {
        deckEdge(g, P.steelDark, Y + 0.08);
        g.add(box(0.54, 0.06, 0.5, P.concreteDark, 0, Y + 0.04, 0));
        for (let k = 0; k < 3; k++) g.add(cyl(0.052, 0.06, 0.2, P.steel, -0.18 + k * 0.18, Y + 0.16, 0.05, 8));
        g.add(box(0.46, 0.05, 0.05, P.warnYellow, 0, Y + 0.12, -0.2, P.warnYellow));
        g.add(box(0.08, 0.08, 0.08, '#8aff4a', 0.22, Y + 0.12, 0.22, '#66d830'));
      } else {
        g.add(cyl(0.28, 0.32, 0.1, P.steelDark, 0, Y + 0.06, 0, 10));
        g.add(cyl(0.13, 0.13, 0.36, P.hull, 0, Y + 0.27, 0, 8));
        g.add(cone(0.13, 0.18, '#3c4350', 0, Y + 0.54, 0, 8));
        for (let k = 0; k < 4; k++) {
          const an = (k / 4) * Math.PI * 2 + 0.4;
          const fin = box(0.1, 0.035, 0.05, P.warnYellow, Math.cos(an) * 0.18, Y + 0.13, Math.sin(an) * 0.18);
          fin.rotation.y = an;
          g.add(fin);
        }
      }
      break;
    }
    case 'radar': {
      insetPad(g, '#28313a');
      if (cellIdx === 0) {
        const mast = cyl(0.045, 0.07, 0.48, P.steel, 0, Y + 0.24, 0, 6);
        g.add(mast);
        const dishG = new THREE.Group();
        const bowl = cyl(0.34, 0.04, 0.13, P.hull, 0, 0.06, 0, 10);
        bowl.rotation.x = 0.9;
        dishG.add(bowl);
        const rim = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.012, 6, 14), mat(P.steelDark));
        rim.rotation.x = Math.PI / 2 + 0.9;
        rim.position.set(0, 0.11, 0.09);
        setSh(rim as THREE.Mesh);
        dishG.add(rim);
        const stick = cyl(0.01, 0.01, 0.24, P.steelDark, 0, 0.14, 0.12, 4);
        stick.rotation.x = 0.9;
        dishG.add(stick);
        dishG.position.set(0, Y + 0.52, 0);
        g.add(dishG);
        a.spin = [{ obj: dishG, axis: 'y', speed: 1.4 }];
      } else if (cellIdx === 1) {
        g.add(box(0.58, 0.23, 0.42, '#4a5564', 0, Y + 0.12, 0));
        g.add(box(0.62, 0.05, 0.46, '#303a45', 0, Y + 0.27, 0));
        windows(g, -0.14, Y + 0.13, 0.21, 3, 0.14, '#9fe8a0');
        sideWindows(g, 0.3, Y + 0.13, -0.12, 2, 0.16, '#9fe8a0');
        const dish = cyl(0.08, 0.02, 0.04, P.hull, -0.22, Y + 0.34, -0.13, 8);
        dish.rotation.x = 0.8;
        g.add(dish);
      } else if (cellIdx === 2) {
        // lattice tower
        cornerPosts(g, P.steelDark, 0.56, 0.2);
        for (let k = 0; k < 3; k++) {
          const brace = box(0.34, 0.025, 0.025, P.steelDark, 0, Y + 0.18 + k * 0.13, 0);
          brace.rotation.y = k % 2 ? Math.PI / 4 : -Math.PI / 4;
          g.add(brace);
        }
        g.add(box(0.3, 0.04, 0.3, P.steelDark, 0, Y + 0.58, 0));
        const lt = box(0.05, 0.05, 0.05, '#52e0a0', 0, Y + 0.65, 0, '#2ec07f');
        g.add(lt);
        a.blink = [{ mesh: lt, speed: 2.5 }];
      } else {
        g.add(box(0.42, 0.18, 0.32, P.steelDark, 0, Y + 0.1, 0.05));
        g.add(cyl(0.05, 0.05, 0.12, P.steel, 0.18, Y + 0.06, -0.18, 6));
        g.add(box(0.18, 0.08, 0.12, '#26313c', -0.18, Y + 0.07, -0.2));
        warningStripe(g, 0.32);
      }
      break;
    }
    case 'sonar': {
      insetPad(g, '#1d4152');
      if (cellIdx === 0) {
        const pool = cyl(0.34, 0.36, 0.08, '#1f5f7f', 0, Y + 0.05, 0, 12);
        g.add(pool);
        const water = new THREE.Mesh(new THREE.CircleGeometry(0.3, 14), mat(P.waterShallow, { opacity: 0.86, emissive: '#1a7895' }));
        water.rotation.x = -Math.PI / 2;
        water.position.y = Y + 0.096;
        g.add(water);
        const buoy = cyl(0.08, 0.1, 0.16, P.warnYellow, 0, Y + 0.17, 0, 8);
        g.add(buoy);
        for (let k = 0; k < 3; k++) {
          const an = (k / 3) * Math.PI * 2;
          g.add(cyl(0.025, 0.025, 0.08, '#ff5a5a', Math.cos(an) * 0.22, Y + 0.12, Math.sin(an) * 0.22, 6));
        }
        const ping = box(0.04, 0.04, 0.04, '#3fb6ff', 0, Y + 0.3, 0, '#3fb6ff');
        g.add(ping);
        a.blink = [{ mesh: ping, speed: 2 }];
      } else {
        g.add(box(0.54, 0.24, 0.42, '#2a5872', 0, Y + 0.13, 0));
        g.add(box(0.58, 0.04, 0.46, '#1a3b4f', 0, Y + 0.27, 0));
        g.add(cyl(0.012, 0.012, 0.34, P.steel, 0.18, Y + 0.42, 0.1, 4));
        windows(g, -0.16, Y + 0.15, 0.22, 3, 0.14, '#9fdcff');
        const cable = cyl(0.012, 0.012, 0.46, '#0d2433', -0.18, Y + 0.1, -0.25, 5);
        cable.rotation.z = Math.PI / 2;
        g.add(cable);
      }
      break;
    }
    case 'shield': {
      insetPad(g, '#223342');
      if (cellIdx === 0) {
        // emitter pylon
        g.add(cyl(0.14, 0.2, 0.16, P.steelDark, 0, Y + 0.08, 0, 8));
        g.add(cyl(0.08, 0.14, 0.42, P.steel, 0, Y + 0.29, 0, 6));
        for (let k = 0; k < 4; k++) {
          const an = (k / 4) * Math.PI * 2;
          const vane = box(0.08, 0.025, 0.18, '#7fd0ff', Math.cos(an) * 0.16, Y + 0.38, Math.sin(an) * 0.16, '#2f80c0');
          vane.rotation.y = an;
          g.add(vane);
        }
        const orb = new THREE.Mesh(new THREE.OctahedronGeometry(0.14, 0), mat('#7fd0ff', { emissive: '#3fa0e0' }));
        orb.position.set(0, Y + 0.58, 0);
        g.add(orb);
        getAnim(g).spin = [{ obj: orb, axis: 'y', speed: 2 }];
      } else {
        deckEdge(g, '#2f6f9f', Y + 0.08);
        const coil = cyl(0.1, 0.12, 0.26, P.steelDark, 0, Y + 0.14, 0, 8);
        g.add(coil);
        g.add(cyl(0.13, 0.13, 0.03, '#7fd0ff', 0, Y + 0.29, 0, 8, '#2f80c0'));
        for (let k = 0; k < 3; k++) {
          const cell = box(0.12, 0.08, 0.16, '#253342', -0.22 + k * 0.22, Y + 0.08, -0.22);
          g.add(cell);
          g.add(box(0.08, 0.02, 0.12, '#7fd0ff', -0.22 + k * 0.22, Y + 0.135, -0.22, '#2f80c0'));
        }
      }
      break;
    }
    case 'turret': {
      insetPad(g, '#2c333b');
      g.add(cyl(0.26, 0.3, 0.1, P.steelDark, 0, Y + 0.06, 0, 8));
      for (let k = 0; k < 4; k++) {
        const an = (k / 4) * Math.PI * 2 + Math.PI / 4;
        const bag = box(0.13, 0.065, 0.08, '#b8a06a', Math.cos(an) * 0.34, Y + 0.065, Math.sin(an) * 0.34);
        bag.rotation.y = an;
        g.add(bag);
      }
      const head = new THREE.Group();
      head.add(box(0.22, 0.14, 0.22, P.steel, 0, 0.08, 0));
      head.add(box(0.15, 0.06, 0.18, '#303a45', 0, 0.16, -0.02));
      const b1 = cyl(0.024, 0.028, 0.38, P.steelDark, -0.055, 0.2, 0.14, 6);
      b1.rotation.x = -1.05;
      const b2 = b1.clone();
      b2.position.x = 0.055;
      head.add(b1, b2);
      const sight = box(0.04, 0.04, 0.04, '#52e0a0', 0.09, 0.18, 0.04, '#2ec07f');
      head.add(sight);
      head.position.set(0, Y + 0.12, 0);
      g.add(head);
      a.sway = [{ obj: head, axis: 'y', amp: 0.55, speed: 0.8 }];
      a.blink = [{ mesh: sight, speed: 3.3 }];
      break;
    }
    case 'repair': {
      insetPad(g, '#34312b');
      if (cellIdx === 0) {
        g.add(box(0.62, 0.26, 0.5, '#6a5f3a', 0, Y + 0.14, 0));
        const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.62, 3), mat('#8a7a4a'));
        roof.rotation.z = Math.PI / 2;
        roof.position.set(0, Y + 0.34, 0);
        setSh(roof);
        g.add(roof);
        windows(g, -0.18, Y + 0.16, 0.26, 3, 0.16, '#ffd35a');
        g.add(box(0.16, 0.16, 0.035, '#52e0a0', 0.24, Y + 0.18, 0.26, '#2ec07f'));
        g.add(box(0.035, 0.16, 0.16, '#52e0a0', 0.24, Y + 0.18, 0.26, '#2ec07f'));
      } else {
        const craneG = new THREE.Group();
        craneG.add(cyl(0.04, 0.05, 0.44, P.warnYellow, 0, 0.22, 0, 6));
        const arm = box(0.56, 0.045, 0.045, P.warnYellow, 0.26, 0.46, 0);
        craneG.add(arm);
        craneG.add(cyl(0.01, 0.01, 0.18, '#444', 0.48, 0.35, 0, 4));
        craneG.add(box(0.07, 0.06, 0.07, P.steelDark, 0.48, 0.24, 0));
        g.add(craneG);
        craneG.position.set(-0.05, Y, 0);
        a.spin = [{ obj: craneG, axis: 'y', speed: 0.35 }];
        g.add(box(0.2, 0.08, 0.25, P.steelDark, 0.25, Y + 0.06, 0.25));
        g.add(box(0.48, 0.025, 0.07, '#20252c', -0.03, Y + 0.07, -0.32));
        for (let k = 0; k < 2; k++) g.add(cyl(0.04, 0.04, 0.05, '#111820', -0.22 + k * 0.38, Y + 0.06, -0.32, 8));
      }
      break;
    }
    case 'jammer': {
      insetPad(g, '#2c2440');
      g.add(cyl(0.14, 0.18, 0.1, '#40345a', 0, Y + 0.06, 0, 7));
      g.add(cyl(0.06, 0.1, 0.48, '#5a4a78', 0, Y + 0.29, 0, 6));
      for (let k = 0; k < 3; k++) {
        const relay = box(0.1, 0.09, 0.16, '#3b304f', -0.22 + k * 0.22, Y + 0.08, -0.24);
        g.add(relay);
      }
      for (let k = 0; k < 3; k++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1 + k * 0.05, 0.012, 6, 12), mat('#d36bff', { emissive: '#9a3fd0', opacity: 0.8 }));
        ring.position.y = Y + 0.56 + k * 0.07;
        ring.rotation.x = Math.PI / 2;
        g.add(ring);
      }
      const tip = new THREE.Mesh(new THREE.OctahedronGeometry(0.05, 0), mat('#d36bff', { emissive: '#b44fe8' }));
      tip.position.y = Y + 0.78;
      g.add(tip);
      a.blink = [{ mesh: tip, speed: 4 }];
      break;
    }
  }
  void cx;
  void cy;
  void first;
  return g;
}

// full building (all cells), for icons/hero — positions modules in a w×h footprint
export function buildFullBuilding(type: BuildingType, w: number, h: number, color: string): THREE.Group {
  const g = new THREE.Group();
  const base = buildBuildingFootprintBase(type, w, h);
  base.position.set(-(w - 1) / 2, 0, -(h - 1) / 2);
  g.add(base);
  for (let cy = 0; cy < h; cy++)
    for (let cx = 0; cx < w; cx++) {
      const m = buildBuildingCellModule(type, cy * w + cx, w, h, color);
      m.position.set(cx - (w - 1) / 2, 0, cy - (h - 1) / 2);
      g.add(m);
    }
  return g;
}

// ===================== CRATERS =====================
// small impact crater: raised dirt rim + scorched bowl (sits on a land top)
export function buildCrater(gx: number, gy: number, big = false): THREE.Group {
  const g = new THREE.Group();
  const r = (big ? 0.4 : 0.28) + hash01(gx, gy, 188) * 0.08;
  const bowl = new THREE.Mesh(new THREE.CircleGeometry(r, 10), mat('#241c12'));
  bowl.rotation.x = -Math.PI / 2;
  bowl.rotation.z = hash01(gx, gy, 189) * Math.PI;
  bowl.scale.set(0.82 + hash01(gx, gy, 190) * 0.38, 0.72 + hash01(gx, gy, 191) * 0.42, 1);
  bowl.position.y = 0.015;
  bowl.receiveShadow = true;
  g.add(bowl);
  const inner = new THREE.Mesh(new THREE.CircleGeometry(r * 0.45, 8), mat('#0e0a06'));
  inner.rotation.x = -Math.PI / 2;
  inner.rotation.z = hash01(gx, gy, 192) * Math.PI;
  inner.scale.set(0.7 + hash01(gx, gy, 193) * 0.45, 0.7 + hash01(gx, gy, 194) * 0.35, 1);
  inner.position.y = 0.022;
  g.add(inner);
  const chunks = (big ? 7 : 5) + Math.floor(hash01(gx, gy, 195) * 4);
  for (let k = 0; k < chunks; k++) {
    const a = (k / chunks) * Math.PI * 2 + hash01(gx, gy, 91 + k) * 0.5;
    const s = (big ? 0.08 : 0.045) + hash01(gx, gy, 97 + k) * (big ? 0.08 : 0.06);
    const rim = box(
      s * (0.75 + hash01(gx, gy, 104 + k) * 0.8),
      s * (0.45 + hash01(gx, gy, 105 + k) * 0.75),
      s * (0.65 + hash01(gx, gy, 106 + k) * 0.9),
      hash01(gx, gy, 101 + k) > 0.55 ? P.dirtDark : hash01(gx, gy, 102 + k) > 0.5 ? '#5c4632' : P.char,
      Math.cos(a) * r * (0.82 + hash01(gx, gy, 107 + k) * 0.35),
      0.026 + s * 0.34,
      Math.sin(a) * r * (0.82 + hash01(gx, gy, 108 + k) * 0.35),
    );
    rim.rotation.y = hash01(gx, gy, 103 + k) * Math.PI;
    rim.rotation.z = (hash01(gx, gy, 109 + k) - 0.5) * 0.55;
    g.add(rim);
  }
  return g;
}

// ===================== PROJECTILES =====================
export type ProjectileKind = 'missile' | 'shell' | 'napalm' | 'nuke' | 'tracer';
// built nose-up (+Y); the renderer orients them along the flight path
export function buildProjectile(kind: ProjectileKind): THREE.Group {
  const g = new THREE.Group();
  if (kind === 'missile') {
    g.add(cyl(0.05, 0.05, 0.26, P.hull, 0, 0, 0, 6));
    g.add(cone(0.05, 0.1, '#d04a42', 0, 0.18, 0, 6));
    for (let k = 0; k < 3; k++) {
      const fin = box(0.02, 0.08, 0.07, '#d04a42', 0, -0.12, 0);
      fin.rotation.y = (k / 3) * Math.PI * 2;
      fin.position.x = Math.cos((k / 3) * Math.PI * 2) * 0.05;
      fin.position.z = Math.sin((k / 3) * Math.PI * 2) * 0.05;
      g.add(fin);
    }
    const exhaust = cone(0.04, 0.1, '#ffcf4d', 0, -0.18, 0, 5);
    exhaust.rotation.x = Math.PI;
    exhaust.material = mat('#ffcf4d', { emissive: '#ffaf20' });
    g.add(exhaust);
  } else if (kind === 'shell') {
    const sh = new THREE.Mesh(new THREE.SphereGeometry(0.085, 6, 5), mat('#3c4350'));
    setSh(sh);
    g.add(sh);
    g.add(cone(0.06, 0.08, '#2a303a', 0, 0.08, 0, 6));
  } else if (kind === 'napalm') {
    const barrel = cyl(0.07, 0.07, 0.16, '#c05a20', 0, 0, 0, 7);
    g.add(barrel);
    g.add(cyl(0.075, 0.075, 0.025, '#7a3f1c', 0, 0.06, 0, 7));
    const fl = cone(0.05, 0.12, P.fire, 0, -0.13, 0, 5);
    fl.rotation.x = Math.PI;
    fl.material = mat(P.fire, { emissive: '#ff5a10' });
    g.add(fl);
    getAnim(g).spin = [{ obj: barrel, axis: 'x', speed: 9 }];
  } else if (kind === 'nuke') {
    g.add(cyl(0.09, 0.09, 0.34, P.hull, 0, 0, 0, 8));
    g.add(cone(0.09, 0.16, '#3c4350', 0, 0.25, 0, 8));
    for (let k = 0; k < 4; k++) {
      const fin = box(0.025, 0.12, 0.1, '#d0aa30', 0, -0.16, 0);
      fin.position.x = Math.cos((k / 4) * Math.PI * 2) * 0.08;
      fin.position.z = Math.sin((k / 4) * Math.PI * 2) * 0.08;
      g.add(fin);
    }
    const lamp = box(0.04, 0.04, 0.04, '#ff3b3b', 0, 0.1, 0.1, '#ff2020');
    g.add(lamp);
    getAnim(g).blink = [{ mesh: lamp, speed: 8 }];
  } else {
    // tracer round
    const tr = new THREE.Mesh(new THREE.SphereGeometry(0.04, 5, 4), mat('#ffe27f', { emissive: '#ffc020' }));
    g.add(tr);
  }
  return g;
}

// ===================== TEXT SPRITES =====================
export function makeTextSprite(text: string, color: string, scale = 1): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 128;
  const c = cv.getContext('2d')!;
  c.font = 'bold 64px "Share Tech Mono", monospace';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.lineWidth = 10;
  c.strokeStyle = 'rgba(0,0,0,0.85)';
  c.strokeText(text, 256, 64);
  c.fillStyle = color;
  c.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(3.4 * scale, 0.85 * scale, 1);
  return sp;
}

// territory owner banner (always faces camera)
export function makeBanner(name: string, color: string, dead: boolean, you: boolean): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 144;
  const c = cv.getContext('2d')!;
  const label = dead ? `✝ ${name}` : you ? `${name} (YOU)` : name;
  c.font = 'bold 56px "Share Tech Mono", monospace';
  const tw = Math.min(480, c.measureText(label).width + 60);
  const x0 = (512 - tw) / 2;
  c.fillStyle = 'rgba(4,12,22,0.72)';
  c.fillRect(x0, 28, tw, 88);
  c.strokeStyle = dead ? '#5a6470' : color;
  c.lineWidth = 6;
  c.strokeRect(x0, 28, tw, 88);
  c.fillStyle = dead ? '#7a8490' : color;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(label, 256, 74);
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(4.6, 1.3, 1);
  return sp;
}

// apply spin/sway/blink animations registered in userData across a subtree
export function animateTree(root: THREE.Object3D, t: number) {
  root.traverse((o) => {
    const a = o.userData.anim as Anim | undefined;
    if (!a) return;
    if (a.spin) for (const s of a.spin) s.obj.rotation[s.axis] = t * s.speed;
    if (a.sway) for (const s of a.sway) s.obj.rotation[s.axis] = (s.base ?? 0) + Math.sin(t * s.speed) * s.amp;
    if (a.blink)
      for (const b of a.blink) {
        const m = b.mesh.material as THREE.MeshStandardMaterial;
        m.emissiveIntensity = Math.sin(t * b.speed * 2) > 0 ? 1.6 : 0.15;
      }
    if (a.radiation)
      for (const rad of a.radiation) {
        const pulse = 0.5 + 0.5 * Math.sin(t * rad.speed + rad.phase);
        const m = rad.points.material as THREE.PointsMaterial;
        m.opacity = 0.42 + pulse * 0.32;
        m.size = 0.045 + pulse * 0.025;
        rad.points.position.y = Math.sin(t * rad.speed * 0.7 + rad.phase) * 0.018;
        rad.points.rotation.y = Math.sin(t * 0.45 + rad.phase) * 0.16;
      }
    if (a.bob)
      for (const b of a.bob) {
        b.obj.position[b.axis] = b.base + Math.sin(t * b.speed) * b.amp;
      }
    if (a.pulse)
      for (const p of a.pulse) {
        const m = p.mesh.material as THREE.MeshStandardMaterial;
        const wave = Math.sin(t * p.speed);
        if (m.transparent) {
          m.opacity = p.baseOpacity + wave * p.amp;
        }
        m.emissiveIntensity = 0.55 + wave * 0.45;
      }
  });
}
