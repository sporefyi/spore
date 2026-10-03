import type { DbClient, Logger, SporeConfig } from "@spore/common";

export type { DbClient, Logger };

/*
 * NOTE: These response interfaces are intentionally defined locally instead of
 * being imported from the shared API types in `@spore/common`. The shared types
 * mark utilization / ageDays / onTimeRate as non-nullable and health status as
 * "ok"-only. The frozen docs/API_CONTRACT.md requires honest nullables
 * (utilization null when no line, ageDays null when registered_at is null,
 * repaymentRate/onTimeRate null when no history, score null until scored) and an
 * honest "degraded" health status. These types match the contract exactly.
 */

export interface ServiceStatus {
  indexer: string;
  scoreEngine: string;
  oraclePublisher: string;
}

export interface ApiConfig extends SporeConfig {
  rpcUrl: string;
  assetAddress: string;
  chainName: string;
  assetSymbol: string;
  scoreModelVersion: number;
  serviceStatusOverride: ServiceStatus | null;
  contracts: {
    registry: string;
    creditManager: string;
    backerVault: string;
    scoreOracle: string;
    feeRouter: string;
  };
}

export interface AppDeps {
  db: DbClient;
  config: ApiConfig;
  logger: Logger;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  chainId: number;
  lastBlock: number;
  lastSyncAt: string | null;
  confirmations: number;
  db: "ok" | "error";
  rpc: "ok" | "error";
  services: ServiceStatus;
}

export interface ProtocolResponse {
  active: boolean;
  chainId: number;
  chainName: string;
  asset: { address: string; decimals: number; symbol: string };
  contracts: {
    registry: string;
    creditManager: string;
    backerVault: string;
    scoreOracle: string;
    feeRouter: string;
  };
  scoreModel: { version: number; status: string };
}

export interface StatsResponse {
  agents: number;
  creditIssued: string;
  repaid: string;
  activeCredit: string;
  repaymentRate: number | null;
  decimals: number;
}

export interface AgentSummary {
  agentId: string;
  owner: string;
  score: number | null;
  band: string | null;
  creditLimit: string;
  loansRepaid: number;
  defaults: number;
  utilization: number | null;
  ageDays: number | null;
}

export interface AgentsListResponse {
  items: AgentSummary[];
  total: number;
}

export interface AgentDossier {
  identity: {
    agentId: string;
    owner: string;
    metadataUri: string;
    active: boolean;
    ageDays: number | null;
    registeredAt: string | null;
  };
  score: {
    value: number;
    band: string;
    modelVersion: number;
    updatedAt: string;
    dimensions: Record<string, number>;
  } | null;
  credit: {
    limit: string;
    drawn: string;
    feeOwed: string;
    feeBps: number;
    active: boolean;
    defaulted: boolean;
  };
  history: {
    borrowed: string;
    repaid: string;
    loans: number;
    defaults: number;
    onTimeRate: number | null;
  };
  economics: {
    paymentVolume: string;
    utilization: number | null;
    backers: number;
    vouched: string;
  };
  decimals: number;
}

export interface ScorePoint {
  t: string;
  score: number;
}

export interface ScoresResponse {
  items: ScorePoint[];
}

export interface LedgerItem {
  type: string;
  agentId: string;
  amount: string;
  txHash: string;
  blockNumber: number;
  t: string;
}

export interface LedgerResponse {
  items: LedgerItem[];
  total: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
