import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Interface } from "ethers";
import type { InterfaceAbi } from "ethers";

export interface SporeAbis {
  registry: unknown[];
  creditManager: unknown[];
  backerVault: unknown[];
  feeRouter: unknown[];
  scoreOracle?: unknown[];
}

function artifactPath(artifactsDir: string, contractName: string): string {
  return join(artifactsDir, `${contractName}.sol`, `${contractName}.json`);
}

function readAbi(filePath: string): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read artifact file ${filePath}: ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Artifact file ${filePath} is not valid JSON: ${reason}`);
  }

  if (typeof parsed !== "object" || parsed === null || !("abi" in parsed)) {
    throw new Error(`Artifact file ${filePath} has no "abi" field`);
  }

  const abi = (parsed as { abi: unknown }).abi;
  if (!Array.isArray(abi)) {
    throw new Error(`Artifact file ${filePath} has a non-array "abi" field`);
  }
  return abi as unknown[];
}

function loadRequired(artifactsDir: string, contractName: string): unknown[] {
  const filePath = artifactPath(artifactsDir, contractName);
  if (!existsSync(filePath)) {
    throw new Error(
      `Missing required artifact for ${contractName}: expected file at ${filePath}`,
    );
  }
  return readAbi(filePath);
}

export function loadSporeAbis(artifactsDir: string): SporeAbis {
  const abis: SporeAbis = {
    registry: loadRequired(artifactsDir, "SporeRegistry"),
    creditManager: loadRequired(artifactsDir, "CreditManager"),
    backerVault: loadRequired(artifactsDir, "BackerVault"),
    feeRouter: loadRequired(artifactsDir, "FeeRouter"),
  };

  const oraclePath = artifactPath(artifactsDir, "ScoreOracle");
  if (existsSync(oraclePath)) {
    abis.scoreOracle = readAbi(oraclePath);
  }

  return abis;
}

export function buildSporeInterface(abis: SporeAbis): Interface {
  const seen = new Set<string>();
  const combined: unknown[] = [];

  const sources: unknown[][] = [
    abis.registry,
    abis.creditManager,
    abis.backerVault,
    abis.feeRouter,
  ];

  for (const abi of sources) {
    for (const item of abi) {
      const key = JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      combined.push(item);
    }
  }

  return new Interface(combined as unknown as InterfaceAbi);
}
