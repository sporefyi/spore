import {
  createDb,
  runMigrations,
  loadConfig,
  createLogger,
} from "@spore/common";
import { loadSporeAbis, buildSporeInterface } from "./abis.js";
import { ChainWatcher, type WatcherConfig } from "./watcher.js";
import { startReconciler, type LineReader } from "./reconcile.js";
import { JsonRpcProvider, Contract, type InterfaceAbi } from "ethers";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_BACKFILL_CHUNK = 2000;

function requireAddress(name: string, value: string | undefined): string {
  if (!value || !ADDRESS_RE.test(value)) {
    throw new Error(
      `${name} is required for the indexer: expected 0x-prefixed 20-byte hex address`,
    );
  }
  return value;
}

function backfillChunkSize(): number {
  const raw = process.env.INDEXER_BACKFILL_CHUNK;
  if (raw === undefined || raw.trim() === "") return DEFAULT_BACKFILL_CHUNK;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(
      `INDEXER_BACKFILL_CHUNK must be an integer >= 1, got "${raw}"`,
    );
  }
  return n;
}

async function main(): Promise<void> {
  // Shared config (reads .env via dotenv): DATABASE_URL required,
  // CHAIN_ID default 4663, CONFIRMATIONS default 12, INDEXER_POLL_MS default 5000, etc.
  const config = loadConfig();
  const logger = createLogger("indexer");

  if (!config.rpcUrl) {
    throw new Error("RPC_URL is required for the indexer");
  }
  if (config.deployBlock <= 0) {
    throw new Error("DEPLOY_BLOCK must be > 0 for the indexer");
  }
  const contracts = {
    registry: requireAddress("CONTRACT_REGISTRY", config.contractRegistry),
    creditManager: requireAddress(
      "CONTRACT_CREDIT_MANAGER",
      config.contractCreditManager,
    ),
    backerVault: requireAddress(
      "CONTRACT_BACKER_VAULT",
      config.contractBackerVault,
    ),
    feeRouter: requireAddress("CONTRACT_FEE_ROUTER", config.contractFeeRouter),
  };

  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDir =
    process.env.MIGRATIONS_DIR?.trim() ||
    path.resolve(here, "../../db/migrations");
  const artifactsDir =
    process.env.ARTIFACTS_DIR?.trim() ||
    path.resolve(here, "../../contracts/out");

  const db = await createDb(config.databaseUrl);
  await runMigrations(db, migrationsDir);
  logger.info("migrations applied");

  const abis = loadSporeAbis(artifactsDir);
  const iface = buildSporeInterface(abis);
  const provider = new JsonRpcProvider(config.rpcUrl);

  const watcherConfig: WatcherConfig = {
    chainId: config.chainId,
    deployBlock: config.deployBlock,
    confirmations: config.confirmations,
    pollMs: config.indexerPollMs,
    backfillChunkSize: backfillChunkSize(),
    contractAddresses: [
      contracts.registry,
      contracts.creditManager,
      contracts.backerVault,
      contracts.feeRouter,
    ],
  };
  const watcher = new ChainWatcher({
    reader: provider,
    db,
    iface,
    config: watcherConfig,
    logger,
  });

  const creditManager = new Contract(
    contracts.creditManager,
    abis.creditManager as unknown as InterfaceAbi,
    provider,
  ) as unknown as LineReader;
  const reconciler = startReconciler(
    { lineReader: creditManager, db, logger },
    config.reconcileMs,
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down");
    reconciler.stop();
    await watcher.stop(); // drains the in-flight batch before resolving
    await db.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  await watcher.start();
}

function isEntrypoint(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return (
      path.resolve(arg) === path.resolve(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((err: unknown) => {
    const logger = createLogger("indexer");
    logger.fatal({ err }, "indexer failed");
    process.exit(1);
  });
}
