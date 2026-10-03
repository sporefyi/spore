export interface Voxel { pos: [number, number, number]; color: string; size?: number }
export interface VoxelModel { capGreen: Voxel[]; capSpots: Voxel[]; capRim: Voxel[]; gills: Voxel[]; stem: Voxel[]; miniMushrooms: Voxel[]; moss: Voxel[]; ground: Voxel[]; spores: Voxel[] }

export type Detail = 'high' | 'low';
type Rng = () => number;

const DOME_R = 12;
const DOME_H = 8.5;
const STEM_TOP = 11;

// ---------- RNG / noise ----------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^
    Math.imul(iz | 0, 2147483647) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function vnoise(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = smooth(x - x0), fy = smooth(y - y0), fz = smooth(z - z0);
  const c = (dx: number, dy: number, dz: number): number =>
    hash3(x0 + dx, y0 + dy, z0 + dz, seed);
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), fx);
  const x10 = lerp(c(0, 1, 0), c(1, 1, 0), fx);
  const x01 = lerp(c(0, 0, 1), c(1, 0, 1), fx);
  const x11 = lerp(c(0, 1, 1), c(1, 1, 1), fx);
  return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz);
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
}

function pickByNoise<T>(arr: readonly T[], n: number): T {
  return arr[Math.max(0, Math.min(arr.length - 1, Math.floor(n * arr.length)))];
}

// ---------- palettes ----------

export const CAP_GREENS = ['#2f5b38', '#356a42', '#2a5535', '#3d7a48'] as const;
export const CREAM_SPOTS = ['#e8dcc0', '#dccba8', '#efe6cc'] as const;
export const RIM_COLORS = ['#e6dcc4', '#d9cfb4', '#eee4cc'] as const;
export const GILL_COLORS = ['#b8411f', '#c8551f', '#d1652c', '#dd823f', '#e8a05a'] as const;
export const STEM_COLORS = ['#ece2c8', '#e2d5b4', '#f2ead6'] as const;
export const STEM_EDGE_COLORS = ['#cfc29f', '#c4b690'] as const;

// ---------- geometry helpers ----------

function domeY(r: number): number {
  const q = r / DOME_R;
  return STEM_TOP + DOME_H * Math.sqrt(Math.max(0, 1 - q * q));
}

function capSurface(x: number, z: number): number {
  const r = Math.sqrt(x * x + z * z);
  const undul = (vnoise(x * 0.3, 0.5, z * 0.3, 3) - 0.5) * 1.2;
  return domeY(r) + undul;
}

function vox(x: number, y: number, z: number, color: string, size?: number): Voxel {
  return size === undefined ? { pos: [x, y, z], color } : { pos: [x, y, z], color, size };
}

// ---------- builders ----------

export function buildCap(rng: Rng, detail: Detail): Voxel[] {
  void rng;
  const out: Voxel[] = [];
  const shellDepth = detail === 'high' ? 2 : 1;
  for (let x = -DOME_R; x <= DOME_R; x++) {
    for (let z = -DOME_R; z <= DOME_R; z++) {
      const r = Math.sqrt(x * x + z * z);
      if (r > DOME_R) continue;
      const fy = Math.floor(capSurface(x, z));
      for (let y = fy - shellDepth; y <= fy; y++) {
        if (detail === 'high' && vnoise(x * 0.5, y * 0.5, z * 0.5, 11) > 0.985) continue;
        const n = vnoise(x * 0.25, y * 0.25, z * 0.25, 1);
        out.push(vox(x, y, z, pickByNoise(CAP_GREENS, n)));
      }
    }
  }
  return out;
}

function growBlob(cx: number, cz: number, out: Voxel[]): void {
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      const x = cx + dx, z = cz + dz;
      const lim = 2 + vnoise(x * 0.7, 0, z * 0.7, 4) * 2;
      if (dx * dx + dz * dz >= lim * lim) continue;
      if (vnoise(x * 0.8, 1.3, z * 0.8, 6) >= 0.7) continue;
      if (Math.sqrt(x * x + z * z) > DOME_R - 0.3) continue;
      const y = Math.floor(capSurface(x, z)) + 1;
      const n = vnoise(x * 0.6, y * 0.6, z * 0.6, 8);
      out.push(vox(x, y, z, pickByNoise(CREAM_SPOTS, n)));
    }
  }
}

function sparseSingles(rng: Rng, count: number, out: Voxel[]): void {
  for (let i = 0; i < count; i++) {
    const x = Math.round((rng() - 0.5) * DOME_R * 2);
    const z = Math.round((rng() - 0.5) * DOME_R * 2);
    if (Math.sqrt(x * x + z * z) > DOME_R - 0.3) continue;
    if (vnoise(x * 0.9, 3.7, z * 0.9, 7) <= 0.93) continue;
    const y = Math.floor(capSurface(x, z)) + 1;
    out.push(vox(x, y, z, pick(rng, CREAM_SPOTS)));
  }
}

export function buildSpots(rng: Rng, detail: Detail): Voxel[] {
  const out: Voxel[] = [];
  for (let i = 0; i < 7; i++) {
    const a = rng() * Math.PI * 2;
    const rr = 3.5 + rng() * 6.5;
    growBlob(Math.round(Math.cos(a) * rr), Math.round(Math.sin(a) * rr), out);
  }
  sparseSingles(rng, detail === 'high' ? 40 : 20, out);
  return out;
}

export function buildRim(rng: Rng): Voxel[] {
  void rng;
  const out: Voxel[] = [];
  const rimR = DOME_R - 0.2;
  const y = Math.floor(domeY(rimR)) - 2;
  for (let a = 0; a < Math.PI * 2; a += 0.12) {
    const x = Math.round(Math.cos(a) * rimR);
    const z = Math.round(Math.sin(a) * rimR);
    const n = vnoise(x * 0.6, y * 0.6, z * 0.6, 12);
    out.push(vox(x, y, z, pickByNoise(RIM_COLORS, n)));
  }
  return out;
}

const GILL_INNER = 2.4;
const GILL_OUTER = DOME_R * 0.92;

function gillColor(r: number): string {
  const t = Math.max(0, Math.min(1, (r - GILL_INNER) / (GILL_OUTER - GILL_INNER)));
  return GILL_COLORS[Math.round(t * (GILL_COLORS.length - 1))];
}

export function buildGills(rng: Rng, detail: Detail): Voxel[] {
  const out: Voxel[] = [];
  const n = detail === 'high' ? 64 : 28;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (rng() - 0.5) * 0.08;
    if (rng() < 0.12) continue;
    for (let r = GILL_INNER; r < GILL_OUTER; r += 0.7) {
      const x = Math.round(Math.cos(a) * r);
      const z = Math.round(Math.sin(a) * r);
      const y = Math.floor(domeY(r));
      const h = 1 + (vnoise(a * 3, r * 0.4, 1.1, 5) > 0.5 ? 1 : 0);
      const color = gillColor(r);
      for (let k = 0; k < h; k++) out.push(vox(x, y - 3 + k, z, color));
    }
  }
  return out;
}

export function buildStem(rng: Rng): Voxel[] {
  void rng;
  const out: Voxel[] = [];
  for (let y = 1; y <= 11; y++) {
    const t = (y - 1) / 10;
    const radius = 3.2 - 0.9 * t;
    const cx = vnoise(0, y * 0.35, 0, 9) * 1.6 - 0.8;
    const cz = vnoise(5, y * 0.35, 2, 9) * 1.6 - 0.8;
    const inner = (radius - 0.8) * (radius - 0.8);
    for (let x = -4; x <= 4; x++) {
      for (let z = -4; z <= 4; z++) {
        const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
        if (d2 >= radius * radius) continue;
        const n = vnoise(x * 0.5, y * 0.5, z * 0.5, 10);
        const palette = d2 > inner ? STEM_EDGE_COLORS : STEM_COLORS;
        out.push(vox(x, y, z, pickByNoise(palette, n)));
      }
    }
  }
  return out;
}

export function buildMiniMushrooms(rng: Rng, detail: Detail): Voxel[] {
  const out: Voxel[] = [];
  const count = detail === 'high' ? 7 : 3;
  const reds = ['#c0392b', '#d14a30', '#a93226'];
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2;
    const dist = 4.5 + rng() * 4;
    const bx = Math.round(Math.cos(a) * dist);
    const bz = Math.round(Math.sin(a) * dist);
    const sh = 2 + Math.floor(rng() * 3);
    for (let y = 1; y <= sh; y++) out.push(vox(bx, y, bz, '#e8dcc0'));
    const cr = 2 + Math.floor(rng() * 2);
    const miniDomeY = (dx: number, dz: number) =>
      sh + 1 + Math.floor(Math.sqrt(Math.max(0, cr * cr - dx * dx - dz * dz)) * 0.7);
    for (let dx = -cr; dx <= cr; dx++) {
      for (let dz = -cr; dz <= cr; dz++) {
        if (dx * dx + dz * dz <= cr * cr) {
          const y = miniDomeY(dx, dz);
          out.push(vox(bx + dx, y, bz + dz, pickByNoise(reds, vnoise(bx + dx, y, bz + dz, 11))));
        }
      }
    }
    for (let d = 0; d < 4; d++) {
      let dx = 0;
      let dz = 0;
      for (let attempt = 0; attempt < 8; attempt++) {
        const tx = Math.floor(rng() * (2 * cr + 1)) - cr;
        const tz = Math.floor(rng() * (2 * cr + 1)) - cr;
        if (tx * tx + tz * tz <= cr * cr) {
          dx = tx;
          dz = tz;
          break;
        }
      }
      const capTopY = miniDomeY(dx, dz);
      out.push(vox(bx + dx, capTopY + 1, bz + dz, '#f2ead6', 0.5));
    }
  }
  return out;
}

export function buildMoss(rng: Rng, detail: Detail): Voxel[] {
  const out: Voxel[] = [];
  const clumps = detail === 'high' ? 16 : 7;
  const greens = ['#3f7a3f', '#4c8a46', '#35662f', '#5a9a4e'];
  for (let i = 0; i < clumps; i++) {
    const a = rng() * Math.PI * 2;
    const dist = 4 + rng() * 7;
    const cx = Math.round(Math.cos(a) * dist);
    const cz = Math.round(Math.sin(a) * dist);
    const w = 2 + Math.floor(rng() * 3);
    const h = 1 + Math.floor(rng() * 3);
    const lim = (w * 0.75) * (w * 0.75);
    for (let dx = -w; dx <= w; dx++) {
      for (let dz = -w; dz <= w; dz++) {
        for (let dy = 0; dy <= h - 1; dy++) {
          if (
            dx * dx + dz * dz + dy * dy * 2.2 < lim &&
            vnoise(cx + dx, dy, cz + dz, 21) < 0.72
          ) {
            out.push(
              vox(
                cx + dx,
                dy + 1,
                cz + dz,
                pickByNoise(greens, vnoise(cx + dx, dy + 1, cz + dz, 22))
              )
            );
          }
        }
      }
    }
  }
  for (let a = 0; a < Math.PI * 2; a += 0.35) {
    const x = Math.round(Math.cos(a) * 3.4);
    const z = Math.round(Math.sin(a) * 3.4);
    out.push(vox(x, 1, z, pickByNoise(greens, vnoise(x, 1, z, 23))));
    if (rng() < 0.5) {
      out.push(vox(x, 2, z, pickByNoise(greens, vnoise(x, 2, z, 24))));
    }
  }
  return out;
}

export function buildGround(rng: Rng, detail: Detail): Voxel[] {
  const out: Voxel[] = [];
  const half = detail === 'high' ? 13 : 11;
  const slabBottom = detail === 'high' ? -4 : -3;
  const stone = ['#3a3733', '#44403a', '#2e2b27', '#4e4a44'];
  const stoneTop = ['#4e4a44', '#58534b', '#44403a', '#4a463f'];
  for (let x = -half; x <= half; x++) {
    for (let z = -half; z <= half; z++) {
      const r = Math.sqrt(x * x + z * z);
      const edge = half - 1 + vnoise(x * 0.3, 0, z * 0.3, 31) * 3 - 1.5;
      if (r > edge) continue;
      for (let y = slabBottom; y <= -1; y++) {
        out.push(vox(x, y, z, pickByNoise(stone, vnoise(x, y, z, 33))));
      }
      const ty = vnoise(x * 0.45, 7, z * 0.45, 32) > 0.82 ? 1 : 0;
      if (r > edge - 1.5 && rng() < 0.4) continue;
      out.push(vox(x, ty, z, pickByNoise(stoneTop, vnoise(x, ty, z, 34))));
    }
  }
  for (let i = 0; i < 10; i++) {
    const a = rng() * Math.PI * 2;
    const d = half - 1 + rng() * 2;
    const x = Math.round(Math.cos(a) * d);
    const z = Math.round(Math.sin(a) * d);
    out.push(vox(x, 0, z, pickByNoise(stone, vnoise(x, 0, z, 35))));
  }
  return out;
}

export function buildSpores(rng: Rng, detail: Detail): Voxel[] {
  const out: Voxel[] = [];
  const count = detail === 'high' ? 90 : 28;
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2;
    const rr = 6 + rng() * 9;
    const y = 12 + rng() * 10;
    const color = rng() < 0.5 ? '#f0e6cc' : '#e2d5b4';
    const size = 0.35 + rng() * 0.2;
    out.push(vox(Math.cos(a) * rr, y, Math.sin(a) * rr, color, size));
  }
  return out;
}

export function buildModel(detail: Detail): VoxelModel {
  const rng = mulberry32(1337);
  return {
    capGreen: buildCap(rng, detail),
    capSpots: buildSpots(rng, detail),
    capRim: buildRim(rng),
    gills: buildGills(rng, detail),
    stem: buildStem(rng),
    miniMushrooms: buildMiniMushrooms(rng, detail),
    moss: buildMoss(rng, detail),
    ground: buildGround(rng, detail),
    spores: buildSpores(rng, detail),
  };
}
