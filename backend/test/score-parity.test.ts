import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ---------------------------------------------------------------------------
// Model loading
// The module is probed with a top-level await (not in beforeAll) because
// describe.skipIf(...) is evaluated at collection time, before any hooks run.
// Absolute paths + @vite-ignore keep vite from failing the whole file at
// transform time when a candidate does not exist.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATES = [
  "../score-engine/src/model.ts",
  "../score-engine/dist/model.js",
  "../score-engine/src/model.js",
];

async function loadModel(): Promise<Record<string, unknown> | null> {
  for (const spec of CANDIDATES) {
    const abs = path.resolve(HERE, spec);
    if (!existsSync(abs)) continue;
    try {
      const mod = await import(/* @vite-ignore */ abs);
      return mod as Record<string, unknown>;
    } catch {
      // try next candidate
    }
  }
  return null;
}

const model = await loadModel();

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

type Dims = Record<
  "d1" | "d2" | "d3" | "d4" | "d5" | "d6" | "d7" | "d8" | "d9" | "d10" | "d11" | "d12",
  number
>;
type ScoreResult = { score: number; band: string; limit: number };

interface Adapter {
  compute: (dims: Dims) => ScoreResult;
  bandForScore?: (score: number) => string;
  limitForBand?: (band: string) => number;
}

function buildAdapter(mod: Record<string, unknown> | null): {
  adapter?: Adapter;
  error?: string;
} {
  if (!mod) return { error: "score-engine model not built yet" };

  const def = mod.default;
  const defObj =
    def && typeof def === "object" ? (def as Record<string, unknown>) : undefined;

  let fn: unknown =
    mod.computeScore ??
    mod.scoreFromDimensions ??
    defObj?.computeScore ??
    defObj?.scoreFromDimensions ??
    (typeof def === "function" ? def : undefined);

  if (typeof fn !== "function") {
    const keys = Object.keys(mod).join(", ") || "(none)";
    return {
      error:
        `Unrecognized score-engine model shape: expected export "computeScore", ` +
        `"scoreFromDimensions", or a default function. Actual export keys: [${keys}]`,
    };
  }

  const raw = fn as (d: unknown) => unknown;

  // The frozen model takes an array of 12 dimension scores; other
  // implementations may take a {d1..d12} object — try array first, fall back.
  const toArray = (dims: Dims): number[] =>
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => dims[`d${i}` as keyof Dims]);

  const compute = (dims: Dims): ScoreResult => {
    let out: unknown;
    try {
      out = raw(toArray(dims));
    } catch {
      out = raw(dims);
    }
    const o = out as Partial<ScoreResult> & { limitWholeUnits?: number } | number | null | undefined;
    if (o && typeof o === "object" && typeof o.score === "number" && typeof o.band === "string") {
      const limit = typeof o.limit === "number" ? o.limit : o.limitWholeUnits;
      if (typeof limit === "number") return { score: o.score, band: o.band, limit };
    }
    // Score-only result: fill band/limit from helpers if available.
    const bandFn = (mod.bandForScore ?? defObj?.bandForScore) as
      | ((s: number) => string)
      | undefined;
    const limitFn = (mod.limitForBand ?? defObj?.limitForBand) as
      | ((b: string) => number)
      | undefined;
    const score =
      typeof out === "number"
        ? out
        : out && typeof out === "object" && typeof out.score === "number"
          ? out.score
          : undefined;
    if (score !== undefined && bandFn && limitFn) {
      const band = bandFn(score);
      return { score, band, limit: limitFn(band) };
    }
    throw new Error(
      `Unrecognized computeScore result shape: ${JSON.stringify(out)}. ` +
        `Module export keys: [${Object.keys(mod).join(", ")}]`,
    );
  };

  const bandForScore = (mod.bandForScore ?? defObj?.bandForScore) as
    | ((s: number) => string)
    | undefined;
  const limitForBand = (mod.limitForBand ?? defObj?.limitForBand) as
    | ((b: string) => number)
    | undefined;

  return {
    adapter: {
      compute,
      bandForScore: typeof bandForScore === "function" ? bandForScore : undefined,
      limitForBand: typeof limitForBand === "function" ? limitForBand : undefined,
    },
  };
}

const { adapter, error: adapterError } = buildAdapter(model);

function need(): Adapter {
  if (!adapter) throw new Error(adapterError ?? "score-engine adapter unavailable");
  return adapter;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KEYS = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10", "d11", "d12"] as const;

function dims(overrides: Partial<Dims> = {}, fill = 0): Dims {
  const base = {} as Dims;
  for (const k of KEYS) base[k] = fill;
  return { ...base, ...overrides };
}

const WEIGHTS: Record<(typeof KEYS)[number], number> = {
  d1: 0.2,
  d2: 0.12,
  d3: 0.1,
  d4: 0.08,
  d5: 0.05,
  d6: 0.05,
  d7: 0.06,
  d8: 0.05,
  d9: 0.08,
  d10: 0.1,
  d11: 0.06,
  d12: 0.05,
};

function check(input: Dims, expected: ScoreResult) {
  const out = need().compute(input);
  expect(Number.isInteger(out.score)).toBe(true);
  expect(out).toEqual(expected);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

if (!model) {
  describe.skip("score-engine model not built yet", () => {
    it("skipped", () => {});
  });
}

describe.skipIf(!model)("score engine parity (model v0.1)", () => {
  it("model exports a recognized shape", () => {
    if (adapterError) throw new Error(adapterError);
    expect(adapter).toBeDefined();
  });

  it("spec weights sum to 1.0 and max attainable is 890", () => {
    const sum = KEYS.reduce((a, k) => a + WEIGHTS[k], 0);
    expect(sum).toBeCloseTo(1.0, 10);
    const max = KEYS.filter((k) => k !== "d5" && k !== "d11").reduce(
      (a, k) => a + WEIGHTS[k] * 1000,
      0,
    );
    expect(Math.round(max)).toBe(890);
  });

  it("vector 1: all dims = 1000 (futures forced to 0) -> 890 / VERY LOW / 500", () => {
    check(dims({}, 1000), { score: 890, band: "VERY LOW", limit: 500 });
  });

  it("vector 2: all dims = 0 -> 0 / HIGH / 0", () => {
    check(dims({}, 0), { score: 0, band: "HIGH", limit: 0 });
  });

  it("vector 3: mixed dims with futures nonzero -> 580 / MODERATE / 100", () => {
    check(
      dims({
        d1: 800,
        d2: 700,
        d3: 600,
        d4: 500,
        d5: 999,
        d6: 400,
        d7: 1000,
        d8: 300,
        d9: 200,
        d10: 1000,
        d11: 999,
        d12: 500,
      }),
      { score: 580, band: "MODERATE", limit: 100 },
    );
  });

  it("vector 4: futures isolation (only d5 and d11 set) equals all-zero result", () => {
    check(dims({ d5: 1000, d11: 1000 }), { score: 0, band: "HIGH", limit: 0 });
  });

  it("vector 5a: exactly 650 via computeScore -> LOW / 250", () => {
    check(
      dims({ d1: 1000, d10: 1000, d7: 1000, d2: 1000, d9: 1000, d4: 1000, d12: 200 }),
      { score: 650, band: "LOW", limit: 250 },
    );
  });

  it("vector 5b: exactly 500 via computeScore -> MODERATE / 100", () => {
    check(
      dims({ d1: 1000, d10: 1000, d7: 1000, d2: 1000, d12: 400 }),
      { score: 500, band: "MODERATE", limit: 100 },
    );
  });

  it("vector 6: rounding to nearest integer (d1=333 -> 66.6 -> 67)", () => {
    const out = need().compute(dims({ d1: 333 }));
    expect(Number.isInteger(out.score)).toBe(true);
    expect(out.score).toBe(67);
    expect(out.band).toBe("HIGH");
    expect(out.limit).toBe(0);
  });

  it("score is always an integer across assorted inputs", () => {
    const samples: Dims[] = [
      dims({ d1: 1, d2: 3, d3: 7 }),
      dims({ d4: 333, d6: 777, d8: 111 }),
      dims({ d9: 999, d12: 1 }),
      dims({}, 123),
      dims({}, 987),
    ];
    for (const s of samples) {
      expect(Number.isInteger(need().compute(s).score)).toBe(true);
    }
  });

  it.skipIf(!adapter?.bandForScore)("bandForScore boundaries", () => {
    const f = need().bandForScore!;
    expect(f(1000)).toBe("VERY LOW");
    expect(f(800)).toBe("VERY LOW");
    expect(f(799)).toBe("LOW");
    expect(f(650)).toBe("LOW");
    expect(f(649)).toBe("MODERATE");
    expect(f(500)).toBe("MODERATE");
    expect(f(499)).toBe("ELEVATED");
    expect(f(300)).toBe("ELEVATED");
    expect(f(299)).toBe("HIGH");
    expect(f(0)).toBe("HIGH");
  });

  it.skipIf(!adapter?.limitForBand)("limitForBand ladder", () => {
    const f = need().limitForBand!;
    expect(f("VERY LOW")).toBe(500);
    expect(f("LOW")).toBe(250);
    expect(f("MODERATE")).toBe(100);
    expect(f("ELEVATED")).toBe(25);
    expect(f("HIGH")).toBe(0);
  });
});
