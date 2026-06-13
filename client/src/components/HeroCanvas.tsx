import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { BuildingType, TerrainType } from '@shared/types';
import { animateTree, buildDecoration, buildFullBuilding, buildTerrainCell, LAND_TOP, mat } from '../game/three/lowpoly';

// Low-poly 3D "attract mode" diorama for the landing hero.
export function HeroCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch {
      return;
    }
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xbfd8ee, 0.7));
    const sun = new THREE.DirectionalLight(0xfff1d6, 1.3);
    sun.position.set(8, 14, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -12;
    sun.shadow.camera.right = 12;
    sun.shadow.camera.top = 12;
    sun.shadow.camera.bottom = -12;
    scene.add(sun);

    const camera = new THREE.OrthographicCamera(-9, 9, 6, -6, 0.1, 100);
    camera.position.set(16, 13, 16);
    camera.lookAt(0, 0, 0);

    const island = new THREE.Group();
    scene.add(island);

    // little archipelago
    const COLS = 15;
    const ROWS = 11;
    const terr: TerrainType[] = new Array(COLS * ROWS).fill('deep');
    const blobs = [
      { x: 4, y: 5, r: 2.8 },
      { x: 10.5, y: 5.5, r: 2.8 },
      { x: 7.5, y: 8, r: 1.6 },
    ];
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++)
        for (const b of blobs) {
          const d = Math.hypot(x - b.x, y - b.y);
          if (d < b.r) terr[y * COLS + x] = 'land';
          else if (d < b.r + 1 && terr[y * COLS + x] === 'deep') terr[y * COLS + x] = 'reef';
        }
    terr[4 * COLS + 3] = 'mountain';
    terr[6 * COLS + 11] = 'mountain';

    const wx = (gx: number) => gx - COLS / 2 + 0.5;
    const wz = (gy: number) => gy - ROWS / 2 + 0.5;
    const terrainCtx = (gx: number, gy: number) => {
      const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < COLS && y < ROWS ? terr[y * COLS + x] : undefined);
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
    };
    const waterMeshes: THREE.Mesh[] = [];
    const occupied = new Set<number>();

    const builds: { type: BuildingType; x: number; y: number; color: string }[] = [
      { type: 'base', x: 3, y: 4, color: '#3fb6ff' },
      { type: 'silo', x: 5, y: 5, color: '#3fb6ff' },
      { type: 'radar', x: 3, y: 6, color: '#3fb6ff' },
      { type: 'base', x: 10, y: 4, color: '#ff5a5a' },
      { type: 'nuclear', x: 9, y: 6, color: '#ff5a5a' },
    ];
    for (const b of builds) {
      const def = { base: [2, 2], silo: [1, 1], radar: [2, 2], nuclear: [3, 2] }[b.type as 'base' | 'silo' | 'radar' | 'nuclear'] || [1, 1];
      for (let dy = 0; dy < def[1]; dy++) for (let dx = 0; dx < def[0]; dx++) occupied.add((b.y + dy) * COLS + (b.x + dx));
    }

    for (let gy = 0; gy < ROWS; gy++)
      for (let gx = 0; gx < COLS; gx++) {
        const i = gy * COLS + gx;
        const cell = buildTerrainCell(terr[i], gx, gy, terrainCtx(gx, gy));
        cell.position.set(wx(gx), 0, wz(gy));
        island.add(cell);
        for (const ch of cell.children) if ((ch as THREE.Mesh).userData.water) waterMeshes.push(ch as THREE.Mesh);
        if (terr[i] === 'land' && !occupied.has(i)) {
          const d = buildDecoration(gx, gy);
          if (d) {
            d.position.set(wx(gx), 0, wz(gy));
            island.add(d);
          }
        }
      }

    for (const b of builds) {
      const def = { base: [2, 2], silo: [1, 1], radar: [2, 2], nuclear: [3, 2] }[b.type as 'base' | 'silo' | 'radar' | 'nuclear'] || [1, 1];
      const g = buildFullBuilding(b.type, def[0], def[1], b.color);
      g.position.set(wx(b.x) + (def[0] - 1) / 2, LAND_TOP, wz(b.y) + (def[1] - 1) / 2);
      island.add(g);
    }

    // ambient battle: missiles arcing between islands
    interface Shot {
      mesh: THREE.Mesh;
      from: THREE.Vector3;
      to: THREE.Vector3;
      t: number;
    }
    let shots: Shot[] = [];
    interface Spark {
      mesh: THREE.Mesh;
      vel: THREE.Vector3;
      life: number;
    }
    let sparks: Spark[] = [];
    let nextShot = 1.2;

    const fit = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      renderer.setSize(Math.floor(rect.width * dpr), Math.floor(rect.height * dpr), false);
      const aspect = rect.width / Math.max(1, rect.height);
      const half = 8.6;
      camera.left = -half * Math.max(1, aspect);
      camera.right = half * Math.max(1, aspect);
      camera.top = half * (aspect >= 1 ? 1 : 1 / aspect) * 0.62;
      camera.bottom = -half * (aspect >= 1 ? 1 : 1 / aspect) * 0.62;
      camera.updateProjectionMatrix();
    };
    fit();
    window.addEventListener('resize', fit);

    let raf = 0;
    let last = performance.now();
    let t = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      t += dt;
      island.rotation.y = Math.sin(t * 0.12) * 0.16;
      animateTree(island, t);
      for (const w of waterMeshes) {
        const ph = (w.userData.water as { phase: number }).phase;
        w.position.y = 0.06 + Math.sin(t * 1.4 + ph) * 0.015;
      }
      nextShot -= dt;
      if (nextShot <= 0) {
        nextShot = 1.6 + Math.random() * 1.4;
        const fromBlue = Math.random() < 0.5;
        const from = fromBlue ? new THREE.Vector3(wx(5), LAND_TOP + 0.5, wz(5)) : new THREE.Vector3(wx(10.5), LAND_TOP + 0.5, wz(5));
        const to = fromBlue
          ? new THREE.Vector3(wx(9 + Math.random() * 3), LAND_TOP, wz(4 + Math.random() * 3))
          : new THREE.Vector3(wx(3 + Math.random() * 3), LAND_TOP, wz(4 + Math.random() * 3));
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 5), mat(fromBlue ? '#9fe0ff' : '#ffb08a', { emissive: fromBlue ? '#5fb0e0' : '#ff7a4a' }));
        island.add(m);
        shots.push({ mesh: m, from, to, t: 0 });
      }
      for (const s of shots) {
        s.t += dt / 1.1;
        const u = Math.min(1, s.t);
        s.mesh.position.lerpVectors(s.from, s.to, u);
        s.mesh.position.y += Math.sin(u * Math.PI) * 2.2;
        if (s.t >= 1) {
          island.remove(s.mesh);
          s.mesh.geometry.dispose();
          for (let k = 0; k < 16; k++) {
            const sp = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), mat(Math.random() < 0.5 ? '#ffcf4d' : '#ff6a3d', { emissive: '#ff8a2d' }));
            sp.position.copy(s.to);
            island.add(sp);
            sparks.push({
              mesh: sp,
              vel: new THREE.Vector3((Math.random() - 0.5) * 2.4, Math.random() * 2.4 + 0.6, (Math.random() - 0.5) * 2.4),
              life: 0.7,
            });
          }
        }
      }
      shots = shots.filter((s) => s.t < 1);
      for (const sp of sparks) {
        sp.life -= dt;
        sp.vel.y -= 5 * dt;
        sp.mesh.position.addScaledVector(sp.vel, dt);
        if (sp.life <= 0) {
          island.remove(sp.mesh);
          sp.mesh.geometry.dispose();
        }
      }
      sparks = sparks.filter((s) => s.life > 0);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', fit);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
      renderer.dispose();
    };
  }, []);
  return <canvas ref={ref} className="hero-canvas" />;
}
