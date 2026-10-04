import * as THREE from 'three';
import { buildModel } from '../../../../shared/components/voxelModel';
import type { Voxel, VoxelModel } from '../../../../shared/components/voxelModel';
import type { LiveContext, LiveModule } from './types';
import { COLORS } from './types';

// Voxel layers of the shared model that this module renders.
// miniMushrooms, ground and spores are skipped — the scene provides its own ground.
const LAYERS = ['capGreen', 'capSpots', 'capRim', 'gills', 'stem', 'moss'] as const;
type LayerKey = (typeof LAYERS)[number];

const GROUP_SCALE = 3;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const easeOutCubic = (u: number): number => {
  const c = clamp01(u);
  return 1 - Math.pow(1 - c, 3);
};

/** Deterministic per-voxel hash in [0, 1) for stable color variation. */
function hash4(x: number, y: number, z: number, k: number): number {
  let h =
    Math.imul(x | 0, 374761393) ^
    Math.imul(y | 0, 668265263) ^
    Math.imul(z | 0, 2147483647) ^
    Math.imul(k, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * SporeMushroom — the giant voxel mushroom at market center (0,0,0).
 *
 * One InstancedMesh per voxel layer (box 0.96, flat-shaded standard material),
 * per-instance color with a stable 0.93–1.07 hash variation. Group scaled ~3x
 * (~65+ world units wide) with its base at y=0.
 *
 * Behavior, all driven by timeline t (never Date.now):
 *   t < 84        hidden (scale 0)
 *   84–92         rises/scales in with easeOutCubic
 *   t >= 92       slow rotation.y (0.05 rad/s; 0.02 rad/s in reduced motion)
 *   96–108        moss-green PointLight at the mushroom's center pulses
 *   t >= 108      steady state: gentle pulse continues, slow rotation continues
 *
 * NOTE (other lanes): with prefers-reduced-motion the scene starts at t=120,
 * so this module must treat t>=108 as steady-state — handled above.
 */
export class SporeMushroom implements LiveModule {
  private readonly scene: THREE.Scene;
  private readonly group = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly sharedGeo = new THREE.BoxGeometry(0.96, 0.96, 0.96);
  private readonly pulseLight: THREE.PointLight;
  private readonly reducedMotion: boolean;

  constructor(ctx: LiveContext) {
    this.scene = ctx.scene;
    this.reducedMotion = ctx.reducedMotion;

    const model: VoxelModel = buildModel('high');
    for (let li = 0; li < LAYERS.length; li++) {
      const layerKey: LayerKey = LAYERS[li];
      const voxels: Voxel[] = model[layerKey];
      if (voxels.length === 0) continue;
      const mat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85 });
      const mesh = new THREE.InstancedMesh(this.sharedGeo, mat, voxels.length);
      const m = new THREE.Matrix4();
      const c = new THREE.Color();
      for (let i = 0; i < voxels.length; i++) {
        const v = voxels[i];
        const s = v.size ?? 1;
        m.makeScale(s, s, s);
        m.setPosition(v.pos[0], v.pos[1], v.pos[2]);
        mesh.setMatrixAt(i, m);
        // Slight per-instance color variation, 0.93–1.07, stable across runs.
        c.set(v.color).multiplyScalar(0.93 + hash4(v.pos[0], v.pos[1], v.pos[2], li) * 0.14);
        mesh.setColorAt(i, c);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = ctx.quality.shadows;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }

    // Activation glow: moss-green point light at the mushroom's center
    // (group-local (0,10,0) -> world (0,30,0) at 3x scale), intensity pulsed in update().
    this.pulseLight = new THREE.PointLight(COLORS.moss, 0, 140);
    this.pulseLight.position.set(0, 10, 0);
    this.group.add(this.pulseLight);

    this.group.position.set(0, 0, 0);
    this.group.scale.setScalar(0.0001);
    this.group.visible = false;
    this.scene.add(this.group);
  }

  update(dt: number, t: number): void {
    if (t < 84) {
      this.group.visible = false;
      this.pulseLight.intensity = 0;
      return;
    }
    this.group.visible = true;

    // 84–92: rise/scale in with easeOutCubic.
    const s = GROUP_SCALE * easeOutCubic((t - 84) / 8);
    this.group.scale.setScalar(Math.max(0.0001, s));

    // Slow rotation after the rise (still rotates, very slowly, in reduced motion).
    if (t >= 92) {
      this.group.rotation.y += (this.reducedMotion ? 0.02 : 0.05) * dt;
    }

    // 96–108 (and steady-state beyond): gentle emissive-style pulse via light.
    if (t >= 96) {
      const pulse = 0.75 + 0.25 * Math.sin(((t - 96) * Math.PI * 2) / 6);
      this.pulseLight.intensity = 60 * pulse;
    } else {
      this.pulseLight.intensity = 0;
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.dispose(); // releases instanceMatrix / instanceColor buffers
      (mesh.material as THREE.Material).dispose();
    }
    this.meshes.length = 0;
    this.sharedGeo.dispose();
    this.group.removeFromParent();
  }
}
