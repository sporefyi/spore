import type { Repayment } from './types';

const API = (import.meta.env.VITE_INDEXER_URL as string | undefined)?.replace(/\/$/, '');
const LIMIT = 250;
const TIMEOUT_MS = 15000;
/** Backoff before attempts 2 and 3 (Render free tier can cold-start). */
const RETRY_WAITS = [0, 2500, 6000];

let cache: Promise<Repayment[]> | null = null;

async function attempt(timeoutMs: number): Promise<Repayment[]> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/api/v1/ledger?type=repay&limit=${LIMIT}`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { items?: unknown };
    const items = Array.isArray(json?.items) ? json.items : [];
    const reps: Repayment[] = [];
    for (const it of items) {
      const o = it as Record<string, unknown>;
      if (!o || typeof o.txHash !== 'string') continue;
      reps.push({
        agentId: String(o.agentId ?? ''),
        amount: String(o.amount ?? '0'),
        txHash: o.txHash,
        blockNumber: Number(o.blockNumber ?? 0),
        t: String(o.t ?? ''),
      });
    }
    reps.reverse(); // API is newest-first; grow oldest-first
    return reps;
  } catch {
    return [];
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Reads repayments from the chain via the indexer API (CreditManager Repay
 * events). Retries with backoff; never throws — resolves [] when the API is
 * unreachable, so the cinematic falls back to its procedural "empty — for now"
 * mycelium. Returned oldest-first so the mycelium grows chronologically.
 */
export function fetchRepayments(): Promise<Repayment[]> {
  if (cache) return cache;
  cache = (async (): Promise<Repayment[]> => {
    if (!API) return [];
    for (const wait of RETRY_WAITS) {
      if (wait > 0) await new Promise((r) => window.setTimeout(r, wait));
      const reps = await attempt(TIMEOUT_MS);
      if (reps.length > 0) return reps;
    }
    return [];
  })();
  return cache;
}

/** Bypass the cache and re-read the chain (periodic live refresh). */
export function refreshRepayments(): Promise<Repayment[]> {
  cache = null;
  return fetchRepayments();
}
