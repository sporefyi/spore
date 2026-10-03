import { describe, it, expect } from 'vitest';
import {
  WEIGHTS,
  MODEL_VERSION,
  LIMIT_LADDER,
  BAND_FLOORS,
  FUTURE_DIMS,
  d1RepaymentHistory,
  d2Punctuality,
  d3Utilization,
  d4RevenueConsistency,
  d5RevenueGrowth,
  d6AgentAge,
  d7IdentityContinuity,
  d8CrossChain,
  d9PaymentVolume,
  d10DefaultHistory,
  d11SponsorQuality,
  d12Concentration,
  computeDimensions,
  computeScore,
  type DimensionInputs,
} from './model.js';

const DAY = 86400000;
const t0 = 1_700_000_000_000;

describe('model', () => {
  it('weights sum to 1.0', () => {
    const sum = (WEIGHTS as readonly number[]).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-12);
    expect(MODEL_VERSION).toBe(1);
    expect(FUTURE_DIMS).toEqual([4, 10]);
    expect(LIMIT_LADDER).toBeDefined();
    expect(BAND_FLOORS).toBeDefined();
  });

  it('parity vectors from SCORING_IMPL.md', () => {
    expect(computeScore(Array(12).fill(1000))).toMatchObject({
      score: 890,
      band: 'VERY LOW',
      limitWholeUnits: 500,
    });
    expect(computeScore(Array(12).fill(0))).toMatchObject({
      score: 0,
      band: 'HIGH',
      limitWholeUnits: 0,
    });
    const a = Array(12).fill(1000);
    a[4] = 1000;
    a[10] = 1000;
    expect(computeScore(a)).toMatchObject({ score: 890 });
    const b = Array(12).fill(0);
    b[4] = 1000;
    b[10] = 1000;
    expect(computeScore(b)).toMatchObject({ score: 0 });
  });

  it('matches the frontend ScoreLab formula', () => {
    // mirrors apps/web ScoreLab.tsx
    const w = WEIGHTS as readonly number[];
    const labBandOf = (s: number): string =>
      s >= 800 ? 'VERY LOW' : s >= 650 ? 'LOW' : s >= 500 ? 'MODERATE' : s >= 300 ? 'ELEVATED' : 'HIGH';
    const labLimits: Record<string, number> = {
      'VERY LOW': 500,
      LOW: 250,
      MODERATE: 100,
      ELEVATED: 25,
      HIGH: 0,
    };
    const lab = (x: number[]) => {
      let s = 0;
      for (let i = 0; i < 12; i++) {
        if (i === 4 || i === 10) continue;
        s += w[i]! * x[i]!;
      }
      const score = Math.round(Math.round(s * 10) / 10);
      const band = labBandOf(score);
      return { score, band, limitWholeUnits: labLimits[band]! };
    };

    const vectors: number[][] = [Array(12).fill(1000), Array(12).fill(0)];
    let x = 42;
    for (let n = 0; n < 300; n++) {
      const v: number[] = [];
      for (let i = 0; i < 12; i++) {
        x = (x * 1664525 + 1013904223) >>> 0;
        v.push(x % 1001);
      }
      vectors.push(v);
    }
    for (const v of vectors) {
      const got = computeScore(v);
      const exp = lab(v);
      expect(got.score).toBe(exp.score);
      expect(got.band).toBe(exp.band);
      expect(got.limitWholeUnits).toBe(exp.limitWholeUnits);
    }
  });

  it('computeScore validates input', () => {
    expect(() => computeScore(Array(11).fill(500))).toThrow(RangeError);
    const nan = Array(12).fill(500);
    nan[3] = NaN;
    expect(() => computeScore(nan)).toThrow(RangeError);
    const inf = Array(12).fill(500);
    inf[7] = Infinity;
    expect(() => computeScore(inf)).toThrow(RangeError);
  });

  it('d1 edge cases', () => {
    expect(d1RepaymentHistory(0n, 0n)).toBe(400);
    expect(d1RepaymentHistory(100n, 0n)).toBe(0);
    expect(d1RepaymentHistory(100n, 50n)).toBe(500);
    expect(d1RepaymentHistory(3n, 1n)).toBe(333);
    expect(d1RepaymentHistory(100n, 250n)).toBe(1000);
  });

  it('d2 edge cases', () => {
    expect(d2Punctuality([], [])).toBe(500);
    expect(d2Punctuality([{ amount: 100n, timeMs: t0 }], [])).toBe(500);
    expect(
      d2Punctuality([{ amount: 100n, timeMs: t0 }], [{ amount: 100n, timeMs: t0 + 10 * DAY }]),
    ).toBe(1000);
    expect(
      d2Punctuality([{ amount: 100n, timeMs: t0 }], [{ amount: 100n, timeMs: t0 + 40 * DAY }]),
    ).toBe(0);
    expect(
      d2Punctuality(
        [{ amount: 100n, timeMs: t0 }],
        [
          { amount: 60n, timeMs: t0 + 10 * DAY },
          { amount: 40n, timeMs: t0 + 20 * DAY },
        ],
      ),
    ).toBe(1000);
    expect(
      d2Punctuality(
        [
          { amount: 100n, timeMs: t0 },
          { amount: 100n, timeMs: t0 + 5 * DAY },
        ],
        [
          { amount: 100n, timeMs: t0 + 2 * DAY },
          { amount: 100n, timeMs: t0 + 45 * DAY },
        ],
      ),
    ).toBe(500);
    expect(
      d2Punctuality(
        [{ amount: 100n, timeMs: t0 }],
        [
          { amount: 100n, timeMs: t0 - 5 * DAY },
          { amount: 100n, timeMs: t0 + 5 * DAY },
        ],
      ),
    ).toBe(1000);
    expect(
      d2Punctuality(
        [{ amount: 100n, timeMs: t0 }],
        [
          { amount: 0n, timeMs: t0 + 1 * DAY },
          { amount: 100n, timeMs: t0 + 5 * DAY },
        ],
      ),
    ).toBe(1000);
  });

  it('d3 edge cases', () => {
    expect(d3Utilization(false, 0n, 0n)).toBe(500);
    expect(d3Utilization(true, 0n, 0n)).toBe(500);
    expect(d3Utilization(true, 1000n, 0n)).toBe(1000);
    expect(d3Utilization(true, 1000n, 250n)).toBe(750);
    expect(d3Utilization(true, 1000n, 1000n)).toBe(0);
    expect(d3Utilization(true, 1000n, 1500n)).toBe(0);
  });

  it('d4 edge cases', () => {
    expect(d4RevenueConsistency([0n, 0n, 0n])).toBe(300);
    expect(d4RevenueConsistency([100n, 100n, 100n])).toBe(1000);
    expect(d4RevenueConsistency([0n, 0n, 300n])).toBe(0);
    const uneven = d4RevenueConsistency([100n, 200n, 300n]);
    expect(uneven).toBeGreaterThanOrEqual(0);
    expect(uneven).toBeLessThan(1000);
    expect(d4RevenueConsistency([100n, 100n, 200n])).toBe(646);
  });

  it('d5 and d11 are zero', () => {
    expect(d5RevenueGrowth()).toBe(0);
    expect(d11SponsorQuality()).toBe(0);
  });

  it('d7 identity continuity', () => {
    expect(d7IdentityContinuity(true)).toBe(1000);
    expect(d7IdentityContinuity(false)).toBe(500);
  });

  it('d8 cross chain', () => {
    expect(d8CrossChain()).toBe(300);
  });

  it('d6 agent age', () => {
    expect(d6AgentAge(0)).toBe(0);
    expect(d6AgentAge(-5)).toBe(0);
    expect(d6AgentAge(182.5)).toBe(500);
    expect(d6AgentAge(365)).toBe(1000);
    expect(d6AgentAge(1000)).toBe(1000);
  });

  it('d9 payment volume', () => {
    expect(d9PaymentVolume(0n)).toBe(0);
    expect(d9PaymentVolume(5000n)).toBe(500);
    expect(d9PaymentVolume(10000n)).toBe(1000);
    expect(d9PaymentVolume(50000n)).toBe(1000);
  });

  it('d10 default history', () => {
    expect(d10DefaultHistory(0)).toBe(1000);
    expect(d10DefaultHistory(1)).toBe(600);
    expect(d10DefaultHistory(2)).toBe(200);
    expect(d10DefaultHistory(3)).toBe(0);
    expect(d10DefaultHistory(100)).toBe(0);
  });

  it('d12 concentration', () => {
    expect(d12Concentration([])).toBe(500);
    expect(d12Concentration([100n])).toBe(0);
    expect(d12Concentration([60n, 40n])).toBe(400);
    expect(d12Concentration([50n, 30n, 20n])).toBe(500);
  });

  it('computeDimensions wires all twelve', () => {
    const inputs: DimensionInputs = {
      borrowedPrincipal: 200n,
      repaidPrincipal: 150n,
      borrowEvents: [
        { amount: 100n, timeMs: t0 },
        { amount: 100n, timeMs: t0 + DAY },
      ],
      repayPrincipalEvents: [{ amount: 150n, timeMs: t0 + 10 * DAY }],
      lineActive: true,
      lineLimit: 1000n,
      drawn: 200n,
      paymentWindows90d: [100n, 100n, 100n],
      paymentVolumeWholeUnits: 5000n,
      merchantPaymentVolumes: [3000n, 2000n],
      defaultCount: 1,
      daysSinceRegistration: 400,
      agentActive: true,
    };
    const dims = computeDimensions(inputs);
    const expected = [
      d1RepaymentHistory(inputs.borrowedPrincipal, inputs.repaidPrincipal),
      d2Punctuality(inputs.borrowEvents, inputs.repayPrincipalEvents),
      d3Utilization(inputs.lineActive, inputs.lineLimit, inputs.drawn),
      d4RevenueConsistency(inputs.paymentWindows90d),
      d5RevenueGrowth(),
      d6AgentAge(inputs.daysSinceRegistration),
      d7IdentityContinuity(inputs.agentActive),
      d8CrossChain(),
      d9PaymentVolume(inputs.paymentVolumeWholeUnits),
      d10DefaultHistory(inputs.defaultCount),
      d11SponsorQuality(),
      d12Concentration(inputs.merchantPaymentVolumes),
    ];
    expect(dims).toEqual(expected);
    expect(dims[4]).toBe(0);
    expect(dims[10]).toBe(0);
    expect(dims).toEqual([750, 500, 800, 1000, 0, 1000, 1000, 300, 500, 600, 0, 400]);
  });
});
