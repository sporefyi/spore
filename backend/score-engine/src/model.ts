export type Band = 'VERY LOW' | 'LOW' | 'MODERATE' | 'ELEVATED' | 'HIGH';

export const WEIGHTS: readonly number[] = [0.20, 0.12, 0.10, 0.08, 0.05, 0.05, 0.06, 0.05, 0.08, 0.10, 0.06, 0.05];
export const MODEL_VERSION = 1;
export const FUTURE_DIMS: readonly number[] = [4, 10];
export const LIMIT_LADDER: Readonly<Record<Band, number>> = {
  'VERY LOW': 500,
  'LOW': 250,
  'MODERATE': 100,
  'ELEVATED': 25,
  'HIGH': 0,
};
// Minimum score (inclusive) for each band; score < 300 is HIGH.
export const BAND_FLOORS: Readonly<Record<Band, number>> = {
  'VERY LOW': 800,
  'LOW': 650,
  'MODERATE': 500,
  'ELEVATED': 300,
  'HIGH': 0,
};

export interface DimensionInputs {
  borrowedPrincipal: bigint;
  repaidPrincipal: bigint;
  borrowEvents: Array<{ amount: bigint; timeMs: number }>;
  repayPrincipalEvents: Array<{ amount: bigint; timeMs: number }>;
  lineActive: boolean;
  lineLimit: bigint;
  drawn: bigint;
  paymentWindows90d: [bigint, bigint, bigint];
  paymentVolumeWholeUnits: bigint;
  merchantPaymentVolumes: bigint[];
  defaultCount: number;
  daysSinceRegistration: number;
  agentActive: boolean;
}

const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

// Rounding: bigint division truncates (round down); capped at 1000.
export function d1RepaymentHistory(borrowed: bigint, repaid: bigint): number {
  if (borrowed === 0n) return 400;
  const v = (repaid * 1000n) / borrowed;
  return v > 1000n ? 1000 : Number(v);
}

// Rounding: Math.round (nearest) on on-time ratio; FIFO matching of repayments to borrows.
export function d2Punctuality(
  borrows: Array<{ amount: bigint; timeMs: number }>,
  repayPrincipals: Array<{ amount: bigint; timeMs: number }>,
): number {
  const bs = [...borrows].sort((a, b) => a.timeMs - b.timeMs);
  const rs = [...repayPrincipals]
    .sort((a, b) => a.timeMs - b.timeMs)
    .map((r) => ({ amount: r.amount, timeMs: r.timeMs }));
  let fullyRepaid = 0;
  let onTime = 0;
  let ri = 0;
  for (const b of bs) {
    let remaining = b.amount;
    let coveredAt = -Infinity;
    while (remaining > 0n && ri < rs.length) {
      const r = rs[ri]!;
      if (r.amount <= 0n) {
        ri++;
        continue;
      }
      if (r.timeMs < b.timeMs) {
        ri++;
        continue;
      }
      const take = r.amount < remaining ? r.amount : remaining;
      remaining -= take;
      r.amount -= take;
      coveredAt = r.timeMs;
      if (r.amount === 0n) ri++;
    }
    if (remaining <= 0n) {
      fullyRepaid++;
      if (coveredAt <= b.timeMs + THIRTY_DAYS_MS) onTime++;
    }
  }
  if (fullyRepaid === 0) return 500;
  return Math.round((1000 * onTime) / bs.length);
}

// Rounding: bigint division truncates (round down); drawn clamped to [0, limit].
export function d3Utilization(lineActive: boolean, lineLimit: bigint, drawn: bigint): number {
  if (!lineActive || lineLimit <= 0n) return 500;
  let d = drawn;
  if (d < 0n) d = 0n;
  if (d > lineLimit) d = lineLimit;
  return Number(((lineLimit - d) * 1000n) / lineLimit);
}

// Rounding: Math.round (nearest) on 1000 - cv*1000, floored at 0.
export function d4RevenueConsistency(windows: [bigint, bigint, bigint]): number {
  const total = windows[0] + windows[1] + windows[2];
  if (total === 0n) return 300;
  const v = windows.map((w) => Number(w));
  const mean = (v[0]! + v[1]! + v[2]!) / 3;
  const variance = v.reduce((a, x) => a + (x - mean) * (x - mean), 0) / 3;
  const sd = Math.sqrt(variance);
  const cv = sd / mean;
  return Math.max(0, Math.round(1000 - cv * 1000));
}

// Future dimension: locked to 0.
export function d5RevenueGrowth(): number {
  return 0;
}

// Rounding: Math.round (nearest), capped at 1000.
export function d6AgentAge(daysSinceRegistration: number): number {
  if (!(daysSinceRegistration > 0)) return 0;
  return Math.min(1000, Math.round((1000 * daysSinceRegistration) / 365));
}

// No rounding: fixed values.
export function d7IdentityContinuity(agentActive: boolean): number {
  return agentActive ? 1000 : 500;
}

// Fixed 300: only one chain indexed (documented limitation).
export function d8CrossChain(): number {
  return 300;
}

// Rounding: bigint division truncates (round down), capped at 1000.
export function d9PaymentVolume(volumeWholeUnits: bigint): number {
  const v = (volumeWholeUnits * 1000n) / 10000n;
  return v > 1000n ? 1000 : v < 0n ? 0 : Number(v);
}

// Rounding: defaultCount floored to integer >= 0; linear penalty of 400 each, floored at 0.
export function d10DefaultHistory(defaultCount: number): number {
  const n = Number.isFinite(defaultCount) ? Math.max(0, Math.floor(defaultCount)) : 0;
  if (n <= 0) return 1000;
  return Math.max(0, 1000 - 400 * n);
}

// Future dimension: locked to 0.
export function d11SponsorQuality(): number {
  return 0;
}

// Rounding: bigint division truncates (round down).
export function d12Concentration(merchantVolumes: bigint[]): number {
  let total = 0n;
  let max = 0n;
  for (const v of merchantVolumes) {
    total += v;
    if (v > max) max = v;
  }
  if (total === 0n) return 500;
  return Number(((total - max) * 1000n) / total);
}

export function computeDimensions(inputs: DimensionInputs): number[] {
  const dims = [
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
  for (const i of FUTURE_DIMS) dims[i] = 0;
  return dims;
}

export function computeScore(dimScores: readonly number[]): { score: number; band: string; limitWholeUnits: number } {
  if (!Array.isArray(dimScores) || dimScores.length !== 12) {
    throw new RangeError('dimScores must have length 12');
  }
  for (const d of dimScores) {
    if (typeof d !== 'number' || !Number.isFinite(d)) {
      throw new RangeError('each dimension score must be a finite number');
    }
  }
  let s = 0;
  for (let i = 0; i < 12; i++) {
    const d = FUTURE_DIMS.includes(i) ? 0 : dimScores[i]!;
    s += WEIGHTS[i]! * d;
  }
  const score = Math.round(Math.round(s * 10) / 10);
  const band: Band =
    score >= 800 ? 'VERY LOW' : score >= 650 ? 'LOW' : score >= 500 ? 'MODERATE' : score >= 300 ? 'ELEVATED' : 'HIGH';
  return { score, band, limitWholeUnits: LIMIT_LADDER[band] };
}
