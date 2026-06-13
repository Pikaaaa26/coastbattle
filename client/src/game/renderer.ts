// Coast Battle board renderer — low-poly 3D diorama (three.js, orthographic isometric).
import * as THREE from 'three';
import type { BuildingType, GameEvent, GameState, TerrainType, Vec } from '@shared/types';
import { buildingDef } from '@shared/constants';
import {
  LAND_TOP,
  WATER_TOP,
  animateTree,
  buildBuildingCellModule,
  buildBuildingFootprintBase,
  buildCrater,
  buildDecoration,
  buildProjectile,
  buildRuin,
  buildTerrainCell,
  getAnim,
  hasWaterNeighbor,
  hash01,
  makeTextSprite,
  mat,
  shorelineInteriorRect,
  type ProjectileKind,
  type TerrainNeighbors,
} from './three/lowpoly';

export interface Interaction {
  mode: 'idle' | 'placeBase' | 'build' | 'fire' | 'sonar';
  ghostType?: BuildingType;
  attackW?: number;
  attackH?: number;
  rot?: 0 | 1;
  hover?: Vec | null;
  validCells?: Set<number>;
  selectedBuildingId?: string;
  myIndex: number;
}

interface Fx {
  mesh: THREE.Object3D;
  life: number;
  maxLife: number;
  update: (fx: Fx, dt: number, t: number) => void;
}
interface Proj {
  mesh: THREE.Object3D;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  dur: number;
  arc: number;
  endU: number; // fraction of the path where it detonates (intercepts cut flight short)
  kind: ProjectileKind;
  trailT: number;
  onArrive: (at: THREE.Vector3) => void;
}
interface Kick {
  obj: THREE.Object3D;
  life: number;
  maxLife: number;
  baseY: number;
  baseRotZ: number;
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.userData.disposeMaterial && m.material) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const material of mats) material.dispose();
    }
  });
}
function clearGroup(g: THREE.Group) {
  for (const c of [...g.children]) {
    disposeTree(c);
    g.remove(c);
  }
}

export class BoardRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
  private raycaster = new THREE.Raycaster();
  private raf = 0;
  private last = 0;
  private time = 0;
  private shake = 0;

  private W = 20;
  private H = 20;
  private view: GameState | null = null;
  private viewer = 0;
  private interaction: Interaction = { mode: 'idle', myIndex: 0 };
  private hadResearch: Record<number, boolean> = {};

  private terrainG = new THREE.Group();
  private decoG = new THREE.Group();
  private buildingsG = new THREE.Group();
  private fogG = new THREE.Group();
  private markerG = new THREE.Group();
  private uiG = new THREE.Group();
  private ghostG = new THREE.Group();
  private fxG = new THREE.Group();

  private terrainKey = '';
  private buildKey = '';
  private fogKey = '';
  private fogHiddenPrev = new Set<number>();
  private waterMeshes: THREE.Mesh[] = [];
  private terrainPick: THREE.Mesh[] = [];
  // board state is applied only after in-flight ordnance lands (impact-synced destruction)
  private lockUntil = 0;
  private pendingView: GameState | null = null;
  private smokeAnchors: THREE.Vector3[] = [];
  private flameAnchors: THREE.Vector3[] = [];
  private smokeTimer = 0;
  private fx: Fx[] = [];
  private projs: Proj[] = [];
  private ghostKey = '';
  private ghostMats: THREE.MeshStandardMaterial[] = [];
  private shieldFields: THREE.Mesh[] = [];
  private craterSeen = new Set<number>();
  private kicks: Kick[] = [];
  private validKey = '';
  private zoomF = 1;
  private panOff = new THREE.Vector3();
  private landSpan = 20;
  private readonly camDist = 46;
  private az = Math.PI / 4; // camera azimuth (yaw); rotatable in 90° steps
  private azTarget = Math.PI / 4;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color('#081627');

    const amb = new THREE.AmbientLight(0xc9def2, 0.95);
    const sun = new THREE.DirectionalLight(0xfff1d6, 1.55);
    sun.position.set(13, 22, 9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -24;
    sun.shadow.camera.right = 24;
    sun.shadow.camera.top = 24;
    sun.shadow.camera.bottom = -24;
    sun.shadow.camera.far = 90;
    sun.shadow.bias = -0.0004;
    this.scene.add(amb, sun);
    this.scene.add(this.terrainG, this.decoG, this.buildingsG, this.fogG, this.markerG, this.uiG, this.ghostG, this.fxG);

    // classic isometric: azimuth 45° (rotatable), elevation ~35.26°
    const d = this.camDist;
    this.camera.position.set(Math.sin(this.az) * d, d * 0.82, Math.cos(this.az) * d);
    this.camera.lookAt(0, 0, 0);
  }

  // ---------- public API ----------
  start() {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.time += dt;
      this.step(dt);
      this.render();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearGroup(this.terrainG);
    clearGroup(this.decoG);
    clearGroup(this.buildingsG);
    clearGroup(this.fogG);
    clearGroup(this.markerG);
    clearGroup(this.uiG);
    clearGroup(this.ghostG);
    clearGroup(this.fxG);
    this.renderer.dispose();
  }
  setView(view: GameState) {
    // hold the new board state until in-flight shots land — craters/ruins appear ON impact
    if (performance.now() < this.lockUntil && this.view) {
      this.pendingView = view;
      return;
    }
    this.applyView(view);
  }
  private applyView(view: GameState) {
    this.view = view;
    this.viewer = view.viewerIndex ?? 0;
    this.W = view.map.width;
    this.H = view.map.height;
    this.rebuildTerrainIfNeeded();
    this.rebuildBuildings();
    this.rebuildFog();
  }
  setInteraction(i: Interaction) {
    this.interaction = i;
    this.refreshInteraction();
  }

  adjustZoom(factor: number) {
    this.zoomF = Math.min(3, Math.max(0.7, this.zoomF * factor));
    this.fitCamera();
  }
  // pan by screen pixels — "grab the world" semantics, valid at any camera azimuth
  pan(dxPx: number, dyPx: number) {
    const rect = this.canvas.getBoundingClientRect();
    const wpp = (this.camera.right - this.camera.left) / Math.max(1, rect.width);
    const right = new THREE.Vector3(Math.cos(this.az), 0, -Math.sin(this.az)); // screen-right on ground
    const toward = new THREE.Vector3(Math.sin(this.az), 0, Math.cos(this.az)); // screen-down on ground
    this.panOff.addScaledVector(right, -dxPx * wpp);
    this.panOff.addScaledVector(toward, (-dyPx * wpp) / 0.577);
    const lim = Math.max(this.W, this.H) * 0.6;
    this.panOff.x = Math.min(lim, Math.max(-lim, this.panOff.x));
    this.panOff.z = Math.min(lim, Math.max(-lim, this.panOff.z));
  }
  // rotate the view a quarter turn (smoothly animated)
  rotateCamera(dir: 1 | -1) {
    this.azTarget += (Math.PI / 2) * dir;
  }
  resetCamera() {
    this.zoomF = 1;
    this.panOff.set(0, 0, 0);
    this.azTarget = Math.PI / 4;
    this.fitCamera();
  }

  cellAt(clientX: number, clientY: number): Vec | null {
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const hits = this.raycaster.intersectObjects(this.terrainPick, false);
    if (hits.length) {
      const c = hits[0].object.userData.cell as Vec | undefined;
      if (c) return c;
    }
    // fallback: intersect land plane
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -LAND_TOP);
    const pt = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(plane, pt)) {
      const gx = Math.floor(pt.x + this.W / 2);
      const gy = Math.floor(pt.z + this.H / 2);
      if (gx >= 0 && gy >= 0 && gx < this.W && gy < this.H) return { x: gx, y: gy };
    }
    return null;
  }

  // ---------- coordinates ----------
  private wx(gx: number) {
    return gx - this.W / 2 + 0.5;
  }
  private wz(gy: number) {
    return gy - this.H / 2 + 0.5;
  }
  private topOf(gx: number, gy: number): number {
    const t = this.view?.map.terrain[gy * this.W + gx];
    return t === 'deep' || t === 'reef' ? WATER_TOP : LAND_TOP;
  }
  private terrainCtx(T: TerrainType[], gx: number, gy: number): TerrainNeighbors {
    const at = (x: number, y: number): TerrainType | undefined =>
      x >= 0 && y >= 0 && x < this.W && y < this.H ? T[y * this.W + x] : undefined;
    return {
      n: at(gx, gy - 1),
      e: at(gx + 1, gy),
      s: at(gx, gy + 1),
      w: at(gx - 1, gy),
      ne: at(gx + 1, gy - 1),
      se: at(gx + 1, gy + 1),
      sw: at(gx - 1, gy + 1),
      nw: at(gx - 1, gy - 1),
    };
  }
  private isWaterCell(gx: number, gy: number): boolean {
    const t = this.view?.map.terrain[gy * this.W + gx];
    return t === 'deep' || t === 'reef';
  }

  // ---------- terrain ----------
  private rebuildTerrainIfNeeded() {
    const v = this.view!;
    const key = `${v.map.seed}:${this.viewer}:${v.map.terrain.join('')}:${v.players
      .map((p) => `${p.name}|${p.color}|${p.alive ? 1 : 0}`)
      .join(',')}`;
    if (key === this.terrainKey) return;
    this.terrainKey = key;
    clearGroup(this.terrainG);
    this.waterMeshes = [];
    this.terrainPick = [];
    const T = v.map.terrain;
    const TR = v.map.territory;
    // frame on the island, not the whole sea
    let minX = this.W;
    let maxX = 0;
    let minY = this.H;
    let maxY = 0;
    for (let gy = 0; gy < this.H; gy++)
      for (let gx = 0; gx < this.W; gx++) {
        if (T[gy * this.W + gx] === 'deep') continue;
        minX = Math.min(minX, gx);
        maxX = Math.max(maxX, gx);
        minY = Math.min(minY, gy);
        maxY = Math.max(maxY, gy);
      }
    this.landSpan = Math.max(8, Math.max(maxX - minX, maxY - minY) + 2.5);
    for (let gy = 0; gy < this.H; gy++) {
      for (let gx = 0; gx < this.W; gx++) {
        const i = gy * this.W + gx;
        const ctx = this.terrainCtx(T, gx, gy);
        const cell = buildTerrainCell(T[i], gx, gy, ctx);
        cell.position.set(this.wx(gx), 0, this.wz(gy));
        this.terrainG.add(cell);
        for (const ch of cell.children) {
          const m = ch as THREE.Mesh;
          if (m.userData.water) this.waterMeshes.push(m);
        }
        // pick proxy = the slab (first child)
        const slab = cell.children[0] as THREE.Mesh;
        slab.userData.cell = { x: gx, y: gy };
        this.terrainPick.push(slab);

        // territory tint + border — every commander in their OWN color (grey once eliminated)
        if (TR[i] >= 0 && (T[i] === 'land' || T[i] === 'rubble' || T[i] === 'irradiated')) {
          const owner = v.players[TR[i]];
          const mine = TR[i] === this.viewer;
          const dead = owner && !owner.alive;
          const col = dead ? '#6a7480' : owner?.color || '#ff5a5a';
          if (T[i] === 'land') {
            const shore = hasWaterNeighbor(ctx);
            const rect = shore ? shorelineInteriorRect(ctx) : { minX: -0.5, maxX: 0.5, minZ: -0.5, maxZ: 0.5 };
            const tintW = Math.max(0.08, rect.maxX - rect.minX);
            const tintD = Math.max(0.08, rect.maxZ - rect.minZ);
            const tint = new THREE.Mesh(
              new THREE.PlaneGeometry(tintW, tintD),
              mat(col, { opacity: dead ? 0.06 : mine ? 0.15 : 0.12 }),
            );
            tint.rotation.x = -Math.PI / 2;
            tint.position.set(this.wx(gx) + (rect.minX + rect.maxX) / 2, LAND_TOP + 0.009, this.wz(gy) + (rect.minZ + rect.maxZ) / 2);
            tint.receiveShadow = false;
            this.terrainG.add(tint);
          }
          // clean border strips along edges where the territory changes.
          // N/S edges run along X (no rotation); W/E edges run along Z (quarter turn).
          const dirs: [number, number, number, number, number][] = [
            [0, -1, 0, -0.485, 0],
            [0, 1, 0, 0.485, 0],
            [-1, 0, -0.485, 0, Math.PI / 2],
            [1, 0, 0.485, 0, Math.PI / 2],
          ];
          for (const [dx, dy, ox, oz, ry] of dirs) {
            const nx = gx + dx;
            const ny = gy + dy;
            const same = nx >= 0 && ny >= 0 && nx < this.W && ny < this.H && TR[ny * this.W + nx] === TR[i];
            if (!same) {
              const strip = new THREE.Mesh(
                new THREE.BoxGeometry(1.0, 0.03, 0.04),
                mat(col, dead ? {} : { emissive: col }),
              );
              strip.rotation.y = ry;
              strip.position.set(this.wx(gx) + ox, LAND_TOP + 0.018, this.wz(gy) + oz);
              this.terrainG.add(strip);
            }
          }
        }
      }
    }

    this.fitCamera();
  }

  private fitCamera() {
    const rect = this.canvas.getBoundingClientRect();
    const aspect = Math.max(0.5, rect.width / Math.max(1, rect.height));
    const span = this.landSpan;
    // fit the projected iso diamond of the island: width ≈ span·√2, height ≈ width·sin(35°)
    const halfW = (span * 0.74) / this.zoomF;
    const halfH = (span * 0.45) / this.zoomF;
    if (halfW / halfH > aspect) {
      this.camera.left = -halfW;
      this.camera.right = halfW;
      this.camera.top = halfW / aspect;
      this.camera.bottom = -halfW / aspect;
    } else {
      this.camera.top = halfH;
      this.camera.bottom = -halfH;
      this.camera.left = -halfH * aspect;
      this.camera.right = halfH * aspect;
    }
    this.camera.updateProjectionMatrix();
  }

  // ---------- buildings ----------
  private rebuildBuildings() {
    const v = this.view!;
    const key = JSON.stringify(
      v.buildings.map((b) => [b.id, b.type, b.x, b.y, b.w, b.h, b.owner, b.disabled, b.destroyed, b.cooldownLeft, b.operationalTurn, b.cells.map((c) => [c.hp, c.shield, c.destroyed ? 1 : 0])]),
    ) + `|${this.viewer}|t${v.turn}|${v.map.terrain.join('')}|${(v.blockedUntil ?? []).map((b) => (b > v.turn ? 1 : 0)).join('')}`;
    if (key === this.buildKey) return;
    this.buildKey = key;
    clearGroup(this.buildingsG);
    clearGroup(this.decoG);
    this.smokeAnchors = [];
    this.flameAnchors = [];
    this.shieldFields = [];

    // Detect research loss for "glow down" particle trigger
    const currentResearchMap: Record<number, boolean> = {};
    for (let pIdx = 0; pIdx < v.players.length; pIdx++) {
      const hasRes = v.buildings.some((b) => b.owner === pIdx && b.type === 'research' && !b.destroyed);
      currentResearchMap[pIdx] = hasRes;
      const wasRes = this.hadResearch[pIdx] ?? false;
      if (wasRes && !hasRes) {
        // Glow down transition for player pIdx!
        // Spawn particle-down debuff effects on all advanced structures and powerplants belonging to pIdx.
        for (const b of v.buildings) {
          if (b.owner === pIdx && !b.destroyed) {
            const def = buildingDef(b.type);
            if (b.type === 'powerplant' || def.requiresResearch) {
              const bx = this.wx(b.x) + (b.w - 1) / 2;
              const bz = this.wz(b.y) + (b.h - 1) / 2;
              const center = new THREE.Vector3(bx, LAND_TOP, bz);
              const particleColor = b.type === 'powerplant' ? '#ffcf4d' : '#3fb6ff';
              this.debuffGlowDownParticles(center, particleColor);
            }
          }
        }
      }
      this.hadResearch[pIdx] = hasRes;
    }

    const occupied = new Set<number>();
    for (const b of v.buildings) for (const c of b.cells) occupied.add(c.y * this.W + c.x);

    // decorations on free land (none on craters, rubble, or irradiated ground — blasts clear the trees)
    for (let gy = 0; gy < this.H; gy++)
      for (let gx = 0; gx < this.W; gx++) {
        const i = gy * this.W + gx;
        if (v.map.terrain[i] !== 'land' || occupied.has(i)) continue;
        if ((v.blockedUntil?.[i] ?? 0) > v.turn) continue;
        const d = buildDecoration(gx, gy);
        if (d) {
          d.position.set(this.wx(gx), 0, this.wz(gy));
          this.decoG.add(d);
        }
      }

    for (const b of v.buildings) {
      const def = buildingDef(b.type);
      const color = v.players[b.owner]?.color || '#888';
      const allDead = b.destroyed;
      if (!allDead && b.cells.some((cell) => !cell.destroyed)) {
        const footprint = buildBuildingFootprintBase(b.type, b.w, b.h);
        footprint.position.set(this.wx(b.x), LAND_TOP, this.wz(b.y));
        this.buildingsG.add(footprint);
      }
      for (let k = 0; k < b.cells.length; k++) {
        const cell = b.cells[k];
        const gx = cell.x;
        const gy = cell.y;
        let mod: THREE.Group;
        if (cell.destroyed || allDead) {
          mod = buildRuin(gx, gy);
        } else {
          // local index inside the (possibly rotated) footprint
          const localIdx = (gy - b.y) * b.w + (gx - b.x);
          mod = buildBuildingCellModule(b.type, localIdx, b.w, b.h, color);
          if (b.disabled) {
            mod.traverse((o) => {
              const mm = o as THREE.Mesh;
              if (mm.isMesh) {
                const m2 = (mm.material as THREE.MeshStandardMaterial).clone();
                m2.color.multiplyScalar(0.45);
                m2.emissiveIntensity = 0;
                mm.material = m2;
              }
            });
          }
          // damaged: scorch + smoke
          if (cell.hp < cell.maxHp) {
            const sc = new THREE.Mesh(new THREE.CircleGeometry(0.3, 8), mat('#241c14', { opacity: 0.85 }));
            sc.rotation.x = -Math.PI / 2;
            sc.position.y = 0.06;
            mod.add(sc);
            getAnim(mod).smoke = [...(getAnim(mod).smoke || []), new THREE.Vector3(0.1, 0.3, 0.1)];
          }
          // shield bubble per shielded cell
          if (cell.shield > 0) {
            const bub = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 8), mat('#7fd0ff', { opacity: 0.16, emissive: '#3fa0e0' }));
            bub.position.y = 0.3;
            bub.castShadow = false;
            bub.receiveShadow = false;
            mod.add(bub);
          }

          // Render visual aura/glimmer if boosted or activated
          const hasResearch = currentResearchMap[b.owner];
          const isPowerplantBoosted = b.type === 'powerplant' && hasResearch && !b.disabled;
          const isAdvancedActive = def.requiresResearch && !b.disabled;
          if (isPowerplantBoosted || isAdvancedActive) {
            const glowColor = isPowerplantBoosted ? '#ffcf4d' : '#3fb6ff';
            
            // 1. Base glowing ring (extremely subtle for cyan, moderately warm for powerplant)
            const baseRing = new THREE.Mesh(
              new THREE.RingGeometry(0.46, 0.52, 8),
              mat(glowColor, { opacity: isPowerplantBoosted ? 0.18 : 0.10, emissive: glowColor }).clone()
            );
            baseRing.rotation.x = -Math.PI / 2;
            baseRing.position.y = 0.09;
            baseRing.receiveShadow = false;
            baseRing.castShadow = false;
            baseRing.userData.disposeMaterial = true;
            mod.add(baseRing);

            // 2. Floating, spinning, bobbing energy core (subtle torus)
            const floatMesh = new THREE.Mesh(
              new THREE.TorusGeometry(0.2, 0.02, 4, 8),
              mat(glowColor, { opacity: isPowerplantBoosted ? 0.45 : 0.25, emissive: glowColor }).clone()
            );
            floatMesh.rotation.x = Math.PI / 2;
            floatMesh.position.y = 0.65;
            floatMesh.receiveShadow = false;
            floatMesh.castShadow = false;
            floatMesh.userData.disposeMaterial = true;
            mod.add(floatMesh);

            const anim = getAnim(mod);
            anim.spin = [...(anim.spin || []), { obj: floatMesh, axis: 'z', speed: 2.2 }];
            anim.bob = [...(anim.bob || []), { obj: floatMesh, axis: 'y', base: 0.65, amp: 0.06, speed: 3.0 }];
            anim.pulse = [...(anim.pulse || []), { mesh: baseRing, speed: 1.8, baseOpacity: isPowerplantBoosted ? 0.18 : 0.10, amp: isPowerplantBoosted ? 0.06 : 0.03 }];
          }
        }
        mod.position.set(this.wx(gx), LAND_TOP, this.wz(gy));
        this.buildingsG.add(mod);
      }
      // status beacon over my weapons & sonar: green = ready, amber NUMBER = turns of cooldown,
      // "…" = still powering up
      if (!b.destroyed && (def.category === 'weapon' || b.type === 'sonar') && b.owner === this.viewer) {
        const bx = this.wx(b.x) + (b.w - 1) / 2;
        const bz = this.wz(b.y) + (b.h - 1) / 2;
        const charging = v.turn < b.operationalTurn;
        if (b.disabled) {
          // nothing — disabled slash is on the model
        } else if (charging || b.cooldownLeft > 0) {
          const badge = makeTextSprite(charging ? '…' : String(b.cooldownLeft), '#ffcf4d', 0.42);
          badge.position.set(bx, LAND_TOP + 1.15, bz);
          this.buildingsG.add(badge);
        } else {
          const pip = new THREE.Mesh(
            new THREE.OctahedronGeometry(0.07, 0),
            mat('#52e0a0', { emissive: '#2ec07f' }),
          );
          pip.position.set(bx, LAND_TOP + 1.05, bz);
          pip.userData.anim = { spin: [{ obj: pip, axis: 'y', speed: 2 }] };
          this.buildingsG.add(pip);
        }
      }
      // shield generator: tint the EXACT protected tiles (Chebyshev square), own gens only.
      // A breached (cooling-down) generator projects nothing — no tint while it re-forms.
      if (
        !b.destroyed &&
        !b.disabled &&
        b.type === 'shield' &&
        b.owner === this.viewer &&
        b.cooldownLeft === 0 &&
        v.turn >= b.operationalTurn
      ) {
        const range = buildingDef('shield').range ?? 2;
        const seen = new Set<number>();
        for (const gc of b.cells) {
          if (gc.destroyed) continue;
          for (let dy = -range; dy <= range; dy++)
            for (let dx = -range; dx <= range; dx++) {
              const gx = gc.x + dx;
              const gy = gc.y + dy;
              if (gx < 0 || gy < 0 || gx >= this.W || gy >= this.H) continue;
              const i = gy * this.W + gx;
              if (seen.has(i)) continue;
              seen.add(i);
              const shieldMat = new THREE.MeshBasicMaterial({
                color: '#7fd0ff',
                transparent: true,
                opacity: 0.1,
                depthWrite: false,
              });
              const cap = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.96), shieldMat);
              cap.rotation.x = -Math.PI / 2;
              cap.position.set(this.wx(gx), this.topOf(gx, gy) + 0.008, this.wz(gy));
              cap.castShadow = false;
              cap.receiveShadow = false;
              cap.userData.shieldField = { phase: hash01(gx, gy, 260) * Math.PI * 2, baseY: cap.position.y };
              cap.userData.disposeMaterial = true;
              this.shieldFields.push(cap);
              this.buildingsG.add(cap);
            }
        }
      }
    }

    // collect smoke/flame anchors in world space
    this.buildingsG.traverse((o) => {
      const a = o.userData.anim as { smoke?: THREE.Vector3[]; flame?: THREE.Vector3[] } | undefined;
      if (a?.smoke) for (const s of a.smoke) this.smokeAnchors.push(o.localToWorld(s.clone()));
      if (a?.flame) for (const f of a.flame) this.flameAnchors.push(o.localToWorld(f.clone()));
    });
    this.refreshMarkers();
    this.refreshInteraction();
  }

  // ---------- fog ----------
  private rebuildFog() {
    const v = this.view!;
    if (!v.settings.fogOfWar) {
      if (this.fogKey !== 'off' && this.fogHiddenPrev.size) this.spawnFogRevealRipple([...this.fogHiddenPrev]);
      clearGroup(this.fogG);
      this.fogKey = 'off';
      this.fogHiddenPrev = new Set();
      return;
    }
    const revealed = new Set(v.players[this.viewer]?.revealed ?? []);
    // eliminated commanders' fields lose their fog — no point shelling the dead
    const ownerDead = (i: number) => {
      const o = v.map.territory[i];
      return o >= 0 && !!v.players[o] && !v.players[o].alive;
    };
    const lit = (i: number) => v.map.territory[i] === this.viewer || revealed.has(i) || ownerDead(i);
    const key = `${this.viewer}|${[...revealed].sort().join(',')}|${v.map.territory.join('')}|${v.players
      .map((p) => (p.alive ? 1 : 0))
      .join('')}`;
    if (key === this.fogKey) return;
    this.fogKey = key;
    clearGroup(this.fogG);
    const hidden = new Set<number>();
    for (let gy = 0; gy < this.H; gy++)
      for (let gx = 0; gx < this.W; gx++) {
        const i = gy * this.W + gx;
        if (lit(i)) continue;
        hidden.add(i);
        const cap = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat('#04101c', { opacity: 0.42 }));
        cap.rotation.x = -Math.PI / 2;
        cap.position.set(this.wx(gx), this.topOf(gx, gy) + 0.05, this.wz(gy));
        cap.castShadow = false;
        cap.receiveShadow = false;
        this.fogG.add(cap);
      }
    const newlyVisible = [...this.fogHiddenPrev].filter((i) => !hidden.has(i));
    this.spawnFogRevealRipple(newlyVisible);
    this.fogHiddenPrev = hidden;
  }

  private spawnFogRevealRipple(cells: number[]) {
    if (!cells.length) return;
    const pts = cells.map((i) => ({ gx: i % this.W, gy: Math.floor(i / this.W) }));
    const cx = pts.reduce((sum, p) => sum + p.gx, 0) / pts.length;
    const cy = pts.reduce((sum, p) => sum + p.gy, 0) / pts.length;
    let maxD = 0;
    for (const p of pts) maxD = Math.max(maxD, Math.hypot(p.gx - cx, p.gy - cy));
    this.ringFx(new THREE.Vector3(this.wx(cx), LAND_TOP + 0.12, this.wz(cy)), '#7fd0ff', Math.min(8, maxD + 1));
    for (const p of pts) {
      const delay = Math.hypot(p.gx - cx, p.gy - cy) * 0.055;
      const fade = 0.65;
      const capMat = new THREE.MeshBasicMaterial({
        color: '#04101c',
        transparent: true,
        opacity: 0.44,
        depthWrite: false,
      });
      const cap = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), capMat);
      cap.rotation.x = -Math.PI / 2;
      cap.position.set(this.wx(p.gx), this.topOf(p.gx, p.gy) + 0.07, this.wz(p.gy));
      cap.castShadow = false;
      cap.receiveShadow = false;
      cap.userData.disposeMaterial = true;
      this.fxG.add(cap);
      this.fx.push({
        mesh: cap,
        life: delay + fade,
        maxLife: delay + fade,
        update: (fx) => {
          if (fx.life > fade) {
            capMat.opacity = 0.44;
            return;
          }
          const u = Math.max(0, fx.life / fade);
          capMat.opacity = 0.44 * u;
          cap.scale.setScalar(1 + (1 - u) * 0.08);
        },
      });
    }
  }

  // ---------- markers ----------
  // craters exist exactly while the cell is crater-blocked — once buildable again they fade away
  private refreshMarkers() {
    clearGroup(this.markerG);
    const v = this.view;
    if (!v) return;
    if (v.blockedUntil) {
      const visible = new Set<number>();
      for (let i = 0; i < v.blockedUntil.length; i++) {
        if (v.blockedUntil[i] <= v.turn) continue;
        if (v.map.terrain[i] !== 'land') continue; // rubble/irradiated have their own permanent look
        visible.add(i);
        const gx = i % this.W;
        const gy = Math.floor(i / this.W);
        const crater = buildCrater(gx, gy, hash01(gx, gy, 7) > 0.5);
        crater.position.set(this.wx(gx), LAND_TOP, this.wz(gy));
        if (!this.craterSeen.has(i)) {
          crater.userData.craterSpawn = { life: 0.14, maxLife: 0.14 };
          crater.scale.setScalar(0.72);
        }
        this.markerG.add(crater);
      }
      this.craterSeen = visible;
    }

    if (v.visibleToEnemy) {
      for (const idx of v.visibleToEnemy) {
        const gx = idx % this.W;
        const gy = Math.floor(idx / this.W);
        
        // Semi-transparent orange highlight overlay
        const overlay = new THREE.Mesh(
          new THREE.PlaneGeometry(0.94, 0.94),
          new THREE.MeshBasicMaterial({
            color: '#ff7700',
            transparent: true,
            opacity: 0.25,
            depthWrite: false,
            side: THREE.DoubleSide
          })
        );
        overlay.rotation.x = -Math.PI / 2;
        overlay.position.set(this.wx(gx), this.topOf(gx, gy) + 0.015, this.wz(gy));
        overlay.userData.disposeMaterial = true;
        this.markerG.add(overlay);

        // Dotted orange warning border
        const outlineGeom = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-0.47, 0, -0.47),
          new THREE.Vector3(0.47, 0, -0.47),
          new THREE.Vector3(0.47, 0, -0.47),
          new THREE.Vector3(0.47, 0, 0.47),
          new THREE.Vector3(0.47, 0, 0.47),
          new THREE.Vector3(-0.47, 0, 0.47),
          new THREE.Vector3(-0.47, 0, 0.47),
          new THREE.Vector3(-0.47, 0, -0.47)
        ]);
        
        const lineMat = new THREE.LineDashedMaterial({
          color: '#ff5500',
          dashSize: 0.1,
          gapSize: 0.05,
          scale: 1,
          linewidth: 2,
        });
        
        const line = new THREE.LineSegments(outlineGeom, lineMat);
        line.computeLineDistances();
        line.position.set(this.wx(gx), this.topOf(gx, gy) + 0.017, this.wz(gy));
        line.userData.disposeMaterial = true;
        this.markerG.add(line);
      }
    }
  }

  // ---------- interaction (valid cells, ghost, footprints) ----------
  private refreshInteraction() {
    const it = this.interaction;
    const v = this.view;
    if (!v) return;

    // valid cell highlights
    const vKey = `${it.mode}|${it.ghostType}|${it.rot}|${it.selectedBuildingId || ''}|${it.validCells ? it.validCells.size : -1}`;
    if (vKey !== this.validKey) {
      this.validKey = vKey;
      clearGroup(this.uiG);
      if ((it.mode === 'build' || it.mode === 'placeBase') && it.validCells && it.ghostType) {
        for (const ci of it.validCells) {
          const gx = ci % this.W;
          const gy = Math.floor(ci / this.W);
          const p = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 0.92), mat('#52e0a0', { opacity: 0.22, emissive: '#2ec07f' }));
          p.rotation.x = -Math.PI / 2;
          p.position.set(this.wx(gx), LAND_TOP + 0.012, this.wz(gy));
          p.castShadow = false;
          this.uiG.add(p);
        }
      }
      // selected weapon highlight
      if (it.selectedBuildingId) {
        const b = v.buildings.find((bb) => bb.id === it.selectedBuildingId);
        if (b) {
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(Math.max(b.w, b.h) * 0.55, Math.max(b.w, b.h) * 0.62, 24),
            mat('#ffcf4d', { opacity: 0.9, emissive: '#d0a020' }),
          );
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(this.wx(b.x) + (b.w - 1) / 2, LAND_TOP + 0.025, this.wz(b.y) + (b.h - 1) / 2);
          this.uiG.add(ring);
        }
      }
    }

    // ghost + hover footprint (rebuilt on hover move — cheap enough at this scale)
    clearGroup(this.ghostG);
    this.ghostMats = [];
    if (!it.hover) return;
    const hx = it.hover.x;
    const hy = it.hover.y;
    if (it.mode === 'build' || it.mode === 'placeBase') {
      const type = it.ghostType || 'base';
      const def = buildingDef(type);
      const w = it.rot ? def.h : def.w;
      const h = it.rot ? def.w : def.h;
      const valid = !!it.validCells?.has(hy * this.W + hx);
      const tint = valid ? '#52e0a0' : '#ff5a5a';
      const base = buildBuildingFootprintBase(type, w, h);
      base.position.set(this.wx(hx), LAND_TOP, this.wz(hy));
      base.traverse((o) => {
        const mm = o as THREE.Mesh;
        if (mm.isMesh) {
          const m2 = (mm.material as THREE.MeshStandardMaterial).clone();
          m2.transparent = true;
          m2.opacity = 0.45;
          m2.emissive = new THREE.Color(tint);
          m2.emissiveIntensity = 0.25;
          mm.material = m2;
          mm.castShadow = false;
        }
      });
      this.ghostG.add(base);
      for (let dy = 0; dy < h; dy++)
        for (let dx = 0; dx < w; dx++) {
          const gx = hx + dx;
          const gy = hy + dy;
          if (gx >= this.W || gy >= this.H) continue;
          const modIdx = dy * w + dx;
          const mod = buildBuildingCellModule(type, modIdx, w, h, this.view!.players[this.viewer]?.color || '#888');
          mod.traverse((o) => {
            const mm = o as THREE.Mesh;
            if (mm.isMesh) {
              const m2 = (mm.material as THREE.MeshStandardMaterial).clone();
              m2.transparent = true;
              m2.opacity = 0.55;
              m2.emissive = new THREE.Color(tint);
              m2.emissiveIntensity = 0.35;
              mm.material = m2;
              mm.castShadow = false;
            }
          });
          mod.position.set(this.wx(gx), LAND_TOP, this.wz(gy));
          this.ghostG.add(mod);
        }
    } else if (it.mode === 'fire' || it.mode === 'sonar') {
      const aw = it.rot ? it.attackH || 1 : it.attackW || 1;
      const ah = it.rot ? it.attackW || 1 : it.attackH || 1;
      const anchorValid = it.mode !== 'fire' || !it.validCells || it.validCells.has(hy * this.W + hx);
      const col = it.mode === 'sonar' ? '#3fb6ff' : anchorValid ? '#ff5a5a' : '#6f7a86';
      for (let dy = 0; dy < ah; dy++)
        for (let dx = 0; dx < aw; dx++) {
          const gx = hx + dx;
          const gy = hy + dy;
          if (gx >= this.W || gy >= this.H) continue;
          const p = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.95), mat(col, { opacity: anchorValid ? 0.3 : 0.18, emissive: anchorValid ? col : undefined }));
          p.rotation.x = -Math.PI / 2;
          p.position.set(this.wx(gx), this.topOf(gx, gy) + 0.03, this.wz(gy));
          this.ghostG.add(p);
        }
      // crosshair center
      const ringo = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.36, 20), mat(col, { opacity: anchorValid ? 0.9 : 0.45, emissive: anchorValid ? col : undefined }));
      ringo.rotation.x = -Math.PI / 2;
      ringo.position.set(this.wx(hx) + (aw - 1) / 2, LAND_TOP + 0.06, this.wz(hy) + (ah - 1) / 2);
      this.ghostG.add(ringo);
    }
  }

  // ---------- events / FX ----------
  private worldOf(gx: number, gy: number, lift = 0): THREE.Vector3 {
    return new THREE.Vector3(this.wx(gx), this.topOf(gx, gy) + lift, this.wz(gy));
  }
  private originFor(player: number, from: { x: number; y: number }, tx: number, ty: number): THREE.Vector3 {
    if (player === this.viewer && from.x >= 0) return this.worldOf(from.x, from.y, 0.6);
    // enemy fire rains from the sky (origin hidden)
    return new THREE.Vector3(this.wx(tx) + (Math.random() - 0.5) * 4, 9 + Math.random() * 2, this.wz(ty) - 3);
  }

  private launchKick(from: THREE.Vector3, color: string) {
    if (from.y > 3) return;
    const flash = from.clone().add(new THREE.Vector3(0, 0.08, 0));
    this.burst(flash, color, 7, 0.22);
    this.flashLight(flash, 0.55, color);
    for (const obj of this.buildingsG.children) {
      if (obj.userData.shieldField) continue;
      const d = Math.hypot(obj.position.x - from.x, obj.position.z - from.z);
      if (d > 1.25) continue;
      if (this.kicks.some((k) => k.obj === obj)) continue;
      this.kicks.push({ obj, life: 0.26, maxLife: 0.26, baseY: obj.position.y, baseRotZ: obj.rotation.z });
    }
  }

  private shieldBreak(gx: number, gy: number, owner: number) {
    const p = this.worldOf(gx, gy, 0.45);
    this.burst(p, '#7fd0ff', 18, 0.55);
    this.ringFx(p, '#7fd0ff', 1.1);
    this.flashLight(p, 1.1, '#7fd0ff');
    this.textFx(owner === this.viewer ? 'SHIELD BREACHED' : 'ABSORBED', '#7fd0ff', p);
  }

  ingest(events: GameEvent[]) {
    const absorbed = new Map<string, number>();
    for (const e of events) {
      if (e.type === 'absorbed') absorbed.set(`${e.x},${e.y}`, e.owner);
    }
    let delay = 0;
    for (const e of events) {
      switch (e.type) {
        case 'missile': {
          const to = this.worldOf(e.to.x, e.to.y, 0.05);
          const fromV = this.originFor(e.player, e.from, e.to.x, e.to.y);
          if (e.intercepted) {
            // flak kill: missile detonates mid-flight, never reaches the target
            this.launchKick(fromV, '#ffcf4d');
            this.spawnProj(
              'missile',
              fromV,
              to,
              0.55,
              delay,
              (at) => {
                this.burst(at, '#ffe27f', 18, 0.6);
                this.burst(at, '#9fe0ff', 10, 0.5);
                this.flashLight(at, 1.2, '#ffe27f');
                this.textFx('INTERCEPTED', '#ffe27f', at);
              },
              0.62,
            );
            // defender sees their turret's tracer fire streaking up at it
            if (e.interceptedBy && e.player !== this.viewer) {
              const det = this.pathPoint(fromV, to, 0.62);
              const turret = this.worldOf(e.interceptedBy.x, e.interceptedBy.y, 0.45);
              for (let k = 0; k < 4; k++) {
                this.spawnProj('tracer', turret, det, 0.22, delay + 0.08 + k * 0.05, () => {});
              }
            }
          } else {
            this.launchKick(fromV, e.hit ? '#ffcf4d' : '#9fd6ff');
            const absorbedOwner = absorbed.get(`${e.to.x},${e.to.y}`);
            this.spawnProj('missile', fromV, to, 0.55, delay, () => {
              if (absorbedOwner !== undefined) this.shieldBreak(e.to.x, e.to.y, absorbedOwner);
              else if (e.hit) this.impact(e.to.x, e.to.y, false);
              else this.miss(e.to.x, e.to.y);
            });
          }
          delay += 0.06;
          break;
        }
        case 'artillery':
        case 'napalm': {
          const fire = e.type === 'napalm';
          const hitSet = new Set(e.hits.map((h) => h.y * this.W + h.x));
          for (const c of e.cells) {
            const to = this.worldOf(c.x, c.y, 0.05);
            const fromV = this.originFor(e.player, e.from, c.x, c.y);
            this.launchKick(fromV, fire ? '#ff7a2a' : '#ffcf4d');
            const absorbedOwner = absorbed.get(`${c.x},${c.y}`);
            this.spawnProj(fire ? 'napalm' : 'shell', fromV, to, fire ? 0.66 : 0.6, delay, () => {
              if (absorbedOwner !== undefined) this.shieldBreak(c.x, c.y, absorbedOwner);
              else if (hitSet.has(c.y * this.W + c.x)) this.impact(c.x, c.y, false, fire);
              else this.miss(c.x, c.y, fire);
              if (fire) this.flames(to);
            });
            delay += 0.07;
          }
          break;
        }
        case 'nuke': {
          const cx = e.center.x - 0.5;
          const cy = e.center.y - 0.5;
          const to = this.worldOf(Math.floor(cx), Math.floor(cy), 0.1);
          const fromV = this.originFor(e.player, e.from, Math.floor(cx), Math.floor(cy));
          this.launchKick(fromV, '#fff6d0');
          this.spawnProj('nuke', fromV, to, 1.0, 0, () => {
            for (const c of e.cells) this.impact(c.x, c.y, true);
            this.nukeBlast(to);
            this.radiationCloud(to);
          });
          break;
        }
        case 'sonar': {
          if (e.player !== this.viewer) break;
          this.ringFx(this.worldOf(Math.floor(e.center.x - 0.5), Math.floor(e.center.y - 0.5), 0.1), '#3fb6ff', 2.2);
          break;
        }
        case 'radar': {
          if (e.player !== this.viewer || !e.cells.length) break;
          const c0 = e.cells[Math.floor(e.cells.length / 2)];
          this.ringFx(this.worldOf(c0 % this.W, Math.floor(c0 / this.W), 0.1), '#52e0a0', 3);
          break;
        }
        case 'reveal': {
          if (e.player !== this.viewer) break;
          for (const ci of e.cells) this.burst(this.worldOf(ci % this.W, Math.floor(ci / this.W), 0.3), '#52e0a0', 8, 0.5);
          break;
        }
        case 'absorbed': {
          break;
        }
        case 'repair': {
          for (const c of e.cells) this.burst(this.worldOf(c.x, c.y, 0.4), '#ffd27f', 8, 0.6);
          break;
        }
        case 'cellDestroyed':
          // destruction is rendered from state (ruins/rubble) once the deferred view applies
          break;
        default:
          break;
      }
    }
    // hold the next board state until the slowest shot in this batch lands
    let maxMs = 0;
    for (const pr of this.projs) {
      maxMs = Math.max(maxMs, (pr.dur * pr.endU - pr.t) * 1000); // -t includes launch stagger
    }
    if (maxMs > 0) this.lockUntil = Math.max(this.lockUntil, performance.now() + maxMs + 120);
  }

  // point on the ballistic path at fraction u
  private pathPoint(from: THREE.Vector3, to: THREE.Vector3, u: number): THREE.Vector3 {
    const arc = from.distanceTo(to) * 0.35 + 0.8;
    const p = new THREE.Vector3().lerpVectors(from, to, u);
    p.y += Math.sin(u * Math.PI) * arc;
    return p;
  }

  private spawnProj(
    kind: ProjectileKind,
    from: THREE.Vector3,
    to: THREE.Vector3,
    dur: number,
    delay: number,
    onArrive: (at: THREE.Vector3) => void,
    endU = 1,
  ) {
    const m = buildProjectile(kind);
    m.visible = false;
    this.fxG.add(m);
    this.projs.push({
      mesh: m,
      from,
      to,
      t: -delay,
      dur,
      arc: kind === 'tracer' ? 0.05 : from.distanceTo(to) * 0.35 + 0.8,
      endU,
      kind,
      trailT: 0,
      onArrive,
    });
  }

  // rising, fading combat text
  private textFx(text: string, color: string, at: THREE.Vector3) {
    const sp = makeTextSprite(text, color);
    sp.position.copy(at).add(new THREE.Vector3(0, 0.5, 0));
    this.fxG.add(sp);
    this.fx.push({
      mesh: sp,
      life: 1.3,
      maxLife: 1.3,
      update: (fx, dt) => {
        fx.mesh.position.y += dt * 0.7;
        (sp.material as THREE.SpriteMaterial).opacity = Math.min(1, (fx.life / fx.maxLife) * 1.6);
      },
    });
  }
  private impact(gx: number, gy: number, big: boolean, fire = false) {
    const p = this.worldOf(gx, gy, 0.15);
    this.burst(p, fire ? '#ff7a2a' : '#ffcf4d', big ? 40 : 20, big ? 1 : 0.7);
    this.burst(p, '#ffffff', big ? 14 : 6, 0.4);
    this.flashLight(p, big ? 3 : 1.4, fire ? '#ff7a2a' : '#ffcf4d');
    this.shake = Math.max(this.shake, big ? 0.5 : 0.18);
  }
  private miss(gx: number, gy: number, fire = false) {
    const p = this.worldOf(gx, gy, 0.08);
    if (this.isWaterCell(gx, gy)) {
      this.burst(p, fire ? '#ffb08a' : '#bfe3ff', 10, 0.5);
      this.ringFx(p, fire ? '#ff9a5a' : '#9fd6ff', 0.7);
    } else {
      this.burst(p, fire ? '#ff7a2a' : '#8a6a4a', fire ? 12 : 8, fire ? 0.55 : 0.35);
      if (fire) this.flames(p);
      this.shake = Math.max(this.shake, 0.08);
    }
  }
  private nukeBlast(p: THREE.Vector3) {
    this.flashLight(p, 8, '#fff6d0');
    this.ringFx(p, '#ffd27f', 4.5);
    this.burst(p, '#ffcf4d', 60, 1.4);
    this.burst(p, '#ff7a2a', 40, 1.2);
    // smoke column
    for (let k = 0; k < 12; k++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(0.16 + Math.random() * 0.2, 6, 5), mat('#8a8f96', { opacity: 0.8 }));
      puff.position.copy(p);
      this.fxG.add(puff);
      const vy = 1.2 + Math.random() * 1.6;
      this.fx.push({
        mesh: puff,
        life: 1.6 + Math.random() * 0.6,
        maxLife: 2.2,
        update: (fx, dt) => {
          fx.mesh.position.y += vy * dt;
          fx.mesh.scale.multiplyScalar(1 + dt * 0.8);
          (puff.material as THREE.MeshStandardMaterial).opacity = 0.8 * (fx.life / fx.maxLife);
        },
      });
    }
    this.shake = 1.0;
  }
  private radiationCloud(p: THREE.Vector3) {
    for (let k = 0; k < 14; k++) {
      const matRad = new THREE.MeshStandardMaterial({
        color: new THREE.Color(k % 2 ? '#8aff4a' : '#c5ff7a'),
        emissive: new THREE.Color('#66d830'),
        emissiveIntensity: 0.65,
        transparent: true,
        opacity: 0.34,
        flatShading: true,
        roughness: 0.9,
      });
      const puff = new THREE.Mesh(new THREE.SphereGeometry(0.18 + Math.random() * 0.22, 7, 5), matRad);
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 1.1;
      puff.position.set(p.x + Math.cos(a) * r, p.y + 0.25 + Math.random() * 0.55, p.z + Math.sin(a) * r);
      puff.castShadow = false;
      puff.userData.disposeMaterial = true;
      this.fxG.add(puff);
      const drift = new THREE.Vector3((Math.random() - 0.5) * 0.2, 0.18 + Math.random() * 0.22, (Math.random() - 0.5) * 0.2);
      this.fx.push({
        mesh: puff,
        life: 2.8 + Math.random() * 1.5,
        maxLife: 4.2,
        update: (fx, dt, t) => {
          fx.mesh.position.addScaledVector(drift, dt);
          fx.mesh.scale.setScalar(1 + Math.sin(t * 1.8 + k) * 0.05 + (1 - fx.life / fx.maxLife) * 0.55);
          matRad.opacity = 0.34 * Math.max(0, fx.life / fx.maxLife);
        },
      });
    }
  }
  private flames(p: THREE.Vector3) {
    for (let k = 0; k < 6; k++) {
      const f = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.22, 5), mat('#ff7a2a', { emissive: '#ff5a10', opacity: 0.95 }));
      f.position.set(p.x + (Math.random() - 0.5) * 0.6, p.y + 0.08, p.z + (Math.random() - 0.5) * 0.6);
      this.fxG.add(f);
      this.fx.push({
        mesh: f,
        life: 1.2 + Math.random() * 0.8,
        maxLife: 2,
        update: (fx, dt, t) => {
          fx.mesh.scale.y = 0.8 + 0.4 * Math.sin(t * 12 + k);
          (f.material as THREE.MeshStandardMaterial).opacity = Math.min(1, fx.life);
        },
      });
    }
  }
  private burst(p: THREE.Vector3, color: string, n: number, power: number) {
    for (let k = 0; k < n; k++) {
      const s = 0.04 + Math.random() * 0.06;
      const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), mat(color, { emissive: color }));
      m.position.copy(p);
      this.fxG.add(m);
      const vel = new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 3 + 1, (Math.random() - 0.5) * 3).multiplyScalar(power);
      this.fx.push({
        mesh: m,
        life: 0.5 + Math.random() * 0.5,
        maxLife: 1,
        update: (fx, dt) => {
          vel.y -= 6 * dt;
          fx.mesh.position.addScaledVector(vel, dt);
          fx.mesh.rotation.x += dt * 5;
          fx.mesh.rotation.y += dt * 7;
        },
      });
    }
  }
  private ringFx(p: THREE.Vector3, color: string, maxR: number) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.95, 1, 36), mat(color, { opacity: 0.85, emissive: color }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(p);
    ring.scale.setScalar(0.01);
    this.fxG.add(ring);
    this.fx.push({
      mesh: ring,
      life: 0.8,
      maxLife: 0.8,
      update: (fx) => {
        const u = 1 - fx.life / fx.maxLife;
        fx.mesh.scale.setScalar(Math.max(0.01, u * maxR));
        (ring.material as THREE.MeshStandardMaterial).opacity = 0.85 * (fx.life / fx.maxLife);
      },
    });
  }
  private flashLight(p: THREE.Vector3, intensity: number, color: string) {
    const li = new THREE.PointLight(new THREE.Color(color), intensity * 14, 9, 1.6);
    li.position.copy(p).add(new THREE.Vector3(0, 0.8, 0));
    this.fxG.add(li);
    this.fx.push({
      mesh: li,
      life: 0.32,
      maxLife: 0.32,
      update: (fx) => {
        li.intensity = intensity * 14 * (fx.life / fx.maxLife);
      },
    });
  }

  // ---------- frame ----------
  private step(dt: number) {
    // smooth quarter-turn camera rotation
    this.az += (this.azTarget - this.az) * Math.min(1, dt * 6);
    // apply the deferred board state once the barrage has landed
    if (this.pendingView && performance.now() >= this.lockUntil) {
      const v = this.pendingView;
      this.pendingView = null;
      this.applyView(v);
    }
    // projectiles
    const up = new THREE.Vector3(0, 1, 0);
    for (const pr of this.projs) {
      const endT = pr.dur * pr.endU;
      const before = pr.t < endT;
      pr.t += dt;
      if (pr.t >= 0 && pr.t < endT) {
        pr.mesh.visible = true;
        const prev = pr.mesh.position.clone();
        const u = pr.t / pr.dur;
        pr.mesh.position.lerpVectors(pr.from, pr.to, u);
        pr.mesh.position.y += Math.sin(u * Math.PI) * pr.arc;
        // nose along flight direction
        const dir = pr.mesh.position.clone().sub(prev);
        if (dir.lengthSq() > 1e-6) {
          pr.mesh.quaternion.setFromUnitVectors(up, dir.normalize());
        }
        // exhaust / ember trail distinguishes the ordnance
        pr.trailT -= dt;
        if (pr.trailT <= 0 && pr.kind !== 'tracer') {
          pr.trailT = pr.kind === 'shell' ? 0.07 : 0.04;
          const tcol = pr.kind === 'napalm' ? '#ff8a3d' : pr.kind === 'nuke' ? '#cfd5dc' : '#aab6c4';
          const tp = new THREE.Mesh(new THREE.SphereGeometry(pr.kind === 'nuke' ? 0.07 : 0.04, 5, 4), mat(tcol, { opacity: 0.7, emissive: pr.kind === 'napalm' ? '#ff5a10' : undefined }));
          tp.castShadow = false;
          tp.position.copy(pr.mesh.position);
          this.fxG.add(tp);
          this.fx.push({
            mesh: tp,
            life: pr.kind === 'shell' ? 0.25 : 0.45,
            maxLife: 0.45,
            update: (fx) => {
              fx.mesh.scale.multiplyScalar(0.96);
              (tp.material as THREE.MeshStandardMaterial).opacity = 0.7 * Math.max(0, fx.life / fx.maxLife);
            },
          });
        }
      }
      if (before && pr.t >= endT) {
        const at = this.pathPoint(pr.from, pr.to, pr.endU);
        pr.mesh.visible = false;
        pr.onArrive(at);
      }
    }
    this.projs = this.projs.filter((p) => {
      if (p.t >= p.dur * p.endU + 0.05) {
        this.fxG.remove(p.mesh);
        disposeTree(p.mesh);
        return false;
      }
      return true;
    });
    // fx
    for (const f of this.fx) {
      f.life -= dt;
      f.update(f, dt, this.time);
    }
    this.fx = this.fx.filter((f) => {
      if (f.life <= 0) {
        this.fxG.remove(f.mesh);
        const m = f.mesh as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.userData.disposeMaterial && m.material) {
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const material of mats) material.dispose();
        }
        return false;
      }
      return true;
    });
    // ambient smoke from chimneys / damaged cells / ruins
    this.smokeTimer -= dt;
    if (this.smokeTimer <= 0 && this.smokeAnchors.length) {
      this.smokeTimer = 0.5 + Math.random() * 0.4;
      const anchor = this.smokeAnchors[Math.floor(Math.random() * this.smokeAnchors.length)];
      const puff = new THREE.Mesh(new THREE.SphereGeometry(0.07 + Math.random() * 0.05, 6, 5), mat('#cfd5dc', { opacity: 0.5 }));
      puff.castShadow = false;
      puff.position.copy(anchor);
      this.fxG.add(puff);
      this.fx.push({
        mesh: puff,
        life: 1.6,
        maxLife: 1.6,
        update: (fx, dtt) => {
          fx.mesh.position.y += dtt * 0.5;
          fx.mesh.scale.multiplyScalar(1 + dtt * 0.6);
          (puff.material as THREE.MeshStandardMaterial).opacity = 0.5 * (fx.life / fx.maxLife);
        },
      });
    }
    for (const s of this.shieldFields) {
      const field = s.userData.shieldField as { phase: number; baseY: number } | undefined;
      const ph = field?.phase ?? 0;
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 2.7 + ph);
      const m = s.material as THREE.MeshBasicMaterial;
      m.opacity = 0.065 + pulse * 0.065;
      s.scale.setScalar(0.96 + pulse * 0.08);
      s.position.y = (field?.baseY ?? s.position.y) + Math.sin(this.time * 3.2 + ph) * 0.004;
    }
    this.markerG.traverse((o) => {
      const spawn = o.userData.craterSpawn as { life: number; maxLife: number } | undefined;
      if (!spawn) return;
      spawn.life -= dt;
      const u = 1 - Math.max(0, spawn.life / spawn.maxLife);
      const eased = 1 - Math.pow(1 - u, 3);
      const overshoot = Math.sin(Math.min(1, u) * Math.PI) * 0.08;
      o.scale.setScalar(0.72 + eased * 0.28 + overshoot);
      if (spawn.life <= 0) {
        o.scale.setScalar(1);
        delete o.userData.craterSpawn;
      }
    });
    for (const k of this.kicks) {
      k.life -= dt;
      const u = 1 - Math.max(0, k.life / k.maxLife);
      k.obj.position.y = k.baseY + Math.sin(u * Math.PI) * 0.08;
      k.obj.rotation.z = k.baseRotZ + Math.sin(u * Math.PI) * 0.035;
    }
    this.kicks = this.kicks.filter((k) => {
      if (k.life > 0) return true;
      k.obj.position.y = k.baseY;
      k.obj.rotation.z = k.baseRotZ;
      return false;
    });
    // water bob
    for (const w of this.waterMeshes) {
      const ph = (w.userData.water as { phase: number }).phase;
      w.position.y = WATER_TOP / 2 + Math.sin(this.time * 1.4 + ph) * 0.015;
    }
    // shake decay
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 1.6);
  }

  private render() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(8, Math.floor(rect.width * dpr));
    const h = Math.max(8, Math.floor(rect.height * dpr));
    const cur = this.renderer.getSize(new THREE.Vector2());
    if (cur.x !== w || cur.y !== h) {
      this.renderer.setSize(w, h, false);
      this.fitCamera();
    }
    animateTree(this.terrainG, this.time);
    animateTree(this.buildingsG, this.time);
    animateTree(this.ghostG, this.time);
    animateTree(this.fxG, this.time); // tumbling napalm barrels, blinking nuke lamp
    const target = this.panOff;
    const d = this.camDist;
    this.camera.position.set(
      Math.sin(this.az) * d + target.x,
      d * 0.82,
      Math.cos(this.az) * d + target.z,
    );
    if (this.shake > 0.01) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.6;
      this.camera.position.z += (Math.random() - 0.5) * this.shake;
    }
    this.camera.lookAt(target.x, 0, target.z);
    this.renderer.render(this.scene, this.camera);
  }

  private debuffGlowDownParticles(center: THREE.Vector3, color: string) {
    for (let k = 0; k < 12; k++) {
      const s = 0.035 + Math.random() * 0.04;
      const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), mat(color, { emissive: color, opacity: 0.8 }));
      m.userData.disposeMaterial = true;
      const angle = Math.random() * Math.PI * 2;
      const radius = 0.1 + Math.random() * 0.45;
      m.position.set(
        center.x + Math.cos(angle) * radius,
        center.y + 0.5 + Math.random() * 0.5,
        center.z + Math.sin(angle) * radius
      );
      this.fxG.add(m);
      
      const fallSpeed = 0.4 + Math.random() * 0.5;
      this.fx.push({
        mesh: m,
        life: 0.8 + Math.random() * 0.6,
        maxLife: 1.4,
        update: (fx, dt) => {
          velYCorrection: {
            fx.mesh.position.y -= fallSpeed * dt;
          }
          fx.mesh.rotation.y += dt * 2.5;
          fx.mesh.rotation.x += dt * 1.5;
          const u = fx.life / fx.maxLife;
          (m.material as THREE.MeshStandardMaterial).opacity = 0.8 * u;
        }
      });
    }
  }
}

void hash01; // (kept for symmetry with lowpoly utilities)
