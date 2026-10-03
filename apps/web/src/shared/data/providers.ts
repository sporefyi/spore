/**
 * DataProvider abstraction — the single seam between UI and data.
 *
 * - MainnetProvider: reads live chain/indexer state. Production default.
 *   Until SPORE contracts are deployed, every protocol-derived value is null
 *   and the UI renders "Protocol module not yet activated" / "Connecting to
 *   mainnet…" — it never invents numbers.
 * - IndexerProvider: same contract as MainnetProvider, backed by the SPORE
 *   indexer API (event-sourced). Active only when VITE_INDEXER_URL is set.
 *   On unreachable API / non-2xx / protocol active:false, every call degrades
 *   to the honest-empty MainnetProvider behavior (nulls/empties, never
 *   partial data, never throws).
 * - DemoProvider: clearly-labeled, DEV-ONLY fixture data for building UI
 *   against. Active only when VITE_DEMO_MODE === 'true' (dev builds).
 *   Production builds never use it.
 */

import { PROTOCOL_ACTIVE } from '../chains';
import type {
  AgentCreditProfile,
  AgentSummary,
  NetworkStats,
  RiskBand,
  ScorePoint,
} from '../types';

export type ProviderKind = 'mainnet' | 'indexer' | 'demo';

export interface DataProvider {
  readonly kind: ProviderKind;
  readonly label: string;
  getNetworkStats(): Promise<NetworkStats>;
  listAgents(): Promise<AgentSummary[]>;
  getAgent(agentId: string): Promise<AgentCreditProfile | null>;
  getScoreHistory(agentId: string): Promise<ScorePoint[]>;
}

const UNAVAILABLE_STATS: NetworkStats = {
  agents: null,
  creditIssuedUsd: null,
  repaidUsd: null,
  activeCreditUsd: null,
  repaymentRate: null,
};

export class MainnetProvider implements DataProvider {
  readonly kind: ProviderKind = 'mainnet';
  readonly label: string = 'Mainnet';

  private unavailable<T>(what: string): Promise<T> {
    // Protocol deployed: MainnetProvider is the fallback when no indexer URL is set.
    void what;
    return Promise.resolve(null as unknown as T);
  }

  getNetworkStats(): Promise<NetworkStats> {
    if (!PROTOCOL_ACTIVE) return Promise.resolve({ ...UNAVAILABLE_STATS });
    // TODO: wire to viem reads against CHAIN_CONFIG contracts once deployed.
    return Promise.resolve({ ...UNAVAILABLE_STATS });
  }

  listAgents(): Promise<AgentSummary[]> {
    if (!PROTOCOL_ACTIVE) return Promise.resolve([]);
    return Promise.resolve([]);
  }

  getAgent(agentId: string): Promise<AgentCreditProfile | null> {
    return this.unavailable(`agent ${agentId}`);
  }

  getScoreHistory(agentId: string): Promise<ScorePoint[]> {
    void agentId;
    return Promise.resolve([]);
  }
}

// ---------------------------------------------------------------------------
// IndexerProvider — API-backed implementation of DataProvider.
//
// Base URL = VITE_INDEXER_URL + "/api/v1". All amounts arrive as base-unit
// decimal strings; the frontend assumes a USD stablecoin 1:1 for display
// (documented assumption in the API contract).
// ---------------------------------------------------------------------------

const INDEXER_API_PREFIX = '/api/v1';
const INDEXER_TIMEOUT_MS = 10_000;
const PROTOCOL_CACHE_MS = 60_000;
const DEFAULT_DECIMALS = 18;
const VALID_BANDS: readonly RiskBand[] = ['VERY LOW', 'LOW', 'MODERATE', 'ELEVATED', 'HIGH'];

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function rateOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  return n !== null && n >= 0 && n <= 1 ? n : null;
}

function decimalsOrDefault(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 36
    ? v
    : DEFAULT_DECIMALS;
}

/** Base-unit decimal string ("250000000000000000000") -> human number (250). Never throws. */
export function formatBaseUnits(value: string | null | undefined, decimals: number): number | null {
  try {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!/^-?\d+$/.test(s)) return null;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
    const raw = BigInt(s);
    const negative = raw < 0n;
    const abs = negative ? -raw : raw;
    const scale = 10n ** BigInt(decimals);
    const whole = abs / scale;
    const fracFull = (abs % scale).toString().padStart(decimals, '0');
    const frac = fracFull.slice(0, 6).replace(/0+$/, '');
    const text = `${negative ? '-' : ''}${whole.toString()}${frac ? '.' + frac : ''}`;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function isValidBand(b: unknown): b is RiskBand {
  return typeof b === 'string' && (VALID_BANDS as readonly string[]).includes(b);
}

function moneyOrNull(v: unknown, decimals: number): number | null {
  return typeof v === 'string' ? formatBaseUnits(v, decimals) : null;
}

export class IndexerProvider implements DataProvider {
  readonly kind: ProviderKind = 'indexer';
  readonly label: string = 'Indexer';
  private readonly apiBase: string;
  private protocolCache: { active: boolean; decimals: number; expiresAt: number } | null = null;

  constructor(baseUrl: string) {
    this.apiBase = baseUrl.replace(/\/+$/, '') + INDEXER_API_PREFIX;
  }

  private async fetchJson<T>(path: string): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INDEXER_TIMEOUT_MS);
    try {
      const res = await fetch(this.apiBase + path, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async protocolState(): Promise<{ active: boolean; decimals: number }> {
    const now = Date.now();
    if (this.protocolCache && this.protocolCache.expiresAt > now) {
      return this.protocolCache;
    }
    let state = { active: false, decimals: DEFAULT_DECIMALS };
    const body = await this.fetchJson<unknown>('/protocol');
    if (isRec(body) && body.active === true) {
      const asset = isRec(body.asset) ? body.asset : null;
      state = {
        active: true,
        decimals: decimalsOrDefault(asset ? asset.decimals : undefined),
      };
    }
    this.protocolCache = { ...state, expiresAt: Date.now() + PROTOCOL_CACHE_MS };
    return state;
  }

  async getNetworkStats(): Promise<NetworkStats> {
    try {
      const proto = await this.protocolState();
      if (!proto.active) return { ...UNAVAILABLE_STATS };
      const body = await this.fetchJson<unknown>('/stats');
      if (!isRec(body)) return { ...UNAVAILABLE_STATS };
      const d = decimalsOrDefault(body.decimals ?? proto.decimals);
      return {
        agents: numOrNull(body.agents),
        creditIssuedUsd: moneyOrNull(body.creditIssued, d),
        repaidUsd: moneyOrNull(body.repaid, d),
        activeCreditUsd: moneyOrNull(body.activeCredit, d),
        repaymentRate: rateOrNull(body.repaymentRate),
      };
    } catch {
      return { ...UNAVAILABLE_STATS };
    }
  }

  async listAgents(): Promise<AgentSummary[]> {
    try {
      const proto = await this.protocolState();
      if (!proto.active) return [];
      const body = await this.fetchJson<unknown>('/agents?limit=100');
      if (!isRec(body) || !Array.isArray(body.items)) return [];
      const d = decimalsOrDefault('decimals' in body ? body.decimals : proto.decimals);
      const out: AgentSummary[] = [];
      for (const item of body.items as unknown[]) {
        if (!isRec(item) || typeof item.agentId !== 'string') continue;
        out.push({
          agentId: item.agentId,
          name: null,
          score: numOrNull(item.score),
          band: isValidBand(item.band) ? item.band : null,
          creditLimitUsd: moneyOrNull(item.creditLimit, d),
          loansRepaid: numOrNull(item.loansRepaid),
          defaults: numOrNull(item.defaults),
          revenue30dUsd: null,
          utilization: numOrNull(item.utilization),
          ageDays: numOrNull(item.ageDays),
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  async getAgent(agentId: string): Promise<AgentCreditProfile | null> {
    try {
      const proto = await this.protocolState();
      if (!proto.active) return null;
      const body = await this.fetchJson<unknown>(`/agents/${encodeURIComponent(agentId)}`);
      if (!isRec(body) || !isRec(body.identity)) return null;
      const d = decimalsOrDefault(body.decimals ?? proto.decimals);
      const identity = body.identity;
      const credit = isRec(body.credit) ? body.credit : {};
      const history = isRec(body.history) ? body.history : {};
      const economics = isRec(body.economics) ? body.economics : {};

      let score: AgentCreditProfile['score'] = null;
      if (isRec(body.score)) {
        const s = body.score;
        const value = numOrNull(s.value);
        if (value !== null && isValidBand(s.band) && typeof s.updatedAt === 'string') {
          score = { value, band: s.band, updatedAt: s.updatedAt };
        }
      }

      return {
        identity: {
          agentId: typeof identity.agentId === 'string' ? identity.agentId : agentId,
          erc8004Id: null,
          name: null,
          ageDays: numOrNull(identity.ageDays),
          chains: ['robinhood'],
        },
        score,
        creditLimitUsd: moneyOrNull(credit.limit, d),
        history: {
          borrowedUsd: moneyOrNull(history.borrowed, d),
          repaidUsd: moneyOrNull(history.repaid, d),
          loans: numOrNull(history.loans),
          defaults: numOrNull(history.defaults),
          onTimeRate: rateOrNull(history.onTimeRate),
        },
        economics: {
          revenue30dUsd: null,
          revenue90dUsd: null,
          utilization: numOrNull(economics.utilization),
          debtToRevenue: null,
        },
      };
    } catch {
      return null;
    }
  }

  async getScoreHistory(agentId: string): Promise<ScorePoint[]> {
    try {
      const proto = await this.protocolState();
      if (!proto.active) return [];
      const body = await this.fetchJson<unknown>(
        `/agents/${encodeURIComponent(agentId)}/scores`,
      );
      if (!isRec(body) || !Array.isArray(body.items)) return [];
      const out: ScorePoint[] = [];
      for (const item of body.items as unknown[]) {
        if (!isRec(item)) continue;
        const score = numOrNull(item.score);
        if (typeof item.t === 'string' && score !== null) {
          out.push({ t: item.t, score });
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}

/**
 * DEV ONLY. Fixture data so UI lanes can build against a realistic shape.
 * Every consumer must surface `provider.kind === 'demo'` as a visible
 * "Demo data" badge. Never enabled in production builds.
 */
export class DemoProvider implements DataProvider {
  readonly kind: ProviderKind = 'demo';
  readonly label: string = 'Demo data';

  getNetworkStats(): Promise<NetworkStats> {
    return Promise.resolve({
      agents: 1284,
      creditIssuedUsd: 48210,
      repaidUsd: 46980,
      activeCreditUsd: 8420,
      repaymentRate: 0.974,
    });
  }

  listAgents(): Promise<AgentSummary[]> {
    return Promise.resolve([
      {
        agentId: 'SPORE #004821',
        name: 'mycelium-7',
        score: 782,
        band: 'LOW',
        creditLimitUsd: 250,
        loansRepaid: 37,
        defaults: 0,
        revenue30dUsd: 1840,
        utilization: 0.21,
        ageDays: 143,
      },
      {
        agentId: 'SPORE #003117',
        name: 'spore-runner',
        score: 641,
        band: 'MODERATE',
        creditLimitUsd: 100,
        loansRepaid: 12,
        defaults: 0,
        revenue30dUsd: 420,
        utilization: 0.62,
        ageDays: 58,
      },
      {
        agentId: 'SPORE #000902',
        name: 'hypha-02',
        score: 915,
        band: 'VERY LOW',
        creditLimitUsd: 500,
        loansRepaid: 88,
        defaults: 0,
        revenue30dUsd: 6420,
        utilization: 0.12,
        ageDays: 301,
      },
    ]);
  }

  getAgent(agentId: string): Promise<AgentCreditProfile | null> {
    const id = agentId.toUpperCase().startsWith('SPORE') ? agentId : `SPORE #${agentId}`;
    return Promise.resolve({
      identity: {
        agentId: id,
        erc8004Id: '118293',
        name: 'mycelium-7',
        ageDays: 143,
        chains: ['robinhood'],
      },
      score: { value: 782, band: 'LOW', updatedAt: new Date().toISOString() },
      creditLimitUsd: 250,
      history: {
        borrowedUsd: 4820,
        repaidUsd: 4861,
        loans: 37,
        defaults: 0,
        onTimeRate: 1,
      },
      economics: {
        revenue30dUsd: 1840,
        revenue90dUsd: 6420,
        utilization: 0.21,
        debtToRevenue: 0.048,
      },
    });
  }

  getScoreHistory(agentId: string): Promise<ScorePoint[]> {
    void agentId;
    const now = Date.now();
    const pts: ScorePoint[] = [];
    let s = 420;
    for (let i = 36; i >= 0; i--) {
      s = Math.min(920, s + Math.round(8 + Math.random() * 14));
      pts.push({
        t: new Date(now - i * 7 * 86400000).toISOString(),
        score: s,
      });
    }
    return Promise.resolve(pts);
  }
}

/**
 * Production default is MainnetProvider. IndexerProvider only when
 * VITE_INDEXER_URL is set; Demo only with explicit dev flag.
 */
export function getProvider(): DataProvider {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
  if (env.DEV && env.VITE_DEMO_MODE === 'true') return new DemoProvider();
  const indexerUrl = env.VITE_INDEXER_URL;
  if (typeof indexerUrl === 'string' && indexerUrl.trim() !== '') {
    return new IndexerProvider(indexerUrl.trim());
  }
  return new MainnetProvider();
}

export const provider: DataProvider = getProvider();
export const isDemo = provider.kind === 'demo';
