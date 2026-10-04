import * as THREE from 'three';
import { COLORS, PHASE, type LiveContext, type LiveModule } from './types';

/* ------------------------------------------------------------------ */
/* Shared helpers (also imported by AgentWorld.ts / ServiceZone.ts)     */
/* ------------------------------------------------------------------ */

/** Deterministic seeded RNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic per-voxel hash in [0, 1) for color variation. */
export function voxelHash(x: number, y: number, z: number): number {
  let h =
    (Math.floor(x * 3.7) * 374761393 +
      Math.floor(y * 3.7) * 668265263 +
      Math.floor(z * 3.7) * 919829) |
    0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) % 1000) / 1000;
}

/** Dark stone tone (#3a3733 / #4e4a44) with 0.93–1.07 brightness variation. */
export function stoneColor(v: number): THREE.Color {
  return new THREE.Color(v < 0.5 ? COLORS.stone : COLORS.stoneTop).multiplyScalar(
    0.93 + ((v * 2) % 1) * 0.14,
  );
}

/** Warm ivory tone (#ece2c8 / #e2d5b4) with 0.93–1.07 brightness variation. */
export function ivoryColor(v: number): THREE.Color {
  return new THREE.Color(v < 0.5 ? COLORS.ivory : 0xe2d5b4).multiplyScalar(
    0.93 + ((v * 2 + 0.37) % 1) * 0.14,
  );
}

/** Moss tone (#3f7a3f → #8fae5a) with 0.93–1.07 brightness variation. */
export function mossColor(v: number): THREE.Color {
  return new THREE.Color(0x3f7a3f)
    .lerp(new THREE.Color(COLORS.moss), v)
    .multiplyScalar(0.93 + ((v * 7.3) % 1) * 0.14);
}

interface PlacedVoxel {
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
}

/**
 * Accumulates voxels per named material bucket, then builds one
 * InstancedMesh per bucket. One builder == one rise-animation chunk.
 */
export class VoxelChunkBuilder {
  private buckets = new Map<string, PlacedVoxel[]>();

  add(bucket: string, x: number, y: number, z: number, color: THREE.Color): void {
    let list = this.buckets.get(bucket);
    if (!list) {
      list = [];
      this.buckets.set(bucket, list);
    }
    list.push({ x, y, z, color: color.clone() });
  }

  build(
    materials: Record<string, THREE.Material>,
    geo: THREE.BoxGeometry,
    shadows: boolean,
  ): THREE.Group {
    const group = new THREE.Group();
    const dummy = new THREE.Object3D();
    for (const [name, voxels] of this.buckets) {
      const mat = materials[name];
      if (!mat || voxels.length === 0) continue;
      const mesh = new THREE.InstancedMesh(geo, mat, voxels.length);
      for (let i = 0; i < voxels.length; i++) {
        const vx = voxels[i];
        dummy.position.set(vx.x, vx.y, vx.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, vx.color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    return group;
  }
}

/* ------------------------------------------------------------------ */
/* Layout (deterministic, seeded)                                       */
/* ------------------------------------------------------------------ */

/** Plaza surface height — buildings, terminals and agents all rest on this. */
export const PLAZA_TOP = 0.5;

export interface TerminalDatum {
  x: number;
  z: number;
  /** World-space Y of the amber top light (payment target / flash anchor). */
  topY: number;
}

interface BuildingSpec {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}
interface TerminalSpec {
  x: number;
  z: number;
}
interface PlatformSpec {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}
interface BridgeSpec {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}
interface SlabSpec {
  x: number;
  z: number;
  w: number;
  d: number;
}

interface MarketLayout {
  buildings: BuildingSpec[];
  terminals: TerminalSpec[];
  platforms: PlatformSpec[];
  bridges: BridgeSpec[];
  slabs: SlabSpec[];
}

function generateLayout(): MarketLayout {
  const rng = mulberry32(4242);
  // Building ring with a wide street gap left open at the front (+z, angle ~PI/2).
  const angles = [0.15, 0.75, 2.05, 2.75, 3.45, 4.15, 4.95, 5.75];
  const buildings: BuildingSpec[] = angles.map((a) => {
    const r = 17 + rng() * 11;
    return {
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      w: 5 + Math.floor(rng() * 4),
      d: 5 + Math.floor(rng() * 4),
      h: 6 + Math.floor(rng() * 11),
    };
  });

  const terminals: TerminalSpec[] = [];
  for (let i = 0; i < 6; i++) {
    const a = 0.4 + (i * Math.PI * 2) / 6 + (rng() - 0.5) * 0.2;
    const r = 10 + rng() * 2;
    terminals.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
  }

  const platforms: PlatformSpec[] = [0.95, 2.95, 4.95].map((a) => ({
    x: Math.cos(a) * 12.5,
    z: Math.sin(a) * 12.5,
    w: 6,
    d: 6,
    h: 2 + Math.floor(rng() * 2),
  }));

  // Two arched spans across the street gaps.
  const b1a = 1.12;
  const b1b = 1.68;
  const b2a = 5.15;
  const b2b = 5.55;
  const bridges: BridgeSpec[] = [
    { ax: Math.cos(b1a) * 21, az: Math.sin(b1a) * 21, bx: Math.cos(b1b) * 21, bz: Math.sin(b1b) * 21 },
    { ax: Math.cos(b2a) * 20, az: Math.sin(b2a) * 20, bx: Math.cos(b2b) * 20, bz: Math.sin(b2b) * 20 },
  ];

  // Reflective dark slabs scattered on the plaza, kept clear of structures.
  const slabs: SlabSpec[] = [];
  let guard = 0;
  while (slabs.length < 8 && guard++ < 60) {
    const a = rng() * Math.PI * 2;
    const r = 6 + rng() * 20;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const clearOfBuildings = buildings.every((b) => Math.hypot(b.x - x, b.z - z) > 5.5);
    const clearOfProps =
      terminals.every((t) => Math.hypot(t.x - x, t.z - z) > 3.5) &&
      platforms.every((p) => Math.hypot(p.x - x, p.z - z) > 4.5);
    if (clearOfBuildings && clearOfProps) {
      slabs.push({ x, z, w: 2 + Math.floor(rng() * 2), d: 2 + Math.floor(rng() * 2) });
    }
  }

  return { buildings, terminals, platforms, bridges, slabs };
}

const LAYOUT: MarketLayout = generateLayout();

/** Fixed terminal data shared with AgentWorld (positions + payment targets). */
export const TERMINAL_DATA: ReadonlyArray<TerminalDatum> = LAYOUT.terminals.map((t) => ({
  x: t.x,
  z: t.z,
  topY: PLAZA_TOP + 4.0,
}));

/* ------------------------------------------------------------------ */
/* MarketScene                                                          */
/* ------------------------------------------------------------------ */

interface Chunk {
  group: THREE.Group;
  baseY: number;
  birthT: number;
  dur: number;
  settled: boolean;
}

const WHITE = new THREE.Color(0xffffff);
const RISE_DIST = 14;

export class MarketScene implements LiveModule {
  private ctx: LiveContext;
  private root = new THREE.Group();
  private chunks: Chunk[] = [];
  private allSettled = false;
  private detail: number;

  private boxGeo = new THREE.BoxGeometry(0.96, 0.96, 0.96);
  private plazaGeo = new THREE.BoxGeometry(1.92, 1.92, 1.92);
  private plazaGeoMobile = new THREE.BoxGeometry(2.4, 2.4, 2.4);
  private stoneMat = new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true });
  private ivoryMat = new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true });
  private mossMat = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true });
  private amberMat = new THREE.MeshStandardMaterial({
    color: 0x3a2a12,
    emissive: COLORS.fungal,
    emissiveIntensity: 1.6,
    roughness: 0.6,
  });
  private metalMat = new THREE.MeshStandardMaterial({
    color: 0x35302b,
    metalness: 0.6,
    roughness: 0.35,
  });

  constructor(ctx: LiveContext) {
    this.ctx = ctx;
    this.detail = ctx.quality.tier === 'mobile' ? 0.55 : 1;
    this.build();
    ctx.scene.add(this.root);
    if (ctx.reducedMotion) {
      // Reduced motion: everything visible statically, no rise animation.
      for (const c of this.chunks) {
        c.group.position.y = c.baseY;
        c.group.visible = true;
        c.settled = true;
      }
      this.allSettled = true;
    }
  }

  private materials(): Record<string, THREE.Material> {
    return {
      stone: this.stoneMat,
      ivory: this.ivoryMat,
      moss: this.mossMat,
      amber: this.amberMat,
      metal: this.metalMat,
    };
  }

  private addChunk(
    group: THREE.Group,
    x: number,
    y: number,
    z: number,
    birthT: number,
    dur: number,
  ): void {
    group.position.set(x, y - RISE_DIST, z);
    group.visible = false;
    this.root.add(group);
    this.chunks.push({ group, baseY: y, birthT, dur, settled: false });
  }

  private build(): void {
    const shadows = this.ctx.quality.shadows;
    const mats = this.materials();
    const t0 = PHASE.MARKET[0]; // 28

    // Plaza disc (radius ~36; 2u voxels high, 2.5u on mobile, subtle height noise).
    const plaza = new VoxelChunkBuilder();
    this.buildPlaza(plaza);
    const plazaGeo = this.detail >= 1 ? this.plazaGeo : this.plazaGeoMobile;
    this.addChunk(plaza.build(mats, plazaGeo, shadows), 0, PLAZA_TOP, 0, t0, 3);

    // Buildings rise with stagger.
    const bCount = this.detail >= 1 ? LAYOUT.buildings.length : 5;
    LAYOUT.buildings.slice(0, bCount).forEach((b, i) => {
      const cb = new VoxelChunkBuilder();
      this.buildBuilding(cb, b);
      this.addChunk(cb.build(mats, this.boxGeo, shadows), b.x, PLAZA_TOP, b.z, t0 + 1.5 + i * 1.35, 3.5);
    });

    // Bridges.
    const br = new VoxelChunkBuilder();
    for (const s of LAYOUT.bridges) this.buildBridge(br, s);
    this.addChunk(br.build(mats, this.boxGeo, shadows), 0, PLAZA_TOP, 0, t0 + 11, 3);

    // Platforms with steps.
    const pf = new VoxelChunkBuilder();
    for (const p of LAYOUT.platforms) this.buildPlatform(pf, p);
    this.addChunk(pf.build(mats, this.boxGeo, shadows), 0, PLAZA_TOP, 0, t0 + 11.5, 3);

    // Service terminals (kiosks with amber top lights).
    const tm = new VoxelChunkBuilder();
    for (const t of LAYOUT.terminals) this.buildTerminal(tm, t);
    this.addChunk(tm.build(mats, this.boxGeo, shadows), 0, PLAZA_TOP, 0, t0 + 14, 3);

    // Reflective dark slabs (high tier only — keeps mobile near its voxel budget).
    if (this.detail >= 1) {
      const sl = new VoxelChunkBuilder();
      for (const s of LAYOUT.slabs) this.buildSlab(sl, s);
      this.addChunk(
        sl.build({ metal: this.metalMat }, this.boxGeo, shadows),
        0,
        PLAZA_TOP,
        0,
        t0 + 14.5,
        2.5,
      );
    }
  }

  private buildPlaza(b: VoxelChunkBuilder): void {
    const R = 36;
    const step = this.detail >= 1 ? 2 : 2.5; // grid step
    const vs = this.detail >= 1 ? 1.92 : 2.4; // voxel size (slightly under step)
    for (let gx = -R; gx <= R; gx += step) {
      for (let gz = -R; gz <= R; gz += step) {
        const d = Math.hypot(gx, gz);
        if (d > R) continue;
        const n = (voxelHash(gx, gz, 7) - 0.5) * 0.5;
        const edge = d > R - 2.5;
        const v = voxelHash(gx, gz, 13);
        // Local center y = n - vs/2 → world top lands at PLAZA_TOP + n.
        b.add(edge ? 'ivory' : 'stone', gx, n - vs / 2, gz, edge ? ivoryColor(v) : stoneColor(v));
      }
    }
    // Moss tufts near the plaza rim (sit on the plaza surface).
    const rng = mulberry32(4242 + 99);
    const tufts = Math.floor(46 * this.detail);
    for (let i = 0; i < tufts; i++) {
      const a = rng() * Math.PI * 2;
      const r = 28 + rng() * 7;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const hgt = 1 + Math.floor(rng() * 2);
      for (let y = 0; y < hgt; y++) {
        b.add(
          'moss',
          x,
          0.48 + y * 0.95,
          z,
          mossColor(voxelHash(x * 3, y, z * 3)),
        );
      }
    }
  }

  private buildBuilding(b: VoxelChunkBuilder, s: BuildingSpec): void {
    const rng = mulberry32(4242 + Math.floor((s.x + 40) * 13) + Math.floor((s.z + 40) * 7));
    const hw = Math.floor(s.w / 2);
    const hd = Math.floor(s.d / 2);
    const winP = 0.12 * this.detail;
    // Doorway faces the plaza center.
    const doorOnX = Math.abs(s.x) > Math.abs(s.z);
    const doorSign = doorOnX ? -Math.sign(s.x) : -Math.sign(s.z);

    for (let y = 0; y < s.h; y++) {
      for (let x = -hw; x <= hw; x++) {
        for (let z = -hd; z <= hd; z++) {
          const onX = Math.abs(x) === hw;
          const onZ = Math.abs(z) === hd;
          if (!onX && !onZ) continue;
          const corner = onX && onZ;
          const doorSide =
            (doorOnX && Math.sign(x) === doorSign && Math.abs(z) <= 1) ||
            (!doorOnX && Math.sign(z) === doorSign && Math.abs(x) <= 1);
          if (doorSide && y < 3) continue; // doorway opening
          const v = voxelHash(x + s.x, y, z + s.z);
          if (doorSide && y === 3) {
            b.add('amber', x, y + 0.5, z, WHITE); // lit lintel over the door
            continue;
          }
          const trim = y === 2 || y === s.h - 1;
          if (trim) {
            b.add('ivory', x, y + 0.5, z, ivoryColor(v));
            continue;
          }
          const isWindow = !corner && y >= 3 && y <= s.h - 3 && rng() < winP;
          if (isWindow) {
            b.add('amber', x, y + 0.5, z, WHITE);
            continue;
          }
          b.add('stone', x, y + 0.5, z, stoneColor(v));
        }
      }
    }

    // Roof slab + ivory parapet.
    for (let x = -hw; x <= hw; x++) {
      for (let z = -hd; z <= hd; z++) {
        b.add('stone', x, s.h + 0.5, z, stoneColor(voxelHash(x * 1.3 + s.x, s.h, z * 1.3 + s.z)));
        if (Math.abs(x) === hw || Math.abs(z) === hd) {
          b.add('ivory', x, s.h + 1.5, z, ivoryColor(voxelHash(x, s.h + 9, z)));
        }
      }
    }

    // Moss clusters around the base.
    const mossN = Math.max(4, Math.floor(14 * this.detail));
    for (let i = 0; i < mossN; i++) {
      const side = Math.floor(rng() * 4);
      const along = rng() * 2 - 1;
      let mx = 0;
      let mz = 0;
      if (side === 0) {
        mx = along * hw;
        mz = hd + 1;
      } else if (side === 1) {
        mx = along * hw;
        mz = -hd - 1;
      } else if (side === 2) {
        mx = hw + 1;
        mz = along * hd;
      } else {
        mx = -hw - 1;
        mz = along * hd;
      }
      const hgt = 1 + Math.floor(rng() * 3);
      for (let y = 0; y < hgt; y++) {
        b.add(
          'moss',
          mx + (rng() - 0.5) * 0.6,
          0.5 + y * 0.95,
          mz + (rng() - 0.5) * 0.6,
          mossColor(rng()),
        );
      }
    }
  }

  private buildBridge(b: VoxelChunkBuilder, s: BridgeSpec): void {
    const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
    const n = Math.max(4, Math.ceil(len));
    const px = -(s.bz - s.az) / len;
    const pz = (s.bx - s.ax) / len;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const cx = s.ax + (s.bx - s.ax) * t;
      const cz = s.az + (s.bz - s.az) * t;
      const dy = 1 + 4 * Math.sin(Math.PI * t);
      for (const off of [-0.55, 0.55]) {
        const vx = cx + off * px;
        const vz = cz + off * pz;
        const v = voxelHash(vx, i, vz);
        b.add('stone', vx, dy, vz, stoneColor(v));
        if (i % 2 === 0) b.add('ivory', vx, dy + 1, vz, ivoryColor(v));
      }
    }
  }

  private buildPlatform(b: VoxelChunkBuilder, p: PlatformSpec): void {
    const hw = Math.floor(p.w / 2);
    const hd = Math.floor(p.d / 2);
    for (let y = 0; y < p.h; y++) {
      for (let x = -hw; x <= hw; x++) {
        for (let z = -hd; z <= hd; z++) {
          const edge = Math.abs(x) === hw || Math.abs(z) === hd;
          const topEdge = y === p.h - 1 && edge;
          const v = voxelHash(x + p.x, y, z + p.z);
          b.add(topEdge ? 'ivory' : 'stone', p.x + x, y + 0.5, p.z + z, topEdge ? ivoryColor(v) : stoneColor(v));
        }
      }
    }
    // Steps down the +x side.
    for (let k = 0; k < p.h; k++) {
      const sx = p.x + hw + 1 + k;
      for (let z = -1; z <= 1; z++) {
        b.add('stone', sx, p.h - 1 - k + 0.5, p.z + z, stoneColor(voxelHash(sx, k, z)));
      }
    }
  }

  private buildTerminal(b: VoxelChunkBuilder, t: TerminalSpec): void {
    for (let y = 0; y < 3; y++) {
      for (let x = -1; x <= 0; x++) {
        for (let z = -1; z <= 0; z++) {
          b.add('stone', t.x + x + 0.5, y + 0.5, t.z + z + 0.5, stoneColor(voxelHash(t.x + x, y, t.z + z)));
        }
      }
    }
    // Amber top light.
    b.add('amber', t.x, 3.5, t.z, WHITE);
    // Ivory screen mounted on the center-facing side.
    const ix = -t.x;
    const iz = -t.z;
    const sx = Math.abs(ix) > Math.abs(iz) ? Math.sign(ix) : 0;
    const sz = sx === 0 ? Math.sign(iz) : 0;
    b.add('ivory', t.x + sx * 1.0, 2.5, t.z + sz * 1.0, ivoryColor(0.7));
  }

  private buildSlab(b: VoxelChunkBuilder, s: SlabSpec): void {
    for (let x = 0; x < s.w; x++) {
      for (let z = 0; z < s.d; z++) {
        b.add('metal', s.x + x - s.w / 2 + 0.5, 0.48, s.z + z - s.d / 2 + 0.5, WHITE);
      }
    }
  }

  update(_dt: number, t: number): void {
    if (this.allSettled) return;
    if (t < PHASE.MARKET[0]) {
      // Scrubbed back before the market phase: park everything below ground.
      for (const c of this.chunks) {
        c.group.visible = false;
        c.settled = false;
        c.group.position.y = c.baseY - RISE_DIST;
      }
      return;
    }
    let settled = 0;
    for (const c of this.chunks) {
      if (c.settled) {
        settled++;
        continue;
      }
      if (t < c.birthT) {
        c.group.visible = false;
        continue;
      }
      const k = Math.min(1, (t - c.birthT) / c.dur);
      c.group.visible = true;
      if (k >= 1) {
        c.group.position.y = c.baseY;
        c.settled = true;
        settled++;
      } else {
        const e = 1 - Math.pow(1 - k, 3); // easeOutCubic — architectural, no overshoot
        c.group.position.y = c.baseY - RISE_DIST * (1 - e);
      }
    }
    if (settled === this.chunks.length) this.allSettled = true;
  }

  dispose(): void {
    this.ctx.scene.remove(this.root);
    this.root.traverse((o) => {
      const im = o as THREE.InstancedMesh;
      if (im.isInstancedMesh) im.dispose();
    });
    this.boxGeo.dispose();
    this.plazaGeo.dispose();
    this.plazaGeoMobile.dispose();
    this.stoneMat.dispose();
    this.ivoryMat.dispose();
    this.mossMat.dispose();
    this.amberMat.dispose();
    this.metalMat.dispose();
  }
}
