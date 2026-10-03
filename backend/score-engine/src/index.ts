import 'dotenv/config';
import { Pool } from 'pg';
import pino from 'pino';
import { ScoreEngine, startAdminServer } from './engine.js';
import { MODEL_VERSION } from './model.js';
import type { Db } from './inputs.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

function loadConfig(): {
  databaseUrl: string;
  intervalMs: number;
  port: number;
  adminPort: number;
  assetDecimals: number;
} {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.fatal('DATABASE_URL is required');
    process.exit(1);
  }

  const intervalMs = Number(process.env.SCORE_INTERVAL_MS ?? '600000');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    logger.fatal({ value: process.env.SCORE_INTERVAL_MS }, 'SCORE_INTERVAL_MS must be a positive finite number');
    process.exit(1);
  }

  const port = Number.parseInt(process.env.PORT ?? '3100', 10);
  const adminPort = port + 1000;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || adminPort > 65535) {
    logger.fatal({ value: process.env.PORT, adminPort }, 'PORT must be an integer in 1..65535 and PORT+1000 must be <= 65535');
    process.exit(1);
  }

  const assetDecimalsRaw = process.env.ASSET_DECIMALS ?? '6';
  const assetDecimals = Number(assetDecimalsRaw);
  if (!/^\d+$/.test(assetDecimalsRaw.trim()) || !Number.isInteger(assetDecimals) || assetDecimals < 0) {
    logger.fatal({ value: process.env.ASSET_DECIMALS }, 'ASSET_DECIMALS must be a non-negative integer');
    process.exit(1);
  }

  return { databaseUrl, intervalMs, port, adminPort, assetDecimals };
}

async function main(): Promise<void> {
  const config = loadConfig();

  const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
  const db: Db = {
    query: (text, params) =>
      pool.query(text, params ?? []).then((r) => ({ rows: r.rows }) as { rows: never[] }),
  };

  const engine = new ScoreEngine({
    db,
    logger,
    intervalMs: config.intervalMs,
    assetDecimals: config.assetDecimals,
  } as ConstructorParameters<typeof ScoreEngine>[0]);

  engine.start();

  /*
   * Admin API: POST http://127.0.0.1:<PORT+1000>/internal/run triggers an
   * on-demand scoring run (409 if one is already running); GET
   * /internal/health returns { ok, modelVersion }.
   * Bound to 127.0.0.1 ONLY — never expose publicly; there is no auth,
   * localhost binding is the access control.
   */
  const app = await startAdminServer(engine, config.adminPort, logger);

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.fatal({ signal }, 'Second signal received, forcing exit');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    try {
      await engine.stop();
      await app.close();
      await pool.end();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  logger.info(
    {
      port: config.port,
      adminPort: config.adminPort,
      intervalMs: config.intervalMs,
      assetDecimals: config.assetDecimals,
      modelVersion: MODEL_VERSION,
    },
    'score-engine started',
  );
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start score-engine');
  process.exit(1);
});
