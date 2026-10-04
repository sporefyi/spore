import * as THREE from 'three';
import {
  COLORS,
  PHASE,
  type LiveContext,
  type LiveModule,
  type ParticleSystem,
  type ZoneEvents,
  type ZoneInfo,
} from './types';
import {
  PLAZA_TOP,
  VoxelChunkBuilder,
  ivoryColor,
  mossColor,
  mulberry32,
  stoneColor,
  voxelHash,
} from './MarketScene';

/* ------------------------------------------------------------------ */
/* ServiceZone — five architectural service zones at radius ~32.       */
/* Structures rise just before activation (64–80s, one every ~4s),      */
/* glow on, fire onZoneActive, then pulse with the phase-7 wavefront.  */
/* ------------------------------------------------------------------ */

interface ZoneDef {
  id: string;
  label: string;
  angle: number;
  radius: number;
  height: number;
}

const ZONE_DEFS: ZoneDef[] = [
  { id: 'vault', label: 'SPORE VAULT', angle: 2.6, radius: 32, height: 7 },
  { id: 'data', label: 'SPORE DATA', angle: 3.5, radius: 32, height: 9 },
  { id: 'search', label: 'SPORE SEARCH', angle: 4.4, radius: 32, height: 10 },
  { id: 'inference', label: 'SPORE INFERENCE', angle: 5.5, radius: 32, height: 8 },
  { id: 'rpc', label: 'SPORE RPC', angle: 0.5, radius: 32, height: 15 },
];
// Front-center (angle ~PI/2, +z) stays open for the camera.

const RISE_DIST = 14;
const RISE_DUR = 2.5;
const WHITE = new THREE.Color(0xffffff);

interface Orbiter {
  r: number;
  y: number;
  speed: number;
  phase: number;
  size: number;
}

interface LatticeCell {
  x: number;
  y: number;
  z: number;
  dist: number;
}

interface ZoneRt {
  def: ZoneDef;
  group: THREE.Group;
  center: THREE.Vector3;
  rotY: number;
  glowMat: THREE.MeshStandardMaterial;
  activateT: number;
  activated: boolean;
  riseT: number;
  settled: boolean;
  glow: number;
  orbiters: THREE.InstancedMesh | null;
  orbiterData: Orbiter[];
  lattice: THREE.InstancedMesh | null;
  latticeMat: THREE.MeshStandardMaterial | null;
  latticeCells: LatticeCell[];
}

interface Particle {
  zone: number;
  phase: number;
  speed: number;
  seed: number;
  life: number;
  ax: number;
  ay: number;
  az: number;
}

export class ServiceZone implements LiveModule {
  private ctx: LiveContext;
  private events: ZoneEvents;
  private root = new THREE.Group();
  private zones: ZoneRt[] = [];
  private riseDone = false;
  private reduced: boolean;

  private boxGeo = new THREE.BoxGeometry(0.96, 0.96, 0.96);
  private stoneMat = new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true });
  private ivoryMat = new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true });
  private mossMat = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true });

  private points!: THREE.Points;
  private pGeo = new THREE.BufferGeometry();
  private pMat!: THREE.PointsMaterial;
  private pData: Particle[] = [];

  private lineGeo = new THREE.BufferGeometry();
  private lineMat!: THREE.LineBasicMaterial;

  private dummy = new THREE.Object3D();
  private tmpV = new THREE.Vector3();
  private latticeHot = new THREE.Color(0xffb14e);
  private latticeDark = new THREE.Color(0x2b2723);
  private latticeScratch = new THREE.Color();

  constructor(ctx: LiveContext, _particles: ParticleSystem, events: ZoneEvents) {
    void _particles;
    this.ctx = ctx;
    this.events = events;
    this.reduced = ctx.reducedMotion;

    ZONE_DEFS.forEach((def, i) => {
      this.zones.push(this.buildZone(def, PHASE.ZONES[0] + i * 4));
    });
    this.buildLinks();
    this.buildParticles();
    ctx.scene.add(this.root);

    if (this.reduced) {
      // Reduced motion: everything visible statically, glows on, no animation.
      for (const z of this.zones) {
        z.settled = true;
        z.activated = true;
        z.group.visible = true;
        z.group.position.y = PLAZA_TOP;
        z.glow = 1.2;
        z.glowMat.emissiveIntensity = 1.2;
        if (z.latticeMat) z.latticeMat.emissiveIntensity = 0.26;
      }
      this.riseDone = true;
      this.lineMat.opacity = 0.35;
      this.updateOrbiters(80);
      this.points.visible = true;
      this.updateParticles(0, 85); // one static layout, never animated
    }
  }

  /* ---------------- construction ---------------- */

  private buildZone(def: ZoneDef, activateT: number): ZoneRt {
    const group = new THREE.Group();
    const cx = Math.cos(def.angle) * def.radius;
    const cz = Math.sin(def.angle) * def.radius;
    const glowMat = new THREE.MeshStandardMaterial({
      color: 0x3a2a12,
      emissive: COLORS.fungal,
      emissiveIntensity: 0,
      roughness: 0.6,
    });
    const b = new VoxelChunkBuilder();
    const rt: ZoneRt = {
      def,
      group,
      center: new THREE.Vector3(cx, PLAZA_TOP, cz),
      rotY: 0,
      glowMat,
      activateT,
      activated: false,
      riseT: activateT - RISE_DUR,
      settled: false,
      glow: 0,
      orbiters: null,
      orbiterData: [],
      lattice: null,
      latticeMat: null,
      latticeCells: [],
    };
    this.buildStructure(def.id, b, rt);
    const chunk = b.build(
      { stone: this.stoneMat, ivory: this.ivoryMat, moss: this.mossMat, glow: glowMat },
      this.boxGeo,
      this.ctx.quality.shadows,
    );
    group.add(chunk);
    group.position.set(cx, PLAZA_TOP - RISE_DIST, cz);
    group.visible = false;
    this.root.add(group);
    group.lookAt(0, group.position.y, 0); // face the plaza center, stays upright
    rt.rotY = group.rotation.y;
    return rt;
  }

  private buildStructure(id: string, b: VoxelChunkBuilder, rt: ZoneRt): void {
    if (id === 'vault') this.buildVault(b);
    else if (id === 'data') {
      this.buildData(b);
      this.buildOrbiters(rt);
    } else if (id === 'search') this.buildSearch(b);
    else if (id === 'inference') {
      this.buildInferenceBase(b);
      this.buildLattice(rt);
    } else if (id === 'rpc') this.buildRpc(b);
  }

  /** Squat fortified cube with a glowing doorway. */
  private buildVault(b: VoxelChunkBuilder): void {
    const hw = 3;
    const hd = 3;
    const h = 5;
    for (let y = 0; y < h; y++) {
      for (let x = -hw; x <= hw; x++) {
        for (let z = -hd; z <= hd; z++) {
          const onX = Math.abs(x) === hw;
          const onZ = Math.abs(z) === hd;
          if (!onX && !onZ) continue;
          // Doorway on the front (+z) face: 2 wide, 3 tall, glowing frame.
          if (z === hd && y < 3 && Math.abs(x) <= 1) {
            if (y === 2 || Math.abs(x) === 1) b.add('glow', x, y + 0.5, z, WHITE);
            continue;
          }
          const v = voxelHash(x, y, z);
          const trim = y === 3;
          b.add(trim ? 'ivory' : 'stone', x, y + 0.5, z, trim ? ivoryColor(v) : stoneColor(v));
        }
      }
    }
    // Glow deep inside the doorway.
    for (let y = 0; y < 3; y++) {
      for (let x = -1; x <= 1; x++) b.add('glow', x, y + 0.5, hd - 1, WHITE);
    }
    // Crenellations.
    for (let x = -hw; x <= hw; x++) {
      for (let z = -hd; z <= hd; z++) {
        const onX = Math.abs(x) === hw;
        const onZ = Math.abs(z) === hd;
        if ((onX || onZ) && (x + z) % 2 === 0) {
          b.add('stone', x, h + 0.5, z, stoneColor(voxelHash(x, h, z)));
        }
      }
    }
    // Moss at the corners.
    const rng = mulberry32(551);
    for (let i = 0; i < 10; i++) {
      const sx = rng() < 0.5 ? -1 : 1;
      const sz = rng() < 0.5 ? -1 : 1;
      b.add('moss', sx * (hw + 1), 0.5 + Math.floor(rng() * 2) * 0.95, sz * (hd + 1), mossColor(rng()));
    }
  }

  /** Open observatory: ring of pillars + glowing caps, central dais. */
  private buildData(b: VoxelChunkBuilder): void {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const px = Math.cos(a) * 4;
      const pz = Math.sin(a) * 4;
      for (let y = 0; y < 5; y++) {
        const v = voxelHash(px * 3, y, pz * 3);
        b.add(y === 4 ? 'ivory' : 'stone', px, y + 0.5, pz, y === 4 ? ivoryColor(v) : stoneColor(v));
      }
      b.add('glow', px, 5.5, pz, WHITE);
    }
    for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) {
        b.add('stone', x, 0.5, z, stoneColor(voxelHash(x, 0, z)));
      }
    }
    b.add('glow', 0, 1.5, 0, WHITE);
  }

  /** Floating block voxels orbiting the observatory (one InstancedMesh). */
  private buildOrbiters(rt: ZoneRt): void {
    const rng = mulberry32(552);
    const N = 7;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.7 });
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, N);
    mesh.frustumCulled = false;
    mesh.castShadow = this.ctx.quality.shadows;
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      rt.orbiterData.push({
        r: 2.5 + rng() * 2,
        y: 6 + rng() * 2.5,
        speed: (0.25 + rng() * 0.3) * (rng() < 0.5 ? 1 : -1),
        phase: rng() * Math.PI * 2,
        size: 0.9 + rng() * 0.5,
      });
      mesh.setColorAt(i, c.set(COLORS.ivory).multiplyScalar(0.9 + rng() * 0.15));
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    rt.group.add(mesh);
    rt.orbiters = mesh;
  }

  /** Gateway arch: streams enter one side, organized fragments exit the other. */
  private buildSearch(b: VoxelChunkBuilder): void {
    for (const px of [-3, 3]) {
      for (let y = 0; y < 7; y++) {
        for (let x = -1; x <= 0; x++) {
          for (let z = -1; z <= 0; z++) {
            const v = voxelHash(px + x, y, z);
            const trim = y === 2 || y === 5;
            b.add(trim ? 'ivory' : 'stone', px + x + 0.5, y + 0.5, z + 0.5, trim ? ivoryColor(v) : stoneColor(v));
          }
        }
      }
    }
    for (let y = 7; y < 9; y++) {
      for (let x = -4; x < 4; x++) {
        for (let z = -1; z <= 0; z++) {
          const v = voxelHash(x, y, z);
          b.add(y === 8 ? 'ivory' : 'stone', x + 0.5, y + 0.5, z + 0.5, y === 8 ? ivoryColor(v) : stoneColor(v));
        }
      }
    }
    for (let x = -3; x < 4; x++) b.add('glow', x, 6.5, 0, WHITE); // lit lintel underside
    b.add('ivory', 0, 9.5, 0, ivoryColor(0.8)); // keystone
  }

  /** Plinth under the compute lattice. */
  private buildInferenceBase(b: VoxelChunkBuilder): void {
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) {
        b.add('stone', x, 0.5, z, stoneColor(voxelHash(x, 0, z)));
      }
    }
    for (const [cx, cz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]] as const) {
      b.add('glow', cx, 1.5, cz, WHITE);
    }
  }

  /** Sparse 5×5×5 voxel compute lattice with per-instance wave activation. */
  private buildLattice(rt: ZoneRt): void {
    const rng = mulberry32(777);
    const n = 5;
    const sp = 1.3;
    const cells: LatticeCell[] = [];
    for (let ix = 0; ix < n; ix++) {
      for (let iy = 0; iy < n; iy++) {
        for (let iz = 0; iz < n; iz++) {
          if (rng() < 0.36) continue;
          const x = (ix - 2) * sp;
          const y = 1.5 + iy * sp;
          const z = (iz - 2) * sp;
          cells.push({ x, y, z, dist: Math.hypot(x, y - 4.1, z) });
        }
      }
    }
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.55,
      emissive: COLORS.fungal,
      emissiveIntensity: 0,
    });
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.55, 0.55, 0.55), mat, cells.length);
    mesh.frustumCulled = false;
    const dummy = new THREE.Object3D();
    cells.forEach((c, i) => {
      dummy.position.set(c.x, c.y, c.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, this.latticeDark);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    rt.group.add(mesh);
    rt.lattice = mesh;
    rt.latticeMat = mat;
    rt.latticeCells = cells;
  }

  /** Grand tall arch gateway with steps. */
  private buildRpc(b: VoxelChunkBuilder): void {
    for (const px of [-4, 4]) {
      for (let y = 0; y < 12; y++) {
        for (let x = -1; x <= 0; x++) {
          for (let z = -1; z <= 0; z++) {
            const v = voxelHash(px + x, y, z);
            const trim = y % 3 === 2;
            b.add(trim ? 'ivory' : 'stone', px + x + 0.5, y + 0.5, z + 0.5, trim ? ivoryColor(v) : stoneColor(v));
          }
        }
      }
    }
    for (let y = 12; y < 15; y++) {
      for (let x = -5; x < 5; x++) {
        for (let z = -1; z <= 0; z++) {
          const v = voxelHash(x, y, z);
          b.add(y === 14 ? 'ivory' : 'stone', x + 0.5, y + 0.5, z + 0.5, y === 14 ? ivoryColor(v) : stoneColor(v));
        }
      }
    }
    for (let x = -4; x < 5; x++) b.add('glow', x, 11.5, 0, WHITE); // lit span underside
    // Low steps on the front (+z) side, descending away from the arch.
    for (let k = 0; k < 2; k++) {
      for (let x = -3; x <= 3; x++) {
        b.add('stone', x + 0.5, 1.5 - k, 2 + k, stoneColor(voxelHash(x, k, 11)));
      }
    }
  }

  /** Five curved connection lines between zones, merged into one geometry. */
  private buildLinks(): void {
    const pts: number[] = [];
    const SEG = 20;
    for (let i = 0; i < this.zones.length; i++) {
      const a = this.zones[i].center;
      const zb = this.zones[(i + 1) % this.zones.length].center;
      const mid = a.clone().add(zb).multiplyScalar(0.5);
      mid.y = PLAZA_TOP + 7;
      mid.add(mid.clone().setY(0).normalize().multiplyScalar(6)); // bow outward
      const curve = new THREE.QuadraticBezierCurve3(
        a.clone().setY(PLAZA_TOP + 4),
        mid,
        zb.clone().setY(PLAZA_TOP + 4),
      );
      let prev: THREE.Vector3 | null = null;
      for (let s = 0; s <= SEG; s++) {
        const p = curve.getPoint(s / SEG);
        if (prev) pts.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
        prev = p;
      }
    }
    this.lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.lineMat = new THREE.LineBasicMaterial({
      color: COLORS.fungal,
      transparent: true,
      opacity: 0.14,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(this.lineGeo, this.lineMat);
    lines.frustumCulled = false;
    this.root.add(lines);
  }

  /** One shared Points cloud (≤500) with per-zone particle behaviors. */
  private buildParticles(): void {
    const count = Math.max(50, Math.floor(500 * this.ctx.quality.particleMul));
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const tints = [
      new THREE.Color(COLORS.ivory),
      new THREE.Color(COLORS.moss),
      new THREE.Color(COLORS.fungal),
      new THREE.Color(0xffd9a0),
      new THREE.Color(COLORS.muted),
    ];
    const rng = mulberry32(31337);
    for (let i = 0; i < count; i++) {
      const zi = i % this.zones.length;
      const c = tints[zi];
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      this.pData.push({
        zone: zi,
        phase: rng(),
        speed: 0.5 + rng() * 0.8,
        seed: rng() * 100,
        life: rng(),
        ax: 0,
        ay: -100,
        az: 0,
      });
      pos[i * 3 + 1] = -100; // parked until the zone activates
    }
    this.pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.pGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.pMat = new THREE.PointsMaterial({
      size: 0.4,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.pGeo, this.pMat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.root.add(this.points);
  }

  /* ---------------- per-frame ---------------- */

  /** Zone-local (lx, ly, lz) → world, accounting for the face-center rotation. */
  private localToWorld(z: ZoneRt, lx: number, ly: number, lz: number, out: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(z.rotY);
    const s = Math.sin(z.rotY);
    out.set(z.center.x + lx * c + lz * s, PLAZA_TOP + ly, z.center.z - lx * s + lz * c);
    return out;
  }

  private updateOrbiters(t: number): void {
    for (const z of this.zones) {
      if (!z.orbiters || !z.activated) continue;
      for (let i = 0; i < z.orbiterData.length; i++) {
        const o = z.orbiterData[i];
        const a = o.phase + t * o.speed;
        this.localToWorld(
          z,
          Math.cos(a) * o.r,
          o.y + Math.sin(t * 0.7 + o.phase) * 0.4,
          Math.sin(a) * o.r,
          this.tmpV,
        );
        this.dummy.position.copy(this.tmpV);
        this.dummy.rotation.set(0, a * 0.7, 0);
        this.dummy.scale.setScalar(o.size);
        this.dummy.updateMatrix();
        z.orbiters.setMatrixAt(i, this.dummy.matrix);
      }
      z.orbiters.instanceMatrix.needsUpdate = true;
    }
  }

  private updateLattice(t: number): void {
    for (const z of this.zones) {
      if (!z.lattice || !z.activated) continue;
      for (let i = 0; i < z.latticeCells.length; i++) {
        const c = z.latticeCells[i];
        const wave = 0.5 + 0.5 * Math.sin(c.dist * 0.9 - t * 3.2);
        const k = wave * wave;
        z.lattice.setColorAt(i, this.latticeScratch.copy(this.latticeDark).lerp(this.latticeHot, k));
      }
      if (z.lattice.instanceColor) z.lattice.instanceColor.needsUpdate = true;
    }
  }

  private reseedVault(z: ZoneRt, p: Particle, rng: () => number): void {
    const a = rng() * Math.PI * 2;
    const r = 6 + rng() * 3;
    p.ax = z.center.x + Math.cos(a) * r;
    p.az = z.center.z + Math.sin(a) * r;
    p.ay = PLAZA_TOP + 2 + rng() * 7;
  }

  private updateParticles(dt: number, t: number): void {
    const posAttr = this.pGeo.getAttribute('position') as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    const door = this.tmpV;
    for (let i = 0; i < this.pData.length; i++) {
      const p = this.pData[i];
      const z = this.zones[p.zone];
      const j = i * 3;
      if (!z.activated) {
        arr[j + 1] = -100;
        continue;
      }
      const id = z.def.id;
      if (id === 'vault') {
        // Data streams INTO the glowing doorway.
        p.life += dt * 0.45 * p.speed;
        if (p.life >= 1 || p.ay < -50) {
          p.life = 0;
          this.reseedVault(z, p, Math.random);
        }
        this.localToWorld(z, 0, 1.5, 3, door);
        const k = p.life * p.life; // ease-in
        arr[j] = p.ax + (door.x - p.ax) * k;
        arr[j + 1] = p.ay + (door.y - p.ay) * k;
        arr[j + 2] = p.az + (door.z - p.az) * k;
      } else if (id === 'data') {
        // Transaction particles orbit the observatory.
        const a = p.seed + t * 0.55 * p.speed;
        const r = 5.5 + Math.sin(p.seed * 3) * 1;
        arr[j] = z.center.x + Math.cos(a) * r;
        arr[j + 1] = PLAZA_TOP + 4.5 + Math.sin(t * 0.8 + p.seed) * 1.5;
        arr[j + 2] = z.center.z + Math.sin(a) * r;
      } else if (id === 'search') {
        // Streams enter one side of the arch, exit the other, evenly spaced.
        p.life += dt * 0.32 * p.speed;
        if (p.life >= 1) p.life -= 1;
        const lx = -9 + 18 * p.life;
        const lz = (p.seed % 1) * 4 - 2;
        const ly = 1 + ((p.seed * 7) % 1) * 6;
        this.localToWorld(z, lx, ly, lz, door);
        arr[j] = door.x;
        arr[j + 1] = door.y;
        arr[j + 2] = door.z;
      } else if (id === 'inference') {
        // Sparks jitter around lattice cubes, hopping between cells.
        p.life += dt * 0.7;
        if (p.life >= 1 || p.ay < -50) {
          p.life = 0;
          const cells = z.latticeCells;
          if (cells.length > 0) {
            const c = cells[Math.floor(Math.random() * cells.length)];
            this.localToWorld(z, c.x, c.y, c.z, door);
            p.ax = door.x;
            p.ay = door.y;
            p.az = door.z;
          }
        }
        arr[j] = p.ax + Math.sin(t * 6 + p.seed) * 0.25;
        arr[j + 1] = p.ay + Math.cos(t * 5.2 + p.seed * 2) * 0.25;
        arr[j + 2] = p.az + Math.sin(t * 4.6 + p.seed * 3) * 0.25;
      } else {
        // 'rpc' — dense streams through the grand arch in both directions.
        p.life += dt * 0.4 * p.speed;
        if (p.life >= 1) p.life -= 1;
        const dir = p.seed > 50 ? 1 : -1;
        const lz = dir > 0 ? -9 + 18 * p.life : 9 - 18 * p.life;
        const lx = (((p.seed * 7) % 1) - 0.5) * 5;
        const ly = 1 + ((p.seed * 13) % 1) * 10;
        this.localToWorld(z, lx, ly, lz, door);
        arr[j] = door.x;
        arr[j + 1] = door.y;
        arr[j + 2] = door.z;
      }
    }
    posAttr.needsUpdate = true;
  }

  getZones(): ZoneInfo[] {
    return this.zones.map((z) => ({
      id: z.def.id,
      label: z.def.label,
      anchor: new THREE.Vector3(z.center.x, PLAZA_TOP + z.def.height + 3, z.center.z),
    }));
  }

  update(dt: number, t: number): void {
    // Rise (structures surface just before their activation beat).
    if (!this.riseDone) {
      if (t < PHASE.ZONES[0] - 4) {
        for (const z of this.zones) {
          z.group.visible = false;
          z.settled = false;
          z.group.position.y = PLAZA_TOP - RISE_DIST;
        }
      } else {
        let settled = 0;
        for (const z of this.zones) {
          if (z.settled) {
            settled++;
            continue;
          }
          if (t < z.riseT) {
            z.group.visible = false;
            continue;
          }
          const k = Math.min(1, (t - z.riseT) / RISE_DUR);
          z.group.visible = true;
          if (k >= 1) {
            z.group.position.y = PLAZA_TOP;
            z.settled = true;
            settled++;
          } else {
            const e = 1 - Math.pow(1 - k, 3);
            z.group.position.y = PLAZA_TOP - RISE_DIST * (1 - e);
          }
        }
        if (settled === this.zones.length) this.riseDone = true;
      }
    }

    // Activation + glow.
    const inPhase7 = t >= PHASE.ACTIVATION[0] && t <= PHASE.ACTIVATION[1];
    const wavefront = inPhase7 ? ((t - PHASE.ACTIVATION[0]) / 12) * 55 : -1;
    let waveBoost = 0;
    for (const z of this.zones) {
      if (!z.activated && t >= z.activateT) {
        z.activated = true;
        this.events.onZoneActive?.(z.def.id);
      }
      let target = z.activated ? 1.6 : 0;
      if (inPhase7 && z.activated) {
        const d = Math.hypot(z.center.x, z.center.z);
        const prox = Math.max(0, 1 - Math.abs(d - wavefront) / 6);
        if (prox > 0) {
          target += 1.6 * prox;
          waveBoost = Math.max(waveBoost, prox);
        }
      } else if (t > PHASE.LIVE[0] && z.activated) {
        target = 1.6 + Math.sin(t * 1.5 + z.def.angle * 3) * 0.25;
      }
      if (!this.reduced) {
        z.glow += (target - z.glow) * Math.min(1, dt * 3);
        z.glowMat.emissiveIntensity = z.glow;
        if (z.latticeMat) z.latticeMat.emissiveIntensity = z.glow * 0.22;
      }
    }

    // Connection lines brighten as zones activate and in phase 7.
    if (!this.reduced) {
      const actCount = this.zones.filter((z) => z.activated).length;
      const targetOp = 0.14 + actCount * 0.03 + waveBoost * 0.5;
      this.lineMat.opacity += (targetOp - this.lineMat.opacity) * Math.min(1, dt * 2);
    }

    if (!this.reduced && t >= PHASE.ZONES[0]) {
      this.updateOrbiters(t);
      if (t <= PHASE.ACTIVATION[1]) this.updateLattice(t);
      this.points.visible = true;
      this.updateParticles(dt, t);
    } else if (!this.reduced && t < PHASE.ZONES[0]) {
      this.points.visible = false;
    }
  }

  dispose(): void {
    this.ctx.scene.remove(this.root);
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    this.root.traverse((o) => {
      const anyO = o as unknown as {
        isInstancedMesh?: boolean;
        dispose?: () => void;
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };
      if (anyO.isInstancedMesh && anyO.dispose) anyO.dispose();
      if (anyO.geometry) geos.add(anyO.geometry);
      const m = anyO.material;
      if (Array.isArray(m)) {
        for (const x of m) mats.add(x);
      } else if (m) {
        mats.add(m);
      }
    });
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
  }
}
