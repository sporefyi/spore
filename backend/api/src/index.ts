import Fastify from "fastify";
import type { FastifyBaseLogger } from "fastify";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadApiConfig } from "./config.js";
import { createLogger, createDb, runMigrations } from "@spore/common";
import { registerRoutes } from "./routes.js";

async function resolveMigrationsDir(): Promise<string> {
  const fromEnv = process.env.MIGRATIONS_DIR;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv;

  // Covers both src and dist layouts.
  const candidates = [
    new URL("../../db/migrations", import.meta.url),
    new URL("../../../db/migrations", import.meta.url),
  ];

  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    try {
      await access(path);
      return path;
    } catch {
      // try next candidate
    }
  }

  throw new Error(
    "Migrations directory not found; set MIGRATIONS_DIR or ensure db/migrations exists",
  );
}

async function main(): Promise<void> {
  const config = loadApiConfig();
  const logger = createLogger("api");
  const db = await createDb(config.databaseUrl);

  try {
    const dir = await resolveMigrationsDir();
    await runMigrations(db, dir);
  } catch (err) {
    logger.error({ err }, "migrations failed");
    process.exit(1);
  }

  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger });

  registerRoutes(app, { db, config, logger });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    try {
      await app.close();
      await db.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  logger.info("api listening on port %d", config.port);
}

main().catch((err) => {
  // console.error is the last resort: a failure here may occur before any logger exists.
  console.error("fatal startup error", err);
  process.exit(1);
});
