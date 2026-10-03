import dotenv from "dotenv";

export interface SporeConfig {
  databaseUrl: string;
  rpcUrl: string | undefined;
  chainId: number;
  confirmations: number;
  deployBlock: number;
  contractRegistry: string | undefined;
  contractCreditManager: string | undefined;
  contractBackerVault: string | undefined;
  contractScoreOracle: string | undefined;
  contractFeeRouter: string | undefined;
  assetAddress: string | undefined;
  assetDecimals: number;
  indexerPollMs: number;
  reconcileMs: number;
  scoreIntervalMs: number;
  oraclePrivateKey: string | undefined;
  dryRun: boolean;
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

type LogLevel = SporeConfig["logLevel"];

const LOG_LEVELS: readonly LogLevel[] = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
];

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const INT_RE = /^[+-]?\d+$/;

function optString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function reqString(name: string, value: string | undefined): string {
  const v = optString(value);
  if (v === undefined) {
    throw new Error(`${name} is required`);
  }
  return v;
}

function reqInt(
  name: string,
  value: string | undefined,
  opts: { min?: number; max?: number; default: number },
): number {
  const v = optString(value);
  if (v === undefined) return opts.default;
  if (!INT_RE.test(v)) {
    throw new Error(`${name} must be an integer, got "${v}"`);
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${name} must be an integer, got "${v}"`);
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new Error(`${name} must be >= ${opts.min}, got "${v}"`);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new Error(`${name} must be <= ${opts.max}, got "${v}"`);
  }
  return n;
}

function optAddress(name: string, value: string | undefined): string | undefined {
  const v = optString(value);
  if (v === undefined) return undefined;
  if (!ADDRESS_RE.test(v)) {
    throw new Error(`${name} must be a 0x-prefixed 20-byte hex address, got "${v}"`);
  }
  return v;
}

function parseBool(name: string, value: string | undefined, def: boolean): boolean {
  const v = optString(value);
  if (v === undefined) return def;
  const lower = v.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") return true;
  if (lower === "false" || lower === "0" || lower === "no") return false;
  throw new Error(`${name} must be one of true/false/1/0/yes/no, got "${v}"`);
}

function parseRpcUrl(name: string, value: string | undefined): string | undefined {
  const v = optString(value);
  if (v === undefined) return undefined;
  if (!/^(https?|wss?):\/\//.test(v)) {
    throw new Error(`${name} must start with http://, https://, ws://, or wss://, got "${v}"`);
  }
  return v;
}

function parseLogLevel(name: string, value: string | undefined): LogLevel {
  const v = optString(value);
  if (v === undefined) return "info";
  const lower = v.toLowerCase();
  const found = LOG_LEVELS.find((l) => l === lower);
  if (found === undefined) {
    throw new Error(`${name} must be one of ${LOG_LEVELS.join("|")}, got "${v}"`);
  }
  return found;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SporeConfig {
  dotenv.config({ quiet: true });

  return {
    databaseUrl: reqString("DATABASE_URL", env["DATABASE_URL"]),
    rpcUrl: parseRpcUrl("RPC_URL", env["RPC_URL"]),
    chainId: reqInt("CHAIN_ID", env["CHAIN_ID"], { default: 4663 }),
    confirmations: reqInt("CONFIRMATIONS", env["CONFIRMATIONS"], { min: 0, default: 12 }),
    deployBlock: reqInt("DEPLOY_BLOCK", env["DEPLOY_BLOCK"], { min: 0, default: 0 }),
    contractRegistry: optAddress("CONTRACT_REGISTRY", env["CONTRACT_REGISTRY"]),
    contractCreditManager: optAddress("CONTRACT_CREDIT_MANAGER", env["CONTRACT_CREDIT_MANAGER"]),
    contractBackerVault: optAddress("CONTRACT_BACKER_VAULT", env["CONTRACT_BACKER_VAULT"]),
    contractScoreOracle: optAddress("CONTRACT_SCORE_ORACLE", env["CONTRACT_SCORE_ORACLE"]),
    contractFeeRouter: optAddress("CONTRACT_FEE_ROUTER", env["CONTRACT_FEE_ROUTER"]),
    assetAddress: optAddress("ASSET_ADDRESS", env["ASSET_ADDRESS"]),
    assetDecimals: reqInt("ASSET_DECIMALS", env["ASSET_DECIMALS"], { min: 0, max: 36, default: 18 }),
    indexerPollMs: reqInt("INDEXER_POLL_MS", env["INDEXER_POLL_MS"], { min: 1, default: 5000 }),
    reconcileMs: reqInt("RECONCILE_MS", env["RECONCILE_MS"], { min: 1, default: 600000 }),
    scoreIntervalMs: reqInt("SCORE_INTERVAL_MS", env["SCORE_INTERVAL_MS"], { min: 1, default: 600000 }),
    oraclePrivateKey: optString(env["ORACLE_PRIVATE_KEY"]),
    dryRun: parseBool("DRY_RUN", env["DRY_RUN"], true),
    port: reqInt("PORT", env["PORT"], { min: 1, max: 65535, default: 4000 }),
    logLevel: parseLogLevel("LOG_LEVEL", env["LOG_LEVEL"]),
  };
}
