import { createLogger } from "./logger.js";

export interface DbClient {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

// Mirrors the `scores` table in the frozen schema (db/migrations/001_schema.sql).
export interface ScoreRow {
  agent_id: string;
  score: number;
  band: string;
  limit_base: string;
  model_version: number;
  computed_at: Date | string;
  published_at: Date | string | null;
  published_tx: string | null;
}

const PGLITE_SCHEME = "pglite://";

// Postgres type OIDs kept as raw strings (no float/BigInt coercion).
const OID_INT8 = 20;
const OID_NUMERIC = 1700;

async function createPgliteDb(databaseUrl: string): Promise<DbClient> {
  const { PGlite } = await import("@electric-sql/pglite");
  const target = databaseUrl.slice(PGLITE_SCHEME.length);
  const passthrough = (value: string): string => value;
  const parsers = {
    [OID_INT8]: passthrough,
    [OID_NUMERIC]: passthrough,
  };

  const inMemory = target === "" || target === "memory";
  const db = inMemory ? new PGlite({ parsers }) : new PGlite(target, { parsers });
  await db.waitReady;

  return {
    async query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
      const result = await db.query<T>(text, params);
      return { rows: result.rows };
    },
    async close(): Promise<void> {
      await db.close();
    },
  };
}

async function createPgDb(databaseUrl: string): Promise<DbClient> {
  const pgModule = await import("pg");
  const Pool = pgModule.default.Pool;
  const logger = createLogger("db");
  // Default pg type parsing is intentionally left untouched:
  // BIGINT and NUMERIC are returned as strings.
  const pool = new Pool({ connectionString: databaseUrl });

  pool.on("error", (err: Error) => {
    logger.error({ err }, "idle pg client error");
  });

  return {
    async query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
      const result = await pool.query(text, params);
      return { rows: result.rows as T[] };
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

// Schema (db/migrations/001_schema.sql) is applied elsewhere; this must work when it already exists.
export async function createDb(databaseUrl: string): Promise<DbClient> {
  if (databaseUrl.startsWith(PGLITE_SCHEME)) {
    return createPgliteDb(databaseUrl);
  }
  return createPgDb(databaseUrl);
}

// Rows in `scores` (db/migrations/001_schema.sql) never published, or recomputed after last publish.
export async function getPendingScores(db: DbClient): Promise<ScoreRow[]> {
  const result = await db.query<ScoreRow>(
    `SELECT agent_id, score, band, limit_base, model_version, computed_at, published_at, published_tx
       FROM scores
      WHERE published_at IS NULL OR computed_at > published_at
      ORDER BY agent_id`,
  );
  return result.rows;
}

// Records publication on `scores` (db/migrations/001_schema.sql).
export async function markPublished(db: DbClient, agentId: bigint, txHash: string): Promise<void> {
  await db.query(
    `UPDATE scores SET published_at = now(), published_tx = $2 WHERE agent_id = $1`,
    [agentId.toString(), txHash],
  );
}
