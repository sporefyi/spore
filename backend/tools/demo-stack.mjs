#!/usr/bin/env node
/**
 * demo-stack.mjs — single-process demo orchestrator.
 *
 * Runs the indexer watcher, the REST API, and the score engine in ONE node
 * process sharing ONE database handle. This exists because PGlite (the
 * zero-install local database) is single-process; production uses real
 * Postgres where each service is its own process (see docker-compose.yml).
 * All services are the REAL service modules, not mocks.
 *
 * Usage: RPC_URL=... DATABASE_URL=pglite://... node tools/demo-stack.mjs
 * Env: same .env.demo as the individual services.
 */
import { JsonRpcProvider } from "ethers";
import Fastify from "fastify";
import { createDb, runMigrations, createLogger, loadConfig } from "@spore/common";
import { ChainWatcher } from "../indexer/dist/watcher.js";
import { loadSporeAbis, buildSporeInterface } from "../indexer/dist/abis.js";
import { loadApiConfig } from "../api/dist/config.js";
import { registerRoutes } from "../api/dist/routes.js";
import { runBatch } from "../score-engine/dist/engine.js";

const log = createLogger("demo-stack");

function req(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

async function main() {
  const cfg = loadConfig();
  const apiCfg = loadApiConfig();
  const db = await createDb(cfg.databaseUrl);
  await runMigrations(db, new URL("../db/migrations", import.meta.url).pathname);
  log.info("migrations ok");

  const artifactsDir = process.env.ARTIFACTS_DIR?.trim() || "/home/hatch/workspace/spore/contracts/out";
  const iface = buildSporeInterface(loadSporeAbis(artifactsDir));
  const provider = new JsonRpcProvider(cfg.rpcUrl);

  const watcher = new ChainWatcher({
    reader: provider,
    db,
    iface,
    config: {
      chainId: cfg.chainId,
      deployBlock: cfg.deployBlock,
      confirmations: cfg.confirmations,
      pollMs: cfg.indexerPollMs,
      backfillChunkSize: Number(process.env.BACKFILL_CHUNK ?? 2000),
      contractAddresses: [
        req("CONTRACT_REGISTRY"),
        req("CONTRACT_CREDIT_MANAGER"),
        req("CONTRACT_BACKER_VAULT"),
        req("CONTRACT_FEE_ROUTER"),
      ],
    },
    logger: createLogger("indexer"),
  });

  const app = Fastify({ logger: false });
  registerRoutes(app, { db, config: apiCfg, logger: createLogger("api") });

  const engineCfg = {
    db,
    intervalMs: cfg.scoreIntervalMs,
    assetDecimals: cfg.assetDecimals,
    logger: createLogger("score-engine"),
  };

  // start() awaits the infinite poll loop — fire and forget.
  watcher.start().catch((e) => { log.error(e, "watcher failed"); process.exit(1); });
  log.info("indexer started");
  await app.listen({ port: apiCfg.port, host: "127.0.0.1" });
  log.info(`api listening on 127.0.0.1:${apiCfg.port}`);

  // Score once the backfill has had a chance to land, then on interval.
  setTimeout(() => {
    runBatch(engineCfg).then((r) => log.info({ scored: r.length }, "score batch done")).catch((e) => log.error(e, "score batch failed"));
  }, 15000);
  const timer = setInterval(() => {
    runBatch(engineCfg).catch((e) => log.error(e, "score batch failed"));
  }, cfg.scoreIntervalMs);

  const shutdown = async () => {
    clearInterval(timer);
    await watcher.stop().catch(() => {});
    await app.close().catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => { console.error("demo-stack fatal:", e); process.exit(1); });
