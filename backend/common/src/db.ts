import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Pool, types } from "pg";

export interface DbClient {
  query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
  withTx<T>(fn: (db: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/*
 * Driver normalization (so both backends return the same JS types):
 *  - BIGINT / int8 (OID 20): pg returns strings by default; we parse to `number`
 *    to match PGlite's behavior.
 *  - NUMERIC stays `string` on both drivers.
 *  - TIMESTAMPTZ is `Date` on both drivers.
 */
types.setTypeParser(20, (v: string | null) => (v === null ? null : Number(v)));

type QueryResult<T> = { rows: T[]; rowCount: number | null };

interface PgliteLikeResult<T> {
  rows: T[];
  rowCount?: number | null;
  affectedRows?: number;
}

function createPgliteClient(pg: PGlite): DbClient {
  // Serializes top-level transactions, since a single PGlite connection cannot interleave them.
  let chain: Promise<unknown> = Promise.resolve();

  const query = async <T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>> => {
    const res = (await pg.query<T>(text, params)) as unknown as PgliteLikeResult<T>;
    // Pass rowCount through if present (may be null); otherwise fall back to PGlite's affectedRows.
    const rowCount = res.rowCount !== undefined ? res.rowCount : (res.affectedRows ?? null);
    return { rows: res.rows, rowCount };
  };

  const txClient: DbClient = {
    query,
    // Nested withTx joins the outer transaction: fn is called with this same client.
    withTx: <T>(fn: (db: DbClient) => Promise<T>) => fn(txClient),
    close: () => Promise.reject(new Error("Cannot close a transaction-scoped client")),
  };

  const client: DbClient = {
    query,
    withTx<T>(fn: (db: DbClient) => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        await query("BEGIN");
        try {
          const result = await fn(txClient);
          await query("COMMIT");
          return result;
        } catch (err) {
          try {
            await query("ROLLBACK");
          } catch {
            // Ignore rollback failure; the original error is more useful.
          }
          throw err;
        }
      };
      const p = chain.then(run, run);
      chain = p.catch(() => undefined);
      return p;
    },
    close: () => pg.close(),
  };
  return client;
}

function createPgClient(pool: Pool): DbClient {
  const client: DbClient = {
    async query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
      const res = await pool.query(text, params);
      return { rows: res.rows as T[], rowCount: res.rowCount };
    },
    async withTx<T>(fn: (db: DbClient) => Promise<T>): Promise<T> {
      const conn = await pool.connect();
      const txClient: DbClient = {
        async query<U = any>(text: string, params?: unknown[]): Promise<QueryResult<U>> {
          const res = await conn.query(text, params);
          return { rows: res.rows as U[], rowCount: res.rowCount };
        },
        // Nested withTx joins the outer transaction: fn is called with this same client.
        withTx: <U>(inner: (db: DbClient) => Promise<U>) => inner(txClient),
        close: () => Promise.reject(new Error("Cannot close a transaction-scoped client")),
      };
      try {
        await conn.query("BEGIN");
        try {
          const result = await fn(txClient);
          await conn.query("COMMIT");
          return result;
        } catch (err) {
          try {
            await conn.query("ROLLBACK");
          } catch {
            // Ignore rollback failure; the original error is more useful.
          }
          throw err;
        }
      } finally {
        conn.release();
      }
    },
    close: () => pool.end(),
  };
  return client;
}

export async function createDb(url: string): Promise<DbClient> {
  if (url.startsWith("pglite://")) {
    const rest = url.slice("pglite://".length);
    let pg: PGlite;
    if (rest === "" || rest === ":memory:") {
      pg = new PGlite();
    } else {
      await mkdir(dirname(resolve(rest)), { recursive: true });
      pg = new PGlite(rest);
    }
    await pg.waitReady;
    return createPgliteClient(pg);
  }
  if (url.startsWith("pg://") || url.startsWith("postgres://")) {
    const pool = new Pool({ connectionString: url, max: 5 });
    pool.on("error", () => {
      // Idle client errors must not crash the process; the next query will surface problems.
    });
    return createPgClient(pool);
  }
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url);
  const scheme = m ? m[1] : url;
  throw new Error(`Unsupported database URL scheme: "${scheme}"`);
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Splits SQL into statements on top-level semicolons, ignoring semicolons inside
 * single-quoted strings, double-quoted identifiers, dollar-quoted blocks,
 * line comments and block comments. Comments are stripped from the output.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const n = sql.length;

  const flush = (): void => {
    if (cur.trim() !== "") out.push(cur.trim());
    cur = "";
  };

  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      cur += " ";
      continue;
    }
    if (ch === "'" || ch === '"') {
      // A doubled quote ('' or "") ends and immediately restarts the literal, which works naturally.
      const start = i;
      i++;
      while (i < n && sql[i] !== ch) i++;
      i = Math.min(i + 1, n);
      cur += sql.slice(start, i);
      continue;
    }
    if (ch === "$" && !isIdentChar(sql[i - 1])) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 130));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        cur += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ";") {
      flush();
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  flush();
  return out;
}

export async function runMigrations(db: DbClient, migrationsDir: string): Promise<void> {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );

  const entries = await readdir(migrationsDir);
  const files = entries.filter((f) => f.endsWith(".sql")).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const applied = await db.query<{ name: string }>("SELECT name FROM schema_migrations");
  const done = new Set(applied.rows.map((r) => r.name));

  for (const name of files) {
    if (done.has(name)) continue;
    const sql = await readFile(join(migrationsDir, name), "utf8");
    const statements = splitStatements(sql);
    await db.withTx(async (tx) => {
      for (const stmt of statements) {
        if (stmt.trim() === "") continue;
        await tx.query(stmt);
      }
      await tx.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
    });
  }
}
