// Offscreen 3D snapshots of buildings for UI icons (one shared WebGL context, cached PNGs).
import * as THREE from 'three';
import type { BuildingType } from '@shared/types';
import { BUILDINGS } from '@shared/constants';
import { buildFullBuilding } from './lowpoly';

const SIZE = 112;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.OrthographicCamera | null = null;
const cache = new Map<string, string>();

function ensure() {
  if (renderer) return true;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(SIZE, SIZE, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xbfd8ee, 0.85));
    const sun = new THREE.DirectionalLight(0xfff1d6, 1.4);
    sun.position.set(4, 7, 3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(512, 512);
    sun.shadow.camera.left = -3;
    sun.shadow.camera.right = 3;
    sun.shadow.camera.top = 3;
    sun.shadow.camera.bottom = -3;
    scene.add(sun);
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 50);
    camera.position.set(6, 5.4, 6);
    camera.lookAt(0, 0.25, 0);
    return true;
  } catch {
    renderer = null;
    return false;
  }
}

export function buildingIconUrl(type: BuildingType, color: string): string {
  const key = `${type}|${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (!ensure() || !renderer || !scene || !camera) return '';
  const def = BUILDINGS[type];
  const g = buildFullBuilding(type, def.w, def.h, color);
  // ground plinth per footprint cell
  for (let cy = 0; cy < def.h; cy++)
    for (let cx = 0; cx < def.w; cx++) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.22, 0.98), [
        new THREE.MeshStandardMaterial({ color: '#9a6b42', flatShading: true }),
        new THREE.MeshStandardMaterial({ color: '#9a6b42', flatShading: true }),
        new THREE.MeshStandardMaterial({ color: '#6fc25b', flatShading: true, roughness: 0.9 }),
        new THREE.MeshStandardMaterial({ color: '#7a5232', flatShading: true }),
        new THREE.MeshStandardMaterial({ color: '#7a5232', flatShading: true }),
        new THREE.MeshStandardMaterial({ color: '#9a6b42', flatShading: true }),
      ]);
      slab.position.set(cx - (def.w - 1) / 2, -0.11, cy - (def.h - 1) / 2);
      slab.receiveShadow = true;
      g.add(slab);
    }
  scene.add(g);
  const half = Math.max(def.w, def.h) * 0.62 + 0.35;
  camera.left = -half;
  camera.right = half;
  camera.top = half;
  camera.bottom = -half * 0.7;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  scene.remove(g);
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
  });
  cache.set(key, url);
  return url;
}
