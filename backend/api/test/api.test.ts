import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { createDb, runMigrations, createLogger } from "@spore/common";
import { registerRoutes } from "../src/routes.js";
import { loadApiConfig } from "../src/config.js";
import { fileURLToPath } from "node:url";

const migrationsDir = fileURLToPath(new URL("../../db/migrations", import.meta.url));

type Db = Awaited<ReturnType<typeof createDb>>;

const DAY = 86400000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY).toISOString();

describe("@spore/api", () => {
  let db: Db;
  let app: FastifyInstance;
  const extraApps: FastifyInstance[] = [];
  let seeded = false;

  const get = async (
    instance: FastifyInstance,
    url: string,
  ): Promise<{ status: number; body: any; headers: Record<string, unknown> }> => {
    const res = await instance.inject({ method: "GET", url });
    return {
      status: res.statusCode,
      body: JSON.parse(res.body),
      headers: res.headers as Record<string, unknown>,
    };
  };

  const seed = async (): Promise<void> => {
    if (seeded) return;
    seeded = true;
    const a1 = daysAgo(143);
    const addr1 = "0x1111111111111111111111111111111111111111";
    const addr2 = "0x2222222222222222222222222222222222222222";

    await db.query(
      `INSERT INTO sync_state (id, last_block, last_hash, deploy_block, updated_at)
       VALUES (1, 123456, '0xabc', 100, '2026-10-03T08:00:00Z')`,
    );

    await db.query(
      `INSERT INTO agents (agent_id, owner, metadata_uri, active, registered_at, chain_id, block_number, tx_hash, log_index, block_time)
       VALUES (1, $1, 'ipfs://agent1', true, $2::timestamptz, 4663, 100, '0x01', 0, $2::timestamptz)`,
      [addr1, a1],
    );
    await db.query(
      `INSERT INTO agents (agent_id, owner, metadata_uri, active, registered_at, chain_id, block_number, tx_hash, log_index, block_time)
       VALUES (2, $1, '', true, NULL, 4663, 101, '0x02', 0, $2::timestamptz)`,
      [addr2, a1],
    );

    await db.query(
      `INSERT INTO credit_lines (agent_id, line_limit, drawn, fee_owed, fee_bps, active, defaulted)
       VALUES (1, '250000000000000000000', '52500000000000000000', '1000000000000000000', 500, true, false)`,
    );

    await db.query(
      `INSERT INTO scores (agent_id, score, band, limit_base, model_version, dimensions, computed_at)
       VALUES (1, 782, 'LOW', '200000000000000000000', 1, $1::jsonb, $2::timestamptz)`,
      ['{"dim1":900,"dim2":850}', new Date().toISOString()],
    );

    await db.query(
      `INSERT INTO score_history (agent_id, score, band, model_version, computed_at) VALUES (1, 700, 'LOW', 1, $1::timestamptz)`,
      [daysAgo(2)],
    );
    await db.query(
      `INSERT INTO score_history (agent_id, score, band, model_version, computed_at) VALUES (1, 782, 'LOW', 1, $1::timestamptz)`,
      [daysAgo(1)],
    );

    await db.query(
      `INSERT INTO borrows (agent_id, amount, fee, merchant, chain_id, block_number, tx_hash, log_index, block_time)
       VALUES (1, '500000000000000000000', '5000000000000000000', '', 4663, 110, '0x10', 0, $1::timestamptz)`,
      [daysAgo(5)],
    );

    await db.query(
      `INSERT INTO repays (agent_id, payer, amount, fee_portion, chain_id, block_number, tx_hash, log_index, block_time)
       VALUES (1, $1, '122000000000000000000', '2000000000000000000', 4663, 120, '0x11', 0, $2::timestamptz)`,
      [addr1, daysAgo(4)],
    );

    await db.query(
      `INSERT INTO defaults (agent_id, drawn_amount, covered_amount, shortfall, chain_id, block_number, tx_hash, log_index, block_time)
       VALUES (1, '380000000000000000000', '300000000000000000000', '80000000000000000000', 4663, 130, '0x12', 0, $1::timestamptz)`,
      [daysAgo(3)],
    );

    await db.query(
      `INSERT INTO sponsors (agent_id, backer, amount, chain_id, block_number, tx_hash, log_index, block_time)
       VALUES (1, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '10000000000000000000', 4663, 105, '0x13', 0, $1::timestamptz)`,
      [daysAgo(20)],
    );
    await db.query(
      `INSERT INTO sponsors (agent_id, backer, amount, chain_id, block_number, tx_hash, log_index, block_time)
       VALUES (1, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '20000000000000000000', 4663, 106, '0x14', 0, $1::timestamptz)`,
      [daysAgo(19)],
    );

    await db.query(
      `INSERT INTO payments (agent_id, merchant, amount, chain_id, block_number, tx_hash, log_index, block_time)
       VALUES (1, '0xcccccccccccccccccccccccccccccccccccccccc', '5000000000000000000', 4663, 115, '0x15', 0, $1::timestamptz)`,
      [daysAgo(6)],
    );

    await db.query(
      `INSERT INTO credit_limit_changes (agent_id, old_limit, new_limit, chain_id, block_number, tx_hash, log_index, block_time)
       VALUES (1, '0', '250000000000000000000', 4663, 102, '0x16', 0, $1::timestamptz)`,
      [daysAgo(30)],
    );
    await db.query(
      `INSERT INTO credit_limit_changes (agent_id, old_limit, new_limit, chain_id, block_number, tx_hash, log_index, block_time)
       VALUES (1, '250000000000000000000', '200000000000000000000', 4663, 125, '0x17', 0, $1::timestamptz)`,
      [daysAgo(7)],
    );
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = "pglite://:memory:";
    process.env.LOG_LEVEL = "silent";
    db = await createDb(process.env.DATABASE_URL);
    await runMigrations(db, migrationsDir);
    const config = loadApiConfig();
    app = Fastify();
    registerRoutes(app, { db, config, logger: createLogger("api-test") });
    await app.ready();
  }, 90000);

  afterAll(async () => {
    if (app) await app.close();
    for (const a of extraApps) {
      await a.close();
    }
    if (db) await db.close();
  }, 90000);

  // ---------- EMPTY DB ----------

  it("empty: stats", async () => {
    const res = await get(app, "/api/v1/stats");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      agents: 0,
      creditIssued: "0",
      repaid: "0",
      activeCredit: "0",
      repaymentRate: null,
      decimals: 18,
    });
    expect(res.headers["cache-control"]).toBe("public, max-age=15");
  });

  it("empty: agents", async () => {
    const res = await get(app, "/api/v1/agents");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0 });
  });

  it("empty: protocol", async () => {
    const res = await get(app, "/api/v1/protocol");
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(res.body.chainId).toBe(4663);
    expect(res.body.chainName).toBe("Robinhood Chain");
    expect(res.body.scoreModel).toEqual({ version: 1, status: "provisional" });
  });

  it("empty: health", async () => {
    const res = await get(app, "/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.db).toBe("ok");
    expect(res.body.rpc).toBe("error");
    expect(res.body.status).toBe("degraded");
    expect(res.body.chainId).toBe(4663);
    expect(res.body.lastBlock).toBe(0);
    expect(res.body.lastSyncAt).toBeNull();
    expect(res.body.confirmations).toBe(12);
    expect(res.body.services).toEqual({
      indexer: "unknown",
      scoreEngine: "unknown",
      oraclePublisher: "unknown",
    });
  });

  it("empty: ledger", async () => {
    const res = await get(app, "/api/v1/ledger");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0 });
  });

  // ---------- SEEDED ----------

  describe("seeded", () => {
    beforeAll(async () => {
      await seed();
    });

    it("stats", async () => {
      const res = await get(app, "/api/v1/stats");
      expect(res.status).toBe(200);
      expect(res.body.agents).toBe(2);
      expect(res.body.creditIssued).toBe("500000000000000000000");
      expect(res.body.repaid).toBe("120000000000000000000");
      expect(res.body.activeCredit).toBe("52500000000000000000");
      expect(res.body.repaymentRate).toBeCloseTo(0.24, 5);
      expect(res.body.decimals).toBe(18);
    });

    it("health", async () => {
      const res = await get(app, "/api/v1/health");
      expect(res.status).toBe(200);
      expect(res.body.lastBlock).toBe(123456);
      expect(res.body.lastSyncAt).toBe("2026-10-03T08:00:00.000Z");
    });

    it("agents list", async () => {
      const res = await get(app, "/api/v1/agents");
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items.map((i: any) => i.agentId)).toEqual(["1", "2"]);
      const [a, b] = res.body.items;
      expect(a.agentId).toBe("1");
      expect(a.score).toBe(782);
      expect(a.band).toBe("LOW");
      expect(a.creditLimit).toBe("250000000000000000000");
      expect(a.loansRepaid).toBe(1);
      expect(a.defaults).toBe(1);
      expect(a.utilization).toBeCloseTo(0.21, 5);
      expect(a.ageDays).toBeGreaterThanOrEqual(142);
      expect(a.ageDays).toBeLessThanOrEqual(144);
      expect(b.score).toBeNull();
      expect(b.band).toBeNull();
      expect(b.creditLimit).toBe("0");
      expect(b.loansRepaid).toBe(0);
      expect(b.defaults).toBe(0);
      expect(b.utilization).toBeNull();
      expect(b.ageDays).toBeNull();
      expect(res.headers["cache-control"]).toBe("public, max-age=15");
    });

    it("pagination", async () => {
      let res = await get(app, "/api/v1/agents?limit=1");
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.total).toBe(2);
      expect(res.body.items[0].agentId).toBe("1");

      res = await get(app, "/api/v1/agents?limit=1&offset=1");
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].agentId).toBe("2");

      res = await get(app, "/api/v1/agents?limit=1000");
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);

      res = await get(app, "/api/v1/agents?limit=0");
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
    });

    it("agent 1 detail", async () => {
      const res = await get(app, "/api/v1/agents/1");
      expect(res.status).toBe(200);
      const b = res.body;
      expect(b.identity.agentId).toBe("1");
      expect(b.identity.owner.startsWith("0x1111")).toBe(true);
      expect(b.identity.metadataUri).toBe("ipfs://agent1");
      expect(b.identity.active).toBe(true);
      expect(b.identity.ageDays).toBeGreaterThanOrEqual(142);
      expect(b.identity.ageDays).toBeLessThanOrEqual(144);
      expect(typeof b.identity.registeredAt).toBe("string");
      expect(Number.isNaN(Date.parse(b.identity.registeredAt))).toBe(false);
      expect(new Date(b.identity.registeredAt).toISOString()).toBe(b.identity.registeredAt);

      expect(b.score.value).toBe(782);
      expect(b.score.band).toBe("LOW");
      expect(b.score.modelVersion).toBe(1);
      expect(typeof b.score.updatedAt).toBe("string");
      expect(new Date(b.score.updatedAt).toISOString()).toBe(b.score.updatedAt);
      expect(b.score.dimensions).toEqual({ dim1: 900, dim2: 850 });

      expect(b.credit).toEqual({
        limit: "250000000000000000000",
        drawn: "52500000000000000000",
        feeOwed: "1000000000000000000",
        feeBps: 500,
        active: true,
        defaulted: false,
      });
      expect(b.history).toEqual({
        borrowed: "500000000000000000000",
        repaid: "120000000000000000000",
        loans: 1,
        defaults: 1,
        onTimeRate: 0,
      });
      expect(b.economics.paymentVolume).toBe("5000000000000000000");
      expect(b.economics.utilization).toBeCloseTo(0.21, 5);
      expect(b.economics.backers).toBe(2);
      expect(b.economics.vouched).toBe("30000000000000000000");
      expect(b.decimals).toBe(18);
      expect(res.headers["cache-control"]).toBe("public, max-age=60");
    });

    it("agent 2 detail", async () => {
      const res = await get(app, "/api/v1/agents/2");
      expect(res.status).toBe(200);
      const b = res.body;
      expect(b.score).toBeNull();
      expect(b.credit).toEqual({
        limit: "0",
        drawn: "0",
        feeOwed: "0",
        feeBps: 0,
        active: false,
        defaulted: false,
      });
      expect(b.history).toEqual({
        borrowed: "0",
        repaid: "0",
        loans: 0,
        defaults: 0,
        onTimeRate: null,
      });
      expect(b.identity.ageDays).toBeNull();
      expect(b.identity.registeredAt).toBeNull();
      expect(b.economics.utilization).toBeNull();
      expect(b.economics.backers).toBe(0);
      expect(b.economics.vouched).toBe("0");
    });

    it("agent not found", async () => {
      for (const url of ["/api/v1/agents/999", "/api/v1/agents/abc"]) {
        const res = await get(app, url);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("agent_not_found");
      }
    });

    it("agent scores", async () => {
      const res = await get(app, "/api/v1/agents/1/scores");
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items[0].score).toBe(700);
      expect(res.body.items[1].score).toBe(782);
      expect(res.body.items[0].t < res.body.items[1].t).toBe(true);
      expect(res.headers["cache-control"]).toBe("public, max-age=60");

      const empty = await get(app, "/api/v1/agents/2/scores");
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual({ items: [] });

      const missing = await get(app, "/api/v1/agents/999/scores");
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe("agent_not_found");
    });

    it("ledger", async () => {
      const res = await get(app, "/api/v1/ledger");
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(8);
      const items = res.body.items as any[];
      expect(items).toHaveLength(8);
      for (let i = 0; i < items.length - 1; i++) {
        expect(items[i].t >= items[i + 1].t).toBe(true);
      }
      for (const it of items) {
        expect(typeof it.type).toBe("string");
        expect(typeof it.agentId).toBe("string");
        expect(typeof it.amount).toBe("string");
        expect(it).toHaveProperty("txHash");
        expect(typeof it.blockNumber).toBe("number");
        expect(typeof it.t).toBe("string");
      }
      expect(items[0].txHash).toBe("0x12");
      expect(res.headers["cache-control"]).toBe("public, max-age=15");
    });

    it("ledger type filters", async () => {
      let res = await get(app, "/api/v1/ledger?type=repay");
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      for (const it of res.body.items) {
        expect(it.type).toBe("repay");
      }

      res = await get(app, "/api/v1/ledger?type=credit_issued");
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.items[0].amount).toBe("250000000000000000000");

      res = await get(app, "/api/v1/ledger?type=limit_changed");
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);

      res = await get(app, "/api/v1/ledger?type=bogus");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_type");
    });

    it("ledger limit", async () => {
      const res = await get(app, "/api/v1/ledger?limit=2");
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(8);
    });

    it("unknown route", async () => {
      const res = await get(app, "/api/v1/nope");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    });
  });

  describe("config", () => {
    const makeApp = async (): Promise<FastifyInstance> => {
      const cfg = loadApiConfig();
      const a = Fastify();
      registerRoutes(a, { db: db as never, config: cfg, logger: createLogger("api-test-x") });
      await a.ready();
      extraApps.push(a);
      return a;
    };

    it("service status override", async () => {
      process.env.SERVICE_STATUS = JSON.stringify({ indexer: "ok", scoreEngine: "ok", oraclePublisher: "ok" });
      try {
        const a2 = await makeApp();
        const res = await get(a2, "/api/v1/health");
        expect(res.status).toBe(200);
        expect(res.body.services).toEqual({ indexer: "ok", scoreEngine: "ok", oraclePublisher: "ok" });
      } finally {
        delete process.env.SERVICE_STATUS;
      }
    });

    it("protocol active with addresses", async () => {
      const addr = "0x" + "a".repeat(40);
      process.env.CONTRACT_REGISTRY = addr;
      process.env.CONTRACT_CREDIT_MANAGER = addr;
      process.env.CONTRACT_BACKER_VAULT = addr;
      process.env.CONTRACT_SCORE_ORACLE = addr;
      process.env.CONTRACT_FEE_ROUTER = addr;
      try {
        const a2 = await makeApp();
        const res = await get(a2, "/api/v1/protocol");
        expect(res.status).toBe(200);
        expect(res.body.active).toBe(true);
        expect(res.body.contracts.registry).toBe(addr);
      } finally {
        delete process.env.CONTRACT_REGISTRY;
        delete process.env.CONTRACT_CREDIT_MANAGER;
        delete process.env.CONTRACT_BACKER_VAULT;
        delete process.env.CONTRACT_SCORE_ORACLE;
        delete process.env.CONTRACT_FEE_ROUTER;
      }
    });
  });
});
