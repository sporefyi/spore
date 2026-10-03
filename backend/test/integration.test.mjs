import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as harness from "./harness.mjs";

// ---------- helpers ----------
const E18 = (n) => (BigInt(n) * 10n ** 18n).toString();
const norm = (s) => String(s).replace(/_/g, "").toLowerCase();
const normAmt = (v) => {
  if (v === null || v === undefined) return "null";
  let s = typeof v === "bigint" ? v.toString() : String(v);
  if (/^-?\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, "");
  return s;
};
const eq = (a, b) => normAmt(a) === normAmt(b);
const rowsOf = (res) => (Array.isArray(res) ? res : res?.rows ?? []);
const get = (row, ...names) => {
  if (!row) return undefined;
  const wanted = names.map(norm);
  for (const k of Object.keys(row)) {
    if (wanted.includes(norm(k))) return row[k];
  }
  return undefined;
};
const lc = (s) => (s === undefined || s === null ? s : String(s).toLowerCase());
const isTrue = (v) => v === true || v === "t" || v === 1 || v === "true";
const isFalse = (v) => v === false || v === "f" || v === 0 || v === "false";
const okish = (v) =>
  v === "ok" || v === true || v?.status === "ok" || v?.ok === true || v?.status === true;
const byAgent = (rows) =>
  [...rows].sort((a, b) => {
    const x = BigInt(normAmt(get(a, "agent_id", "agentId") ?? 0));
    const y = BigInt(normAmt(get(b, "agent_id", "agentId") ?? 0));
    return x < y ? -1 : x > y ? 1 : 0;
  });
const forAgent = (rows, id) =>
  rows.filter((r) => String(get(r, "agent_id", "agentId")) === String(id));

const MERCHANT = "0x1111111111111111111111111111111111111111";
const BANDS = ["VERY LOW", "LOW", "MODERATE", "ELEVATED", "HIGH"];
const INDEXER_MSG = "indexer module not built yet";
const API_MSG = "api module not built yet";
const SCORE_MSG = "score engine not built yet";

describe("SPORE backend integration", { timeout: 600000 }, () => {
  let ctx;
  let availability = {};
  let db;
  let apiBase = null;
  let scenario;
  let headAtEnd = 0;
  let deployerAddr;
  let scoringRan = false;

  const q = async (sql, params) => rowsOf(await db.query(sql, params));

  const api = async (path) => {
    const res = await fetch(`${apiBase}${path}`);
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  };
  const itemsOf = (body) =>
    Array.isArray(body) ? body : body?.items ?? body?.data ?? body?.rows ?? [];

  const getHead = async () => {
    const provider = ctx.provider ?? ctx.anvil?.provider ?? scenario?.provider;
    if (provider?.getBlockNumber) return Number(await provider.getBlockNumber());
    const url = ctx.rpcUrl ?? ctx.anvil?.rpcUrl ?? ctx.anvil?.url ?? ctx.rpc;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    const j = await res.json();
    return Number(BigInt(j.result));
  };

  const needIndexer = (t) => {
    if (availability.indexer === false) {
      t.skip(INDEXER_MSG);
      return false;
    }
    return true;
  };
  const needApi = (t) => {
    if (availability.api === false || !apiBase) {
      t.skip(API_MSG);
      return false;
    }
    return true;
  };
  const needScore = (t) => {
    if (availability.scoreEngine === false) {
      t.skip(SCORE_MSG);
      return false;
    }
    return true;
  };

  before(
    async () => {
      ctx = await harness.setupStack();
      availability = ctx.services.availability;
      db = ctx.db;
      apiBase = `${ctx.services.api.url}/api/v1`;

      scenario = await harness.runScenario(ctx);
      deployerAddr = ctx.signers.deployer.address;
      headAtEnd = Number(await ctx.provider.getBlockNumber());

      // wait for the indexer to catch up: with CONFIRMATIONS=1 it processes
      // up to head-1, so "caught up" on an idle chain means last >= head-1.
      await harness.waitFor(
        async () => {
          const r = rowsOf(await q("select last_block from sync_state where id = 1"));
          const last = r.length ? Number(get(r[0], "last_block")) : 0;
          return last >= headAtEnd - 1 ? true : false;
        },
        { timeoutMs: 120000, intervalMs: 500, label: `indexer sync to ${headAtEnd - 1}` },
      );

      if (availability.scoreEngine && typeof ctx.services.runScoring === "function") {
        await ctx.services.runScoring();
        scoringRan = true;
      }
    },
    { timeout: 300000 },
  );

  after(
    async () => {
      if (ctx && typeof ctx.teardown === "function") await ctx.teardown();
    },
    { timeout: 120000 },
  );

  it("agents table", { timeout: 240000 }, async (t) => {
    if (!needIndexer(t)) return;
    const rows = byAgent(await q("select * from agents"));
    assert.equal(rows.length, 2);
    rows.forEach((r, i) => {
      assert.ok(eq(get(r, "agent_id", "agentId"), i + 1));
      if (deployerAddr) assert.equal(lc(get(r, "owner")), lc(deployerAddr));
      assert.equal(get(r, "metadata_uri", "metadataUri", "metadataURI"), `ipfs://agent-${i + 1}`);
      assert.ok(isTrue(get(r, "active")));
    });
  });

  it("credit_lines", { timeout: 240000 }, async (t) => {
    if (!needIndexer(t)) return;
    const rows = await q("select * from credit_lines");
    const a1 = forAgent(rows, 1)[0];
    const a2 = forAgent(rows, 2)[0];
    assert.ok(a1 && a2);
    assert.ok(eq(get(a1, "line_limit", "limit", "credit_limit"), E18(1000)));
    assert.ok(eq(get(a1, "drawn"), 0));
    assert.ok(eq(get(a1, "fee_owed", "feeOwed"), 0));
    assert.ok(isTrue(get(a1, "active")));
    assert.ok(isFalse(get(a1, "defaulted")));
    assert.ok(isTrue(get(a2, "defaulted")));
    assert.ok(isFalse(get(a2, "active")));
    assert.ok(eq(get(a2, "drawn"), 0));
  });

  it("borrows table", { timeout: 240000 }, async (t) => {
    if (!needIndexer(t)) return;
    const rows = await q("select * from borrows");
    assert.equal(rows.length, 2);
    const b1 = forAgent(rows, 1)[0];
    const b2 = forAgent(rows, 2)[0];
    assert.ok(eq(get(b1, "amount"), E18(100)));
    assert.ok(eq(get(b1, "fee"), E18(5)));
    assert.ok(eq(get(b2, "amount"), E18(200)));
    assert.ok(eq(get(b2, "fee"), E18(10)));
    let merchant = get(b1, "merchant");
    if (!merchant) {
      const joined = await q(
        "select p.* from borrows b join payments p on p.tx_hash = b.tx_hash where b.agent_id = $1",
        [1],
      );
      assert.ok(joined.length >= 1, "borrow should join a payment by tx_hash");
      merchant = get(joined[0], "merchant");
    }
    assert.equal(lc(merchant), MERCHANT);
  });

  it("repays table", { timeout: 240000 }, async (t) => {
    if (!needIndexer(t)) return;
    const rows = forAgent(await q("select * from repays"), 1);
    assert.equal((await q("select * from repays")).length, 2);
    const sorted = [...rows].sort(
      (a, b) => Number(get(a, "block_number", "blockNumber") ?? 0) - Number(get(b, "block_number", "blockNumber") ?? 0) ||
        Number(get(a, "log_index", "logIndex") ?? 0) - Number(get(b, "log_index", "logIndex") ?? 0),
    );
    assert.equal(sorted.length, 2);
    assert.ok(eq(get(sorted[0], "amount"), E18(50)));
    assert.ok(eq(get(sorted[0], "fee_portion", "feePortion"), E18(5)));
    assert.ok(eq(get(sorted[1], "amount"), E18(55)));
    assert.ok(eq(get(sorted[1], "fee_portion", "feePortion"), 0));
  });

  it("sponsors table", { timeout: 240000 }, async (t) => {
    if (!needIndexer(t)) return;
    const rows = await q("select * from sponsors");
    assert.equal(rows.length, 2);
    const s1 = forAgent(rows, 1)[0];
    const s2 = forAgent(rows, 2)[0];
    assert.ok(eq(get(s1, "amount", "assets"), E18(500)));
    assert.ok(eq(get(s2, "amount", "assets"), E18(300)));
    if (get(s1, "kind", "type")) assert.match(String(get(s1, "kind", "type")).toLowerCase(), /deposit/);
    const b1 = get(s1, "backer", "sponsor", "depositor");
    const b2 = get(s2, "backer", "sponsor", "depositor");
    if (deployerAddr && b2) assert.equal(lc(b2), lc(deployerAddr));
    if (b1 && deployerAddr) assert.notEqual(lc(b1), lc(deployerAddr));
  });

  it("defaults table", { timeout: 240000 }, async (t) => {
    if (!needIndexer(t)) return;
    const rows = await q("select * from defaults");
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.ok(eq(get(r, "agent_id", "agentId"), 2));
    assert.ok(eq(get(r, "drawn_amount", "drawnAmount"), E18(200)));
    assert.ok(eq(get(r, "covered_amount", "coveredAmount"), E18(200)));
    assert.ok(eq(get(r, "shortfall"), 0));
  });

  it("revenues table", { timeout: 240000 }, async (t) => {
    if (!needIndexer(t)) return;
    const rows = await q("select * from revenues");
    assert.ok(rows.length >= 2, "expected at least treasury and vault legs");
    const kinds = rows.map((r) => String(get(r, "kind", "type", "leg")));
    assert.ok(kinds.includes("treasury"), `kinds: ${kinds}`);
    assert.ok(kinds.includes("backer-yield"), `kinds: ${kinds}`);
    const total = rows.reduce((acc, r) => acc + BigInt(normAmt(get(r, "amount"))), 0n);
    assert.ok(eq(total, E18(5)), `total fee routed ${total}`);
  });

  it("payments table", { timeout: 240000 }, async (t) => {
    if (!needIndexer(t)) return;
    const rows = await q("select * from payments");
    assert.equal(rows.length, 2);
    const amounts = rows.map((r) => normAmt(get(r, "amount"))).sort();
    assert.deepEqual(amounts, [E18(100), E18(200)].sort());
    for (const r of rows) {
      assert.ok(get(r, "merchant"), "merchant should be set");
    }
  });

  it("API GET /health", { timeout: 240000 }, async (t) => {
    if (!needApi(t)) return;
    const { status, body } = await api("/health");
    assert.equal(status, 200);
    assert.ok(okish(body.status), "status ok");
    assert.ok(okish(body.db), "db ok");
    assert.ok(okish(body.rpc), "rpc ok");
    assert.ok(eq(body.chainId ?? body.rpc?.chainId, 31337));
    const deployBlock = Number(ctx.deploy?.deployBlock ?? 0);
    const lastBlock = Number(body.lastBlock ?? body.indexer?.lastBlock);
    assert.ok(lastBlock >= deployBlock, `lastBlock ${lastBlock} >= ${deployBlock}`);
  });

  it("API GET /agents", { timeout: 240000 }, async (t) => {
    if (!needApi(t)) return;
    const { status, body } = await api("/agents");
    assert.equal(status, 200);
    assert.ok(eq(body.total, 2));
    const items = itemsOf(body);
    assert.equal(items.length, 2);
    assert.ok(eq(items[0].agentId, 1));
    assert.ok(eq(items[1].agentId, 2));
    assert.equal(String(items[0].agentId), "1");
  });

  it("API GET /agents/1 and 404", { timeout: 240000 }, async (t) => {
    if (!needApi(t)) return;
    const { status, body } = await api("/agents/1");
    assert.equal(status, 200);
    assert.equal(String(body.identity.agentId), "1");
    assert.ok(eq(body.credit.limit, E18(1000)));
    assert.ok(eq(body.credit.drawn, 0));
    assert.ok(eq(body.history.loans, 1));
    assert.ok(eq(body.history.repaid, E18(100)));
    assert.ok(eq(body.history.borrowed, E18(100)));
    const nf = await api("/agents/999");
    assert.equal(nf.status, 404);
    assert.equal(nf.body?.error?.code, "agent_not_found");
  });

  it("API GET /ledger", { timeout: 240000 }, async (t) => {
    if (!needApi(t)) return;
    const { status, body } = await api("/ledger");
    assert.equal(status, 200);
    const items = itemsOf(body);
    assert.ok(
      items.some((i) => i.type === "repay" && String(i.agentId) === "1"),
      "repay row for agent 1",
    );
    assert.ok(
      items.some((i) => i.type === "default" && String(i.agentId) === "2"),
      "default row for agent 2",
    );
    for (let i = 1; i < items.length; i++) {
      assert.ok(
        Number(items[i].blockNumber) <= Number(items[i - 1].blockNumber),
        "newest-first ordering",
      );
    }
    const filtered = await api("/ledger?type=repay");
    assert.equal(filtered.status, 200);
    const fItems = itemsOf(filtered.body);
    assert.ok(fItems.length >= 1);
    assert.ok(fItems.every((i) => i.type === "repay"));
  });

  it("API GET /stats", { timeout: 240000 }, async (
t) => {
    if (!needApi(t)) return;
    const { body: json } = await api("/stats");
    assert.equal(json.agents, 2);
    assert.equal(json.creditIssued, E18(300), "creditIssued = total borrowed principal (100+200)");
    assert.equal(json.repaid, E18(100));
    assert.equal(json.activeCredit, E18(0));
    assert.ok(Math.abs(json.repaymentRate - 100/300) < 1e-9, `repaymentRate ≈ 1/3, got ${json.repaymentRate}`);
    assert.equal(json.decimals, 18);
  });

  it("score engine: repaid agent outscores defaulted agent", { timeout: 240000 }, async (t) => {
    if (!needScore(t)) return;
    if (!needApi(t)) return;
    const a1 = (await api("/agents/1")).body;
    const a2 = (await api("/agents/2")).body;
    assert.ok(a1.score && typeof a1.score.value === "number", "agent 1 scored");
    assert.ok(a2.score && typeof a2.score.value === "number", "agent 2 scored");
    assert.ok(a1.score.value > a2.score.value, `repaid (${a1.score.value}) > defaulted (${a2.score.value})`);
    assert.ok(a1.score.value <= 890 && a2.score.value <= 890, "scores within model max 890");
    assert.ok(["VERY LOW", "LOW", "MODERATE", "ELEVATED", "HIGH"].includes(a1.score.band));
    assert.equal(a1.score.modelVersion, 1);
  });

  it("score history recorded", { timeout: 240000 }, async (t) => {
    if (!needScore(t)) return;
    if (!needApi(t)) return;
    const { body: json } = await api("/agents/1/scores");
    assert.ok(Array.isArray(json.items));
    if (json.items.length > 1) {
      for (let i = 1; i < json.items.length; i++) assert.ok(json.items[i].t >= json.items[i - 1].t, "scores ascending by time");
    }
  });
});
