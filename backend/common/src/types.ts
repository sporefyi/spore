// types.ts — mirrors db/migrations/001_schema.sql and docs/API_CONTRACT.md v1 (both frozen).

/* ------------------------------------------------------------------ */
/* Scalar aliases                                                      */
/* ------------------------------------------------------------------ */

export type Address = string;
export type TxHash = string;
/** Decimal string in base asset units. */
export type BaseUnits = string;
export type IsoDateTime = string;

/* ------------------------------------------------------------------ */
/* Unions                                                              */
/* ------------------------------------------------------------------ */

export type ScoreBand = "VERY LOW" | "LOW" | "MODERATE" | "ELEVATED" | "HIGH";

export type LedgerEventType =
  | "borrow"
  | "repay"
  | "default"
  | "sponsor"
  | "payment"
  | "credit_issued"
  | "limit_changed";

/** 'treasury' | 'backer-yield' | raw hex string when unknown. */
export type RevenueKind = "treasury" | "backer-yield" | (string & {});

/* ------------------------------------------------------------------ */
/* Consts                                                              */
/* ------------------------------------------------------------------ */

/** Band order high → low. */
export const SCORE_BANDS: ScoreBand[] = [
  "HIGH",
  "ELEVATED",
  "MODERATE",
  "LOW",
  "VERY LOW",
];

export const LEDGER_EVENT_TYPES: LedgerEventType[] = [
  "borrow",
  "repay",
  "default",
  "sponsor",
  "payment",
  "credit_issued",
  "limit_changed",
];

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

/** Each dimension is 0..1000. */
export interface DimensionScores {
  dim1: number;
  dim2: number;
  dim3: number;
  dim4: number;
  dim5: number;
  dim6: number;
  dim7: number;
  dim8: number;
  dim9: number;
  dim10: number;
  dim11: number;
  dim12: number;
}

/* ------------------------------------------------------------------ */
/* DB rows (post driver normalization)                                 */
/* BIGINT → number, NUMERIC → string, TIMESTAMPTZ → Date,              */
/* BOOLEAN → boolean, JSONB → parsed object                            */
/* ------------------------------------------------------------------ */

export interface ChainEventRef {
  chain_id: number;
  block_number: number;
  tx_hash: TxHash;
  log_index: number;
  block_time: Date;
}

export interface SyncStateRow {
  id: number;
  last_block: number;
  last_hash: string;
  deploy_block: number;
  updated_at: Date;
}

export interface AgentRow {
  agent_id: number;
  owner: Address;
  metadata_uri: string;
  active: boolean;
  registered_at: Date | null;
  chain_id: number;
  block_number: number;
  tx_hash: TxHash;
  log_index: number;
  block_time: Date;
}

export interface CreditLineRow {
  agent_id: number;
  line_limit: BaseUnits;
  drawn: BaseUnits;
  fee_owed: BaseUnits;
  fee_bps: number;
  issued_at: Date | null;
  active: boolean;
  defaulted: boolean;
  updated_at: Date;
}

export interface BorrowRow extends ChainEventRef {
  id: number;
  agent_id: number;
  amount: BaseUnits;
  fee: BaseUnits;
  merchant: Address;
}

export interface RepayRow extends ChainEventRef {
  id: number;
  agent_id: number;
  payer: Address;
  amount: BaseUnits;
  fee_portion: BaseUnits;
}

export interface DefaultRow extends ChainEventRef {
  id: number;
  agent_id: number;
  drawn_amount: BaseUnits;
  covered_amount: BaseUnits;
  shortfall: BaseUnits;
}

/**
 * Deposits-only: withdrawals emit no event in contracts v1,
 * so this table never reflects backer withdrawals.
 */
export interface SponsorRow extends ChainEventRef {
  id: number;
  agent_id: number;
  backer: Address;
  amount: BaseUnits;
}

export interface PaymentRow extends ChainEventRef {
  id: number;
  agent_id: number;
  merchant: Address;
  amount: BaseUnits;
}

export interface RevenueRow extends ChainEventRef {
  id: number;
  recipient: Address;
  amount: BaseUnits;
  kind: RevenueKind;
}

export interface CreditLimitChangeRow extends ChainEventRef {
  id: number;
  agent_id: number;
  old_limit: BaseUnits;
  new_limit: BaseUnits;
}

export interface YieldAllocationRow extends ChainEventRef {
  id: number;
  agent_id: number;
  amount: BaseUnits;
}

export interface ScoreRow {
  agent_id: number;
  /** 0..1000 */
  score: number;
  band: ScoreBand;
  limit_base: BaseUnits;
  model_version: number;
  dimensions: DimensionScores;
  computed_at: Date;
  published_at: Date | null;
  published_tx: TxHash | null;
}

export interface ScoreHistoryRow {
  id: number;
  agent_id: number;
  score: number;
  band: ScoreBand;
  model_version: number;
  computed_at: Date;
}

/* ------------------------------------------------------------------ */
/* API (base {API_URL}/api/v1, GET only)                               */
/* ------------------------------------------------------------------ */

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

export interface PaginationParams {
  /** default 25, max 100 */
  limit?: number;
  offset?: number;
}

export interface LedgerQuery extends PaginationParams {
  type?: LedgerEventType;
}

export interface HealthResponse {
  status: "ok";
  chainId: number;
  lastBlock: number;
  lastSyncAt: IsoDateTime;
  confirmations: number;
  db: "ok";
  rpc: "ok";
  services: {
    indexer: string;
    scoreEngine: string;
    oraclePublisher: string;
  };
}

export interface ProtocolResponse {
  active: boolean;
  chainId: number;
  chainName: string;
  asset: {
    address: Address;
    decimals: number;
    symbol: string;
  };
  contracts: {
    registry: Address;
    creditManager: Address;
    backerVault: Address;
    scoreOracle: Address;
    feeRouter: Address;
  };
  scoreModel: {
    version: number;
    status: string;
  };
}

export interface StatsResponse {
  agents: number;
  creditIssued: BaseUnits;
  repaid: BaseUnits;
  activeCredit: BaseUnits;
  repaymentRate: number | null;
  decimals: number;
}

export interface AgentListItem {
  agentId: string;
  owner: Address;
  score: number | null;
  band: ScoreBand | null;
  creditLimit: BaseUnits;
  loansRepaid: number;
  defaults: number;
  utilization: number;
  ageDays: number;
}

/** Ordered by agent_id ascending. */
export interface AgentsListResponse {
  items: AgentListItem[];
  total: number;
}

/** 404 → { error: { code: "agent_not_found", ... } } */
export interface AgentDetailResponse {
  identity: {
    agentId: string;
    owner: Address;
    metadataUri: string;
    active: boolean;
    ageDays: number;
    registeredAt: IsoDateTime;
  };
  score: {
    value: number;
    band: ScoreBand;
    modelVersion: number;
    updatedAt: IsoDateTime;
    dimensions: DimensionScores;
  } | null;
  credit: {
    limit: BaseUnits;
    drawn: BaseUnits;
    feeOwed: BaseUnits;
    feeBps: number;
    active: boolean;
    defaulted: boolean;
  };
  history: {
    borrowed: BaseUnits;
    repaid: BaseUnits;
    loans: number;
    defaults: number;
    onTimeRate: number;
  };
  economics: {
    paymentVolume: BaseUnits;
    utilization: number;
    backers: number;
    vouched: BaseUnits;
  };
  decimals: number;
}

export interface ScorePoint {
  t: IsoDateTime;
  score: number;
}

/** Ascending time. */
export interface ScoreHistoryResponse {
  items: ScorePoint[];
}

export interface LedgerItem {
  type: LedgerEventType;
  agentId: string;
  amount: BaseUnits;
  txHash: TxHash;
  blockNumber: number;
  t: IsoDateTime;
}

/** Newest first. */
export interface LedgerResponse {
  items: LedgerItem[];
  total: number;
}
