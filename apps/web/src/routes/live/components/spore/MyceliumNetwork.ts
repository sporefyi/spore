import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { COLORS, PHASE, type LiveContext, type LiveModule } from './types';

/** Dark translucent ground tone, per the lane spec (reads as "beneath the surface"). */
const GROUND_COLOR = 0x171310;
const R_MAX = 42;
const CHUNKS = 8;
const BASE_OPACITY = 0.5;
const BRIGHT_OPACITY = 0.85;

/** Deterministic PRNG so the network is identical on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Branch {
  curve: THREE.CatmullRomCurve3;
  depth: number;
}

/**
 * Biological branching: smooth CatmullRom curves, gentle wander, children sprout
 * from mid-branch at soft angles. No sharp angles, no straight segments.
 */
function generateBranches(count: number): Branch[] {
  const rng = mulberry32(77);
  const all: Branch[] = [];

  const grow = (start: THREE.Vector3, angle: number, length: number, depth: number): void => {
    const nPts = 4 + Math.floor(rng() * 4); // 4-7 points
    const pts: THREE.Vector3[] = [];
    const p = start.clone();
    let a = angle;
    const step = length / (nPts - 1);
    for (let i = 0; i < nPts; i++) {
      pts.push(p.clone());
      a += (rng() - 0.5) * 0.7; // gentle horizontal wander
      const r = Math.hypot(p.x, p.z);
      if (r > 30) {
        // steer softly back toward the center when near the rim
        const home = Math.atan2(-p.z, -p.x);
        let d = home - a;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        a += d * 0.35;
      }
      const nx = p.x + Math.cos(a) * step;
      const nz = p.z + Math.sin(a) * step;
      const nr = Math.hypot(nx, nz);
      const cap = R_MAX - 1;
      const cx = nr > cap ? (nx / nr) * cap : nx;
      const cz = nr > cap ? (nz / nr) * cap : nz;
      const y = THREE.MathUtils.clamp(0.05 + (rng() - 0.5) * 0.22, -0.06, 0.3);
      p.set(cx, y, cz);
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    all.push({ curve, depth });
    if (depth >= 4) return;
    const kids = 2 + Math.floor(rng() * 2); // 2-3 children
    for (let k = 0; k < kids; k++) {
      const bt = 0.3 + rng() * 0.65;
      const bp = curve.getPointAt(bt);
      const tan = curve.getTangentAt(bt);
      const baseA = Math.atan2(tan.z, tan.x);
      const childA = baseA + (rng() - 0.5) * 1.8;
      const childLen = length * (0.42 + rng() * 0.3);
      grow(bp, childA, childLen, depth + 1);
    }
  };

  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 + rng() * 0.8;
    const start = new THREE.Vector3((rng() - 0.5) * 7, 0.05, (rng() - 0.5) * 7);
    grow(start, angle, 8 + rng() * 6, 0);
  }

  // Breadth-first birth order: shallow branches appear before deep ones,
  // so a capped slice still reads as one evenly grown organism.
  return all
    .map((b, i) => ({ b, i }))
    .sort((x, y) => x.b.depth - y.b.depth || x.i - y.i)
    .map((x) => x.b)
    .slice(0, count);
}

/** Soft round sprite shared by node dots and flow particles. */
function makeGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx2d = c.getContext('2d');
  if (ctx2d) {
    const g = ctx2d.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx2d.fillStyle = g;
    ctx2d.fillRect(0, 0, 128, 128);
  }
  return new THREE.CanvasTexture(c);
}

export class MyceliumNetwork implements LiveModule {
  private readonly scene: THREE.Scene;
  private readonly chunkMeshes: THREE.Mesh[] = [];
  private readonly chunkMats: THREE.MeshBasicMaterial[] = [];
  private readonly chunkGeos: THREE.BufferGeometry[] = [];
  private readonly curves: THREE.CatmullRomCurve3[] = [];
  private readonly branchBirth: number[] = [];

  private groundMesh!: THREE.Mesh;
  private groundGeo!: THREE.CircleGeometry;
  private groundMat!: THREE.MeshStandardMaterial;

  private nodePoints!: THREE.Points;
  private nodeGeo!: THREE.BufferGeometry;
  private nodeMat!: THREE.PointsMaterial;

  private flowPoints!: THREE.Points;
  private flowGeo!: THREE.BufferGeometry;
  private flowMat!: THREE.PointsMaterial;
  private flowPos: Float32Array = new Float32Array(0);
  private flowCurve: Uint16Array = new Uint16Array(0);
  private flowOffset: Float32Array = new Float32Array(0);
  private flowSpeed: Float32Array = new Float32Array(0);
  private flowCount = 0;

  private glowTex!: THREE.CanvasTexture;
  private readonly scratch = new THREE.Vector3();

  constructor(ctx: LiveContext) {
    this.scene = ctx.scene;
    const mobile = ctx.quality.tier === 'mobile';
    const branchCount = mobile ? 36 : 90;
    this.flowCount = Math.round(600 * ctx.quality.particleMul);

    const g0 = PHASE.MYCELIUM[0];
    const g1 = PHASE.MYCELIUM[1];
    this.glowTex = makeGlowTexture();

    // --- ground disc (dark translucent "surface") ---
    this.groundGeo = new THREE.CircleGeometry(60, 48);
    this.groundMat = new THREE.MeshStandardMaterial({
      color: GROUND_COLOR,
      transparent: true,
      opacity: 0,
      roughness: 1,
      metalness: 0,
      depthWrite: false,
    });
    this.groundMesh = new THREE.Mesh(this.groundGeo, this.groundMat);
    this.groundMesh.rotation.x = -Math.PI / 2;
    this.groundMesh.renderOrder = 1;
    this.scene.add(this.groundMesh);

    // --- branches, merged into chronological chunks for staggered growth ---
    const branches = generateBranches(branchCount);
    for (const b of branches) this.curves.push(b.curve);
    const perChunk = Math.ceil(branches.length / CHUNKS);
    for (let c = 0; c < CHUNKS; c++) {
      const list = branches.slice(c * perChunk, (c + 1) * perChunk);
      if (list.length === 0) continue;
      const tubes: THREE.BufferGeometry[] = [];
      for (const b of list) {
        const radius = Math.max(0.045, 0.14 - b.depth * 0.022);
        tubes.push(new THREE.TubeGeometry(b.curve, 12, radius, 5, false));
        this.branchBirth.push(g0 + (c / CHUNKS) * (g1 - g0));
      }
      const merged = mergeGeometries(tubes, false);
      for (const tg of tubes) tg.dispose();
      const mat = new THREE.MeshBasicMaterial({
        color: COLORS.moss,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(merged, mat);
      mesh.renderOrder = 2;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.chunkMeshes.push(mesh);
      this.chunkMats.push(mat);
      this.chunkGeos.push(merged);
    }

    // --- node dots at branch origins ---
    const nrng = mulberry32(7);
    const moss = new THREE.Color(COLORS.moss);
    const ivory = new THREE.Color(COLORS.ivory);
    const nodePos = new Float32Array(branches.length * 3);
    const nodeCol = new Float32Array(branches.length * 3);
    for (let i = 0; i < branches.length; i++) {
      const p0 = branches[i].curve.getPointAt(0);
      nodePos[i * 3] = p0.x;
      nodePos[i * 3 + 1] = p0.y + 0.1;
      nodePos[i * 3 + 2] = p0.z;
      const col = nrng() < 0.25 ? ivory : moss;
      nodeCol[i * 3] = col.r;
      nodeCol[i * 3 + 1] = col.g;
      nodeCol[i * 3 + 2] = col.b;
    }
    this.nodeGeo = new THREE.BufferGeometry();
    this.nodeGeo.setAttribute('position', new THREE.BufferAttribute(nodePos, 3));
    this.nodeGeo.setAttribute('color', new THREE.BufferAttribute(nodeCol, 3));
    this.nodeMat = new THREE.PointsMaterial({
      size: 0.5,
      map: this.glowTex,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.nodePoints = new THREE.Points(this.nodeGeo, this.nodeMat);
    this.nodePoints.renderOrder = 3;
    this.nodePoints.frustumCulled = false;
    this.scene.add(this.nodePoints);

    // --- flow particles travelling along the branches ---
    const frng = mulberry32(1234);
    const amber = new THREE.Color(COLORS.fungal);
    this.flowCurve = new Uint16Array(this.flowCount);
    this.flowOffset = new Float32Array(this.flowCount);
    this.flowSpeed = new Float32Array(this.flowCount);
    this.flowPos = new Float32Array(this.flowCount * 3);
    const flowCol = new Float32Array(this.flowCount * 3);
    for (let i = 0; i < this.flowCount; i++) {
      this.flowCurve[i] = Math.floor(frng() * branches.length);
      this.flowOffset[i] = frng();
      this.flowSpeed[i] = 0.02 + frng() * 0.045;
      const pick = frng();
      const col = pick < 0.5 ? moss : pick < 0.8 ? amber : ivory;
      flowCol[i * 3] = col.r;
      flowCol[i * 3 + 1] = col.g;
      flowCol[i * 3 + 2] = col.b;
      this.flowPos[i * 3 + 1] = -50; // parked until its branch grows
    }
    this.flowGeo = new THREE.BufferGeometry();
    this.flowGeo.setAttribute('position', new THREE.BufferAttribute(this.flowPos, 3));
    this.flowGeo.setAttribute('color', new THREE.BufferAttribute(flowCol, 3));
    this.flowMat = new THREE.PointsMaterial({
      size: 0.28,
      map: this.glowTex,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.flowPoints = new THREE.Points(this.flowGeo, this.flowMat);
    this.flowPoints.renderOrder = 3;
    this.flowPoints.frustumCulled = false;
    this.scene.add(this.flowPoints);
  }

  update(_dt: number, t: number): void {
    const g0 = PHASE.MYCELIUM[0];
    const g1 = PHASE.MYCELIUM[1];
    const a0 = PHASE.ACTIVATION[0];
    const a1 = PHASE.ACTIVATION[1];
    const n = this.chunkMats.length;

    // staggered growth across the MYCELIUM phase
    let grown = 0;
    for (let i = 0; i < n; i++) {
      const start = g0 + (i / n) * (g1 - g0);
      const k = THREE.MathUtils.clamp((t - start) / 2.2, 0, 1);
      const e = k * k * (3 - 2 * k);
      grown += e;
      let op = e * BASE_OPACITY;
      if (t >= a0 && t < a1) {
        const b = (t - a0) / (a1 - a0);
        op = THREE.MathUtils.lerp(op, BRIGHT_OPACITY, b);
      } else if (t >= a1) {
        op = BRIGHT_OPACITY * (1 + 0.07 * Math.sin(t * 0.8));
      }
      this.chunkMats[i].opacity = op;
    }
    const growthAll = n > 0 ? grown / n : 0;

    // ground fades in during DARKNESS; dots + flow follow the growth
    this.groundMat.opacity = 0.82 * THREE.MathUtils.clamp(t / 4, 0, 1);
    this.nodeMat.opacity = 0.9 * growthAll;
    this.flowMat.opacity = Math.min(1, 0.8 * growthAll * (t >= a0 ? 1.2 : 1));

    // flow particles crawl along their branch once it has grown
    const pos = this.flowPos;
    for (let i = 0; i < this.flowCount; i++) {
      const bi = this.flowCurve[i];
      const age = t - this.branchBirth[bi];
      const j = i * 3;
      if (age <= 0) {
        pos[j + 1] = -50;
        continue;
      }
      const u = (this.flowOffset[i] + age * this.flowSpeed[i]) % 1;
      const pt = this.curves[bi].getPointAt(u, this.scratch);
      pos[j] = pt.x;
      pos[j + 1] = pt.y + 0.12;
      pos[j + 2] = pt.z;
    }
    this.flowGeo.attributes.position.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.groundMesh);
    this.groundGeo.dispose();
    this.groundMat.dispose();
    for (const m of this.chunkMeshes) this.scene.remove(m);
    for (const g of this.chunkGeos) g.dispose();
    for (const m of this.chunkMats) m.dispose();
    this.scene.remove(this.nodePoints);
    this.nodeGeo.dispose();
    this.nodeMat.dispose();
    this.scene.remove(this.flowPoints);
    this.flowGeo.dispose();
    this.flowMat.dispose();
    this.glowTex.dispose();
  }
}
