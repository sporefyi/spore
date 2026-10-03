import { loadConfig } from "@spore/common";
import type { ApiConfig, ServiceStatus } from "./types.js";

function parseServiceStatus(raw: string | undefined): ServiceStatus | null {
  if (!raw || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const { indexer, scoreEngine, oraclePublisher } = obj;
    if (
      typeof indexer !== "string" ||
      typeof scoreEngine !== "string" ||
      typeof oraclePublisher !== "string"
    ) {
      return null;
    }
    return { indexer, scoreEngine, oraclePublisher };
  } catch {
    return null;
  }
}

function parseModelVersion(raw: string | undefined): number {
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 1;
}

export function loadApiConfig(): ApiConfig {
  const base = loadConfig();

  const chainName = "Robinhood Chain";
  const assetSymbol = process.env.ASSET_SYMBOL?.trim() || "USDG";
  const scoreModelVersion = parseModelVersion(process.env.SCORE_MODEL_VERSION);
  const serviceStatusOverride = parseServiceStatus(process.env.SERVICE_STATUS);

  const contracts = {
    registry: base.contractRegistry ?? "",
    creditManager: base.contractCreditManager ?? "",
    backerVault: base.contractBackerVault ?? "",
    scoreOracle: base.contractScoreOracle ?? "",
    feeRouter: base.contractFeeRouter ?? "",
  };

  const rpcUrl = base.rpcUrl ?? "";
  const assetAddress = base.assetAddress ?? "";

  return {
    ...base,
    rpcUrl,
    assetAddress,
    chainName,
    assetSymbol,
    scoreModelVersion,
    serviceStatusOverride,
    contracts,
  };
}
