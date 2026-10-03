import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../config.js";

const MANAGED_KEYS = [
  "DATABASE_URL",
  "RPC_URL",
  "CHAIN_ID",
  "CONFIRMATIONS",
  "DEPLOY_BLOCK",
  "CONTRACT_REGISTRY",
  "ASSET_ADDRESS",
  "ASSET_DECIMALS",
  "ORACLE_PRIVATE_KEY",
  "INDEXER_POLL_MS",
  "RECONCILE_MS",
  "SCORE_INTERVAL_MS",
  "DRY_RUN",
  "PORT",
  "LOG_LEVEL",
];

const ADDR_REGISTRY = "0x" + "a".repeat(40);
const ADDR_ASSET = "0x" + "B".repeat(20) + "c".repeat(20);
const DB_URL = "postgres://localhost:5432/spore";

let snapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  snapshot = { ...process.env };
  for (const key of MANAGED_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("loadConfig", () => {
  it("applies defaults with only DATABASE_URL", () => {
    process.env.DATABASE_URL = DB_URL;
    const cfg = loadConfig({ ...process.env });
    expect(cfg.databaseUrl).toBe(DB_URL);
    expect(cfg.chainId).toBe(4663);
    expect(cfg.confirmations).toBe(12);
    expect(cfg.deployBlock).toBe(0);
    expect(cfg.assetDecimals).toBe(18);
    expect(cfg.indexerPollMs).toBe(5000);
    expect(cfg.reconcileMs).toBe(600000);
    expect(cfg.scoreIntervalMs).toBe(600000);
    expect(cfg.dryRun).toBe(true);
    expect(cfg.port).toBe(4000);
    expect(cfg.logLevel).toBe("info");
    expect(cfg.oraclePrivateKey).toBeUndefined();
    expect(cfg.contractRegistry).toBeUndefined();
  });

  it("parses a full env", () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.RPC_URL = "http://localhost:8545";
    process.env.CHAIN_ID = "1";
    process.env.CONFIRMATIONS = "3";
    process.env.DEPLOY_BLOCK = "100";
    process.env.CONTRACT_REGISTRY = ADDR_REGISTRY;
    process.env.ASSET_ADDRESS = ADDR_ASSET;
    process.env.ASSET_DECIMALS = "6";
    process.env.ORACLE_PRIVATE_KEY = "0x" + "1".repeat(64);
    process.env.INDEXER_POLL_MS = "1000";
    process.env.RECONCILE_MS = "2000";
    process.env.SCORE_INTERVAL_MS = "3000";
    process.env.DRY_RUN = "false";
    process.env.PORT = "8080";
    process.env.LOG_LEVEL = "debug";

    const cfg = loadConfig({ ...process.env });
    expect(cfg.databaseUrl).toBe(DB_URL);
    expect(cfg.rpcUrl).toBe("http://localhost:8545");
    expect(cfg.chainId).toBe(1);
    expect(cfg.confirmations).toBe(3);
    expect(cfg.deployBlock).toBe(100);
    expect(cfg.contractRegistry).toBe(ADDR_REGISTRY);
    expect(cfg.assetAddress).toBe(ADDR_ASSET);
    expect(cfg.assetDecimals).toBe(6);
    expect(cfg.oraclePrivateKey).toBe("0x" + "1".repeat(64));
    expect(cfg.indexerPollMs).toBe(1000);
    expect(cfg.reconcileMs).toBe(2000);
    expect(cfg.scoreIntervalMs).toBe(3000);
    expect(cfg.dryRun).toBe(false);
    expect(cfg.port).toBe(8080);
    expect(cfg.logLevel).toBe("debug");
  });

  it("throws when DATABASE_URL missing", () => {
    delete process.env.DATABASE_URL;
    expect(() => loadConfig({ ...process.env })).toThrow(/DATABASE_URL/);
  });

  it("throws when DATABASE_URL is empty", () => {
    process.env.DATABASE_URL = "";
    expect(() => loadConfig({ ...process.env })).toThrow(/DATABASE_URL/);
  });

  it("throws on bad CHAIN_ID", () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.CHAIN_ID = "abc";
    expect(() => loadConfig({ ...process.env })).toThrow(/CHAIN_ID/);
  });

  it("throws on bad address", () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.CONTRACT_REGISTRY = "0x123";
    expect(() => loadConfig({ ...process.env })).toThrow(/CONTRACT_REGISTRY/);
  });

  it("throws on bad LOG_LEVEL", () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.LOG_LEVEL = "verbose";
    expect(() => loadConfig({ ...process.env })).toThrow(/LOG_LEVEL/);
  });

  it("throws on bad DRY_RUN", () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.DRY_RUN = "maybe";
    expect(() => loadConfig({ ...process.env })).toThrow(/DRY_RUN/);
  });

  it("throws on bad PORT", () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.PORT = "99999";
    expect(() => loadConfig({ ...process.env })).toThrow(/PORT/);
  });

  it("rejects non-boolean-ish DRY_RUN variants and accepts yes/no", () => {
    process.env.DATABASE_URL = DB_URL;

    process.env.DRY_RUN = "yes";
    expect(loadConfig({ ...process.env }).dryRun).toBe(true);

    process.env.DRY_RUN = "0";
    expect(loadConfig({ ...process.env }).dryRun).toBe(false);

    process.env.DRY_RUN = "NO";
    expect(loadConfig({ ...process.env }).dryRun).toBe(false);

    process.env.DRY_RUN = "TRUE";
    expect(loadConfig({ ...process.env }).dryRun).toBe(true);

    process.env.DRY_RUN = "2";
    expect(() => loadConfig({ ...process.env })).toThrow(/DRY_RUN/);
  });
});
