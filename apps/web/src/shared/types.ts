/**
 * SPORE shared TypeScript types — the single types layer for the whole app.
 * Every lane imports from here. Do not duplicate these definitions.
 *
 * Honesty contract: any field that can only come from chain/indexer data is
 * nullable, and null means "not yet available". Components must render an
 * honest unavailable/loading state for null — never a fabricated value.
 */

export type RiskBand = 'VERY LOW' | 'LOW' | 'MODERATE' | 'ELEVATED' | 'HIGH';

export interface CreditScore {
  /** 0–1000. */
  value: number;
  band: RiskBand;
  /** ISO timestamp of the last model run. */
  updatedAt: string;
}

export interface AgentIdentity {
  /** SPORE-internal agent id, e.g. "SPORE #004821". */
  agentId: string;
  /** ERC-8004 identity token id, when the agent has registered one. */
  erc8004Id: string | null;
  name: string | null;
  /** Days since first observed on-chain activity. Null when unknown. */
  ageDays: number | null;
  /** Chain slugs from CHAIN_CONFIG where the agent has activity. */
  chains: string[];
}

export interface FinancialHistory {
  borrowedUsd: number | null;
  repaidUsd: number | null;
  loans: number | null;
  defaults: number | null;
  /** 0–1. Null when no loans observed. */
  onTimeRate: number | null;
}

export interface AgentEconomics {
  revenue30dUsd: number | null;
  revenue90dUsd: number | null;
  /** 0–1 outstanding / limit. */
  utilization: number | null;
  /** outstanding / 90d revenue. */
  debtToRevenue: number | null;
}

export interface AgentCreditProfile {
  identity: AgentIdentity;
  score: CreditScore | null;
  creditLimitUsd: number | null;
  history: FinancialHistory;
  economics: AgentEconomics;
}

export interface AgentSummary {
  agentId: string;
  name: string | null;
  score: number | null;
  band: RiskBand | null;
  creditLimitUsd: number | null;
  loansRepaid: number | null;
  defaults: number | null;
  revenue30dUsd: number | null;
  utilization: number | null;
  ageDays: number | null;
}

export interface NetworkStats {
  agents: number | null;
  creditIssuedUsd: number | null;
  repaidUsd: number | null;
  activeCreditUsd: number | null;
  /** 0–1. */
  repaymentRate: number | null;
}

export interface ScorePoint {
  /** ISO date. */
  t: string;
  score: number;
}

