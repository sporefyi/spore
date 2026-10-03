import { isAddress, getAddress } from "ethers";
import { createLogger } from "./logger.js";

export interface OraclePublisherConfig {
  rpcUrl: string | undefined;
  oracleAddress: string;
  chainId: number | undefined;
  assetDecimals: number;
  scoreIntervalMs: number;
  dryRun: boolean;
  watchMode: boolean;
  livePublish: boolean;
  hasPrivateKey: boolean;
  logLevel: string;
  databaseUrl: string;
  maxPublishAttempts: number;
  baseBackoffMs: number;
  publishTimeoutMs: number;
}

const INTEGER_RE = /^-?\d+$/;
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

function readString(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseInteger(name: string, raw: string): number {
  if (!INTEGER_RE.test(raw)) {
    throw new Error(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return value;
}

function readInt(name: string, defaultValue: number, min: number, max?: number): number {
  const raw = readString(name);
  const value = raw === undefined ? defaultValue : parseInteger(name, raw);
  if (value < min) {
    throw new Error(`${name} must be >= ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${name} must be <= ${max}`);
  }
  return value;
}

export function loadConfig(): OraclePublisherConfig {
  const logLevel = readString("LOG_LEVEL") ?? "info";
  const logger = createLogger("config");

  const databaseUrl = readString("DATABASE_URL");
  if (databaseUrl === undefined) {
    throw new Error("DATABASE_URL is required");
  }

  const oracleAddressRaw = readString("ORACLE_ADDRESS");
  if (oracleAddressRaw === undefined) {
    throw new Error("ORACLE_ADDRESS is required");
  }
  if (!oracleAddressRaw.startsWith("0x") || !isAddress(oracleAddressRaw)) {
    throw new Error("ORACLE_ADDRESS must be a valid 0x-prefixed hex address");
  }
  const oracleAddress = getAddress(oracleAddressRaw);

  const chainIdRaw = readString("CHAIN_ID");
  const chainId = chainIdRaw === undefined ? undefined : parseInteger("CHAIN_ID", chainIdRaw);
  if (chainId !== undefined && chainId < 0) {
    throw new Error("CHAIN_ID must be >= 0");
  }

  const assetDecimals = readInt("ASSET_DECIMALS", 18, 0, 36);
  const scoreIntervalMs = readInt("SCORE_INTERVAL_MS", 600000, 1000);
  const maxPublishAttempts = readInt("MAX_PUBLISH_ATTEMPTS", 3, 1);
  const baseBackoffMs = readInt("BASE_BACKOFF_MS", 1000, 50);
  const publishTimeoutMs = readInt("PUBLISH_TIMEOUT_MS", 60000, 5000);

  const dryRunRaw = readString("DRY_RUN") ?? "true";
  const dryRun = dryRunRaw !== "false";

  const privateKey = readString("ORACLE_PRIVATE_KEY");
  if (privateKey !== undefined && !PRIVATE_KEY_RE.test(privateKey)) {
    throw new Error("ORACLE_PRIVATE_KEY is malformed (expected 0x followed by 64 hex characters)");
  }
  const hasPrivateKey = privateKey !== undefined;

  const watchMode = !hasPrivateKey;
  const livePublish = !watchMode && !dryRun;

  const rpcUrl = readString("RPC_URL");
  if (rpcUrl === undefined) {
    if (livePublish) {
      throw new Error("RPC_URL is required when live publishing is enabled");
    }
    logger.warn(
      { watchMode, dryRun },
      "RPC_URL is not set; continuing in watch/dry-run mode without chain access",
    );
  }

  return {
    rpcUrl,
    oracleAddress,
    chainId,
    assetDecimals,
    scoreIntervalMs,
    dryRun,
    watchMode,
    livePublish,
    hasPrivateKey,
    logLevel,
    databaseUrl,
    maxPublishAttempts,
    baseBackoffMs,
    publishTimeoutMs,
  };
}
