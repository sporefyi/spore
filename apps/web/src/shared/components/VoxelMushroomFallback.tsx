const W = 120;
const H = 140;
const C = 4;

const grid = new Map<number, string>();
const paint = (x: number, y: number, c: string): void => {
  if (x >= 0 && x < W && y >= 0 && y < H) grid.set(y * W + x, c);
};
const hash = (x: number, y: number): number => (x * 7 + y * 13) % 5;

const lerpHex = (a: string, b: string, t: number): string => {
  const p = (s: string, i: number) => parseInt(s.slice(1 + i * 2, 3 + i * 2), 16);
  const k = Math.max(0, Math.min(1, t));
  const ch = (i: number) =>
    Math.round(p(a, i) + (p(b, i) - p(a, i)) * k)
      .toString(16)
      .padStart(2, "0");
  return `#${ch(0)}${ch(1)}${ch(2)}`;
};

const domeHalf = (y: number): number => {
  const t = Math.min(1, (y - 20) / 36);
  const base = 12 + 34 * Math.sqrt(1 - (1 - t) * (1 - t));
  const wobble = y < 60 ? ((y * 7) % 3) - 1 : -Math.floor((y - 59) / 2);
  return Math.round(base) + wobble;
};

function build(): void {
  // Ground slab
  for (let y = 128; y < 136; y++) {
    const edge = y === 128 || y === 135 ? 4 : y === 129 || y === 134 ? 2 : 0;
    const l = 18 + edge + ((y * 7) % 3);
    const r = 102 - edge - ((y * 5) % 3);
    for (let x = l; x <= r; x++) paint(x, y, hash(x, y) % 2 ? "#3a3733" : "#44403a");
  }
  // Stem
  for (let y = 70; y < 128; y++) {
    const half = y < 90 ? 4 : 5;
    for (let x = 60 - half; x <= 60 + half; x++) {
      const edge = x === 60 - half || x === 60 + half;
      paint(x, y, edge || (x * 3 + y) % 11 === 0 ? "#e2d5b4" : "#ece2c8");
    }
  }
  // Moss
  const mossRanges: Array<[number, number]> = [[20, 40], [60, 75], [85, 100]];
  mossRanges.forEach(([a, b]) => {
    for (let x = a; x <= b; x++) {
      if ((x * 5) % 3 === 0) continue;
      const h = 1 + ((x * 7 + 3) % 5);
      for (let y = 128 - Math.min(h, 6); y < 128; y++)
        paint(x, y, (x + y) % 2 ? "#3f7a3f" : "#4c8a46");
    }
  });
  // Gills
  for (let y = 64; y <= 72; y++) {
    const half = 2 + Math.round((72 - y) * 3.5);
    for (let x = 60 - half; x <= 60 + half; x++) {
      if ((x * 3 + y) % 7 === 0) continue;
      paint(x, y, lerpHex("#b8411f", "#e8a05a", Math.abs(x - 60) / 30));
    }
  }
  // Cap
  const greens = ["#2f5b38", "#356a42", "#2a5535"];
  for (let y = 20; y < 64; y++) {
    const half = domeHalf(y);
    for (let x = 60 - half; x < 60 + half; x++) {
      const edge = x === 60 - half || x === 60 + half - 1;
      paint(x, y, edge ? "#2a5535" : greens[hash(x, y) % 3]);
    }
  }
  // Rim
  for (let y = 64; y <= 65; y++) {
    const half = domeHalf(63) - (y - 64);
    for (let x = 60 - half; x < 60 + half; x++) paint(x, y, "#e6dcc4");
  }
  // Spots
  const spots: Array<[number, number]> = [
    [40, 32], [70, 26], [88, 44], [30, 48], [58, 40], [78, 58], [48, 56], [95, 60],
  ];
  spots.forEach(([cx, cy]) => {
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx * dx + dz * dz > 2) continue;
        const x = cx + dx;
        const y = cy + dz;
        if ((dx || dz) && hash(x, y) === 0) continue;
        if (grid.has(y * W + x) && y < 64)
          paint(x, y, hash(x, y) % 2 ? "#e8dcc0" : "#dccba8");
      }
  });
  // Mini mushrooms
  [28, 78, 95].forEach((x) => {
    for (let y = 126; y < 128; y++) for (let dx = 0; dx < 2; dx++) paint(x + dx, y, "#ece2c8");
    for (let dx = -2; dx <= 3; dx++) paint(x + dx, 125, "#c0392b");
    for (let dx = -1; dx <= 2; dx++) paint(x + dx, 124, "#c0392b");
    paint(x, 124, "#e8dcc0");
  });
  // Spores
  for (let i = 0; i < 10; i++) {
    const sx = 32 + i * 6 + ((i * 7) % 4);
    const sy = 4 + ((i * 5) % 12);
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) paint(sx + dx, sy + dy, "#f0e6cc");
  }
}

interface Run {
  x: number;
  y: number;
  w: number;
  fill: string;
}

function toRuns(): Run[] {
  build();
  const runs: Run[] = [];
  for (let y = 0; y < H; y++) {
    let cur: Run | null = null;
    for (let x = 0; x < W; x++) {
      const fill = grid.get(y * W + x);
      if (fill && cur && cur.fill === fill && cur.x + cur.w === x) {
        cur.w++;
      } else if (fill) {
        cur = { x, y, w: 1, fill };
        runs.push(cur);
      } else {
        cur = null;
      }
    }
  }
  return runs;
}

const RUNS = toRuns();

export default function VoxelMushroomFallback({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${W * C} ${H * C}`}
      role="img"
      aria-label="Voxel mushroom"
      shapeRendering="crispEdges"
      preserveAspectRatio="xMidYMid meet"
      style={{ width: "100%", height: "100%", display: "block" }}
    >
      {RUNS.map((r, i) => (
        <rect key={i} x={r.x * C} y={r.y * C} width={r.w * C} height={C} fill={r.fill} />
      ))}
    </svg>
  );
}
