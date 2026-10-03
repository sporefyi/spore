import "dotenv/config";

import { loadConfig, type OraclePublisherConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { createDb, type DbClient } from "./db.js";
import {
  startPublisher,
  createOracleReader,
  createOracleWriter,
  type OracleReader,
  type OracleWriter,
  type PublisherHandle,
} from "./publisher.js";
import { JsonRpcProvider, Wallet, type Provider, type Signer } from "ethers";

// Created before anything can throw (loadConfig itself may throw).
const bootLogger: Logger = createLogger("oracle-publisher");

async function main(): Promise<void> {
  const config: OraclePublisherConfig = loadConfig();
  const logger: Logger = createLogger("oracle-publisher");

  const db: DbClient = await createDb(config.databaseUrl);

  let reader: OracleReader | null = null;
  let writer: OracleWriter | null = null;
  let handle: PublisherHandle | null = null;
  let jsonRpcProvider: JsonRpcProvider | null = null;
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    let code = exitCode;
    try {
      if (handle) {
        await handle.stop();
      }
    } catch (err) {
      logger.error({ err }, "error while stopping publisher");
      code = 1;
    }
    try {
      jsonRpcProvider?.destroy();
    } catch (err) {
      logger.error({ err }, "error while destroying provider");
    }
    logger.info({ reason, exitCode: code }, "shutdown complete");
    process.exit(code);
  };

  process.once("SIGINT", () => {
    logger.info({ signal: "SIGINT" }, "shutdown signal received");
    void shutdown("SIGINT", 0);
  });
  process.once("SIGTERM", () => {
    logger.info({ signal: "SIGTERM" }, "shutdown signal received");
    void shutdown("SIGTERM", 0);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandled promise rejection");
    void shutdown("unhandledRejection", 1);
  });
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "uncaught exception");
    void shutdown("uncaughtException", 1);
  });

  if (config.livePublish) {
    if (!config.rpcUrl) {
      logger.error("RPC URL is required for live publishing");
      process.exit(1);
    }

    let provider: Provider;
    try {
      const rpc = new JsonRpcProvider(config.rpcUrl);
      jsonRpcProvider = rpc;
      provider = rpc;

      if (config.chainId !== undefined) {
        const net = await rpc.getNetwork();
        if (Number(net.chainId) !== config.chainId) {
          throw new Error(
            `chain id mismatch: expected ${config.chainId}, got ${Number(net.chainId)}`,
          );
        }
      }
    } catch (err) {
      logger.error({ err }, "failed to initialise RPC provider; exiting");
      process.exit(1);
    }

    let signer: Signer;
    try {
      // Read directly; the key is never stored in config nor logged.
      signer = new Wallet(process.env.ORACLE_PRIVATE_KEY as string, provider);
    } catch {
      logger.error("failed to initialise oracle signer from ORACLE_PRIVATE_KEY; exiting");
      process.exit(1);
    }

    const signerAddress = await signer.getAddress();
    logger.info({ address: signerAddress }, "oracle signer address");

    reader = createOracleReader(provider, config.oracleAddress);
    writer = createOracleWriter(signer, config.oracleAddress);
  } else {
    const mode = !process.env.ORACLE_PRIVATE_KEY
      ? "WATCH — no ORACLE_PRIVATE_KEY; nothing will be published"
      : "DRY-RUN — DRY_RUN is not false; nothing will be published";
    logger.warn(
      {
        mode,
        oracleAddress: config.oracleAddress,
        intervalMs: config.scoreIntervalMs,
      },
      `oracle publisher starting in ${mode}`,
    );
  }

  handle = await startPublisher(config, logger, db, reader, writer);
  logger.info("oracle publisher started");
}

main().catch((err: unknown) => {
  bootLogger.error({ err }, "fatal startup error");
  process.exitCode = 1;
});
