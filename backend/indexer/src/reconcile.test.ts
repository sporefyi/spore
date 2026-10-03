import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { createDb, runMigrations } from "@spore/common";
import { reconcileOnce, type LineReader, type ChainLine } from "./reconcile.js";

type DbClient = Awaited<ReturnType<typeof createDb>>;

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../../db/migrations");
const logger = pino({ level: "silent" });

function rowsOf(res: any): any[] {
  return Array.isArray(res) ? res : res.rows;
}

class MockLineReader implements LineReader {
  lines = new Map<string, ChainLine | Error>();
  async getLine(agentId: bigint): Promise<ChainLine> {
    const v = this.lines.get(agentId.toString());
    if (!v) throw new Error("no line programmed");
    if (v instanceof Error) throw v;
    return v;
  }
}

describe("reconcileOnce", () => {
  let db: DbClient;
  let lineReader: MockLineReader;

  beforeAll(async () => {
    // One PGlite per file: wasm init takes ~18s, far beyond the hook timeout.
    db = await createDb("pglite://:memory:");
    await runMigrations(db, migrationsDir);
  }, 60000);

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query(
      `TRUNCATE agents, credit_lines, borrows, repays, defaults, sponsors, payments, revenues, credit_limit_changes, yield_allocations, sync_state RESTART IDENTITY CASCADE`,
    );
    lineReader = new MockLineReader();
    await db.query(
      "INSERT INTO agents (agent_id, owner, chain_id, block_number, tx_hash, log_index, block_time) VALUES (7, '0xabc', 4663, 10, '0xtx', 0, now())",
    );
    await db.query(
      "INSERT INTO credit_lines (agent_id, line_limit, drawn, fee_owed, fee_bps, active, defaulted) VALUES (7, 10000, 3000, 150, 500, true, false)",
    );
  });

  async function getRow() {
    const res = await db.query(
      "SELECT line_limit, drawn, fee_owed, fee_bps, active, defaulted FROM credit_lines WHERE agent_id = 7",
    );
    return rowsOf(res)[0];
  }

  async function count(table: string): Promise<number> {
    const res = await db.query(`SELECT count(*)::int AS c FROM ${table}`);
    return Number(rowsOf(res)[0].c);
  }

  it("corrects a closed line (G1)", async () => {
    lineReader.lines.set("7", {
      limit: 10000n,
      drawn: 0n,
      feeOwed: 0n,
      feeBps: 500,
      issuedAt: 1n,
      active: false,
      defaulted: false,
    } as ChainLine);

    const result = await reconcileOnce({ lineReader, db, logger });
    expect(result).toEqual({ checked: 1, corrected: 1 });

    const row = await getRow();
    expect(row.active).toBe(false);
    expect(String(row.drawn)).toBe("0");
    expect(String(row.fee_owed)).toBe("0");
    expect(String(row.line_limit)).toBe("10000");

    for (const t of ["borrows", "repays", "defaults", "payments"]) {
      expect(await count(t)).toBe(0);
    }
  });

  it("no correction when chain agrees", async () => {
    lineReader.lines.set("7", {
      limit: 10000n,
      drawn: 3000n,
      feeOwed: 150n,
      feeBps: 500,
      issuedAt: 1n,
      active: true,
      defaulted: false,
    } as ChainLine);

    const result = await reconcileOnce({ lineReader, db, logger });
    expect(result).toEqual({ checked: 1, corrected: 0 });

    const row = await getRow();
    expect(row.active).toBe(true);
    expect(row.defaulted).toBe(false);
    expect(String(row.drawn)).toBe("3000");
    expect(String(row.fee_owed)).toBe("150");
    expect(String(row.line_limit)).toBe("10000");
  });

  it("per-agent error does not abort", async () => {
    lineReader.lines.set("7", new Error("rpc failure"));

    const result = await reconcileOnce({ lineReader, db, logger });
    expect(result).toEqual({ checked: 1, corrected: 0 });

    const row = await getRow();
    expect(String(row.drawn)).toBe("3000");
    expect(row.active).toBe(true);
  });
});
