import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations } from "../db.js";
import type { DbClient } from "../db.js";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../db/migrations", import.meta.url),
);

let db: DbClient;

beforeEach(async () => {
  db = await createDb("pglite://:memory:");
});

afterEach(async () => {
  await db.close();
});

describe("createDb / query", () => {
  it("query returns rows and rowCount", async () => {
    await db.query("CREATE TABLE t (a text)");
    await db.query("INSERT INTO t (a) VALUES ($1)", ["one"]);
    await db.query("INSERT INTO t (a) VALUES ($1)", ["two"]);

    const res = await db.query<{ a: string }>("SELECT a FROM t ORDER BY a");
    expect(res.rows).toHaveLength(2);
    expect(res.rowCount).toBe(2);
    expect(res.rows.map((r) => r.a)).toEqual(["one", "two"]);
  });

  it("createDb rejects unknown scheme", async () => {
    await expect(createDb("mysql://x")).rejects.toThrow();
  });

  it("createDb accepts postgresql:// scheme (Render format)", async () => {
    // Pool creation is lazy: resolves without connecting; must not throw
    // "Unsupported database URL scheme".
    const db = await createDb("postgresql://u:p@127.0.0.1:1/db");
    await db.close();
  });
});

describe("withTx", () => {
  it("commits", async () => {
    await db.query("CREATE TABLE t (a text)");
    await db.withTx(async (tx) => {
      await tx.query("INSERT INTO t (a) VALUES ($1)", ["committed"]);
    });

    const res = await db.query<{ a: string }>("SELECT a FROM t");
    expect(res.rows).toEqual([{ a: "committed" }]);
  });

  it("rolls back on error", async () => {
    await db.query("CREATE TABLE t (a text)");

    await expect(
      db.withTx(async (tx) => {
        await tx.query("INSERT INTO t (a) VALUES ($1)", ["doomed"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);

    const res = await db.query<{ a: string }>("SELECT a FROM t");
    expect(res.rows).toHaveLength(0);

    // db remains usable after rollback
    await db.query("INSERT INTO t (a) VALUES ($1)", ["after"]);
    const after = await db.query<{ a: string }>("SELECT a FROM t");
    expect(after.rows).toEqual([{ a: "after" }]);
  });
});

describe("runMigrations", () => {
  it("applies 001_schema.sql idempotently", async () => {
    await runMigrations(db, MIGRATIONS_DIR);

    const first = await db.query<{ name: string }>(
      "SELECT name FROM schema_migrations",
    );
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]?.name).toBe("001_schema.sql");

    await db.query(
      `INSERT INTO agents
         (agent_id, owner, chain_id, block_number, tx_hash, log_index, block_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        1,
        "0x" + "a".repeat(40),
        4663,
        1,
        "0x" + "b".repeat(64),
        0,
        new Date(0).toISOString(),
      ],
    );
    const agents = await db.query<{ agent_id: number }>(
      "SELECT agent_id FROM agents",
    );
    expect(agents.rows).toHaveLength(1);
    expect(agents.rows[0]?.agent_id).toBe(1);

    await expect(runMigrations(db, MIGRATIONS_DIR)).resolves.toBeUndefined();

    const second = await db.query<{ name: string }>(
      "SELECT name FROM schema_migrations",
    );
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.name).toBe("001_schema.sql");
  });
});
