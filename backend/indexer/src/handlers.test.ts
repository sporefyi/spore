import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyEvent } from "./handlers.js";

type LogMeta = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  blockTime: Date;
};

const chainId = 4663;
const agentId = 7n;
const owner = "0xABCDEF0000000000000000000000000000000AAA";
const merchant = "0x1111111111111111111111111111111111111111";
const backer = "0x2222222222222222222222222222222222222222";
const payer = "0x3333333333333333333333333333333333333333";
const recipient = "0x4444444444444444444444444444444444444444";
const blockTime = new Date("2026-10-03T00:00:00Z");

const T = {
  agents: "agents",
  lines: "credit_lines",
  borrows: "borrows",
  payments: "payments",
  repays: "repays",
  defaults: "defaults",
  sponsors: "sponsors",
  revenue: "revenues",
  limitChanges: "credit_limit_changes",
  yields: "yield_allocations",
};

let pg: PGlite;
const db = {
  query: (text: string, params?: unknown[]) => pg.query(text, params as any[]),
};

function meta(txHash: string, logIndex: number): LogMeta {
  return {
    txHash,
    logIndex,
    blockNumber: 100 + logIndex,
    blockHash: "0xblock",
    blockTime,
  };
}

const tx = (n: number) => "0x" + n.toString(16).padStart(64, "0");

async function apply(name: string, args: Record<string, unknown>, m: LogMeta): Promise<void> {
  await applyEvent({ name, args } as any, m as any, db as any, chainId);
}

async function count(table: string): Promise<number> {
  const r = await pg.query<{ c: number | string }>(`SELECT count(*) AS c FROM ${table}`);
  return Number(r.rows[0]!.c);
}

async function line(): Promise<Record<string, any>> {
  const r = await pg.query<Record<string, any>>(
    `SELECT * FROM ${T.lines} WHERE agent_id = $1`,
    [agentId.toString()],
  );
  expect(r.rows.length).toBe(1);
  return r.rows[0]!;
}

// updated_at is wall-clock on every upsert — exclude it from idempotency snapshots.
async function snapshot(): Promise<string> {
  const t = await pg.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const out: Record<string, unknown[]> = {};
  for (const { tablename } of t.rows) {
    const r = await pg.query<Record<string, any>>(`SELECT * FROM "${tablename}"`);
    out[tablename] = r.rows.map((row) => {
      const { updated_at: _drop, ...rest } = row;
      return rest;
    });
  }
  return JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

async function expectIdempotent(fn: () => Promise<void>): Promise<void> {
  await fn();
  const before = await snapshot();
  await fn();
  const after = await snapshot();
  expect(after).toBe(before);
}

const registerArgs = { agentId, owner, metadataURI: "ipfs://x" };
const issueArgs = { agentId, limit: 10000n, feeBps: 500 };

const register = (txHash = tx(1000)) => apply("AgentRegistered", registerArgs, meta(txHash, 0));
const issue = (txHash = tx(1001)) => apply("CreditIssued", issueArgs, meta(txHash, 0));
const seed = async () => {
  await register();
  await issue();
};
const borrow = (amount: bigint, fee: bigint, txHash = tx(2000), logIndex = 0) =>
  apply("Borrow", { agentId, amount, fee }, meta(txHash, logIndex));

beforeAll(async () => {
  pg = new PGlite();
  const schema = readFileSync(
    new URL("../../db/migrations/001_schema.sql", import.meta.url),
    "utf8",
  );
  await pg.exec(schema);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  const t = await pg.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  if (t.rows.length > 0) {
    const names = t.rows.map((r) => `"${r.tablename}"`).join(", ");
    await pg.exec(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
  }
});

describe("applyEvent", () => {
  it("AgentRegistered inserts agent once", async () => {
    await expectIdempotent(() => register());
    expect(await count(T.agents)).toBe(1);
    const r = await pg.query<Record<string, any>>(`SELECT * FROM ${T.agents}`);
    const row = r.rows[0]!;
    expect(row.owner).toBe(owner.toLowerCase());
    expect(row.metadata_uri).toBe("ipfs://x");
    expect(row.active).toBe(true);
    expect(new Date(row.registered_at).getTime()).toBe(blockTime.getTime());
  });

  it("CreditIssued creates credit line", async () => {
    await register();
    await expectIdempotent(() => issue());
    const l = await line();
    expect(String(l.line_limit)).toBe("10000");
    expect(Number(l.fee_bps)).toBe(500);
    expect(String(l.drawn)).toBe("0");
    expect(String(l.fee_owed)).toBe("0");
    expect(l.active).toBe(true);
    expect(l.defaulted).toBe(false);
  });

  it("Borrow inserts borrow and updates line", async () => {
    await seed();
    await expectIdempotent(() => borrow(3000n, 150n));
    expect(await count(T.borrows)).toBe(1);
    const b = await pg.query<Record<string, any>>(`SELECT * FROM ${T.borrows}`);
    expect(b.rows[0]!.merchant).toBe("");
    const l = await line();
    expect(String(l.drawn)).toBe("3000");
    expect(String(l.fee_owed)).toBe("150");
  });

  it("Payment links to borrow in same tx", async () => {
    await seed();
    const h = tx(3000);
    await borrow(3000n, 150n, h, 0);
    const pay = () => apply("Payment", { agentId, merchant, amount: 3000n }, meta(h, 1));
    await expectIdempotent(pay);
    expect(await count(T.payments)).toBe(1);
    expect(await count(T.borrows)).toBe(1);
    const b = await pg.query<Record<string, any>>(`SELECT * FROM ${T.borrows}`);
    expect(b.rows[0]!.merchant).toBe(merchant);
  });

  it("Payment without a borrow is inserted and touches no borrows", async () => {
    await seed();
    await expectIdempotent(() =>
      apply("Payment", { agentId, merchant, amount: 500n }, meta(tx(4000), 1)),
    );
    expect(await count(T.payments)).toBe(1);
    expect(await count(T.borrows)).toBe(0);
  });

  it("Repay reduces fee then principal", async () => {
    await seed();
    await borrow(3000n, 150n);
    const repay = () =>
      apply("Repay", { agentId, payer, amount: 1000n, feePortion: 150n }, meta(tx(5000), 0));
    await expectIdempotent(repay);
    expect(await count(T.repays)).toBe(1);
    const l = await line();
    expect(String(l.fee_owed)).toBe("0");
    expect(String(l.drawn)).toBe("2150");
  });

  it("Repay overpay clamps drawn at zero", async () => {
    await seed();
    await borrow(3000n, 150n);
    await apply("Repay", { agentId, payer, amount: 99999n, feePortion: 0n }, meta(tx(5001), 0));
    const l = await line();
    expect(String(l.drawn)).toBe("0");
  });

  it("Default zeroes line and is terminal", async () => {
    await seed();
    await borrow(2000n, 100n);
    const def = (h: string) => () =>
      apply(
        "Default",
        { agentId, drawnAmount: 2000n, coveredAmount: 1500n, shortfall: 500n },
        meta(h, 0),
      );
    await expectIdempotent(def(tx(6000)));
    expect(await count(T.defaults)).toBe(1);
    let l = await line();
    expect(String(l.drawn)).toBe("0");
    expect(String(l.fee_owed)).toBe("0");
    expect(l.active).toBe(false);
    expect(l.defaulted).toBe(true);

    await def(tx(6001))();
    expect(await count(T.defaults)).toBe(2);
    l = await line();
    expect(l.active).toBe(false);
    expect(l.defaulted).toBe(true);
  });

  it("Sponsor inserts once", async () => {
    await seed();
    await expectIdempotent(() =>
      apply("Sponsor", { agentId, backer, amount: 2500n }, meta(tx(7000), 0)),
    );
    expect(await count(T.sponsors)).toBe(1);
    const r = await pg.query<Record<string, any>>(`SELECT * FROM ${T.sponsors}`);
    expect(r.rows[0]!.backer).toBe(backer.toLowerCase());
    expect(String(r.rows[0]!.amount)).toBe("2500");
  });

  describe("Revenue", () => {
    const cases: Array<[string, string, string]> = [
      [
        "treasury",
        "0x7472656173757279000000000000000000000000000000000000000000000000",
        "treasury",
      ],
      [
        "backer-yield",
        "0x6261636b65722d7969656c640000000000000000000000000000000000000000",
        "backer-yield",
      ],
      ["unknown", "0xdeadbeef" + "0".repeat(56), "0xdeadbeef" + "0".repeat(56)],
    ];
    for (const [label, kind, expected] of cases) {
      it(`decodes ${label} kind`, async () => {
        await seed();
        await expectIdempotent(() =>
          apply("Revenue", { kind, amount: 100n, recipient }, meta(tx(8000), 0)),
        );
        expect(await count(T.revenue)).toBe(1);
        const r = await pg.query<Record<string, any>>(`SELECT * FROM ${T.revenue}`);
        expect(r.rows[0]!.kind).toBe(expected.toLowerCase());
      });
    }
  });

  it("CreditLimitChanged updates limit", async () => {
    await seed();
    await expectIdempotent(() =>
      apply(
        "CreditLimitChanged",
        { agentId, oldLimit: 10000n, newLimit: 5000n },
        meta(tx(9000), 0),
      ),
    );
    expect(await count(T.limitChanges)).toBe(1);
    const l = await line();
    expect(String(l.line_limit)).toBe("5000");
  });

  it("YieldAllocated inserts once", async () => {
    await seed();
    await expectIdempotent(() =>
      apply("YieldAllocated", { agentId, amount: 42n }, meta(tx(9500), 0)),
    );
    expect(await count(T.yields)).toBe(1);
  });

  it("unknown event throws", async () => {
    await expect(apply("Nope", {}, meta(tx(9900), 0))).rejects.toThrow(/unknown event/i);
  });

  it("end-to-end lifecycle", async () => {
    const h = tx(10000);
    await register(tx(9990));
    await issue(tx(9991));
    await borrow(3000n, 150n, h, 0);
    await apply("Payment", { agentId, merchant, amount: 3000n }, meta(h, 1));
    await apply("Repay", { agentId, payer, amount: 1000n, feePortion: 150n }, meta(tx(10001), 0));
    const l = await line();
    expect(String(l.drawn)).toBe("2150");
    expect(String(l.fee_owed)).toBe("0");
    const b = await pg.query<Record<string, any>>(`SELECT * FROM ${T.borrows}`);
    expect(b.rows[0]!.merchant).toBe(merchant);
    for (const t of [T.agents, T.lines, T.borrows, T.payments, T.repays]) {
      expect(await count(t)).toBe(1);
    }
  });
});
