import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as harness from "./harness.mjs";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const DIGITS = /^\d+$/;
const AMOUNT_KEYS = /^(creditIssued|repaid|activeCredit|limit|drawn|feeOwed|borrowed|paymentVolume|vouched|amount)$/;
const LEDGER_TYPES = new Set(["borrow", "repay", "default", "sponsor", "payment", "credit_issued", "limit_changed"]);

let ctx = {};
let services = null;
let api = null;
let availability = {};
let deploy = null;
let anvil = null;
let db = null;
let scenario = null;
let baseUrl = null;
let apiAvailable = false;

function pick(obj, names) {
  for (const n of names) {
    if (obj && typeof obj[n] === "function") return obj[n];
  }
  return null;
}

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from GET ${path} (status ${res.status}): ${text.slice(0, 200)}`);
  }
  return { status: res.status, json, headers: res.headers };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function rpcBlockNumber() {
  const url = anvil?.rpcUrl ?? anvil?.url ?? anvil?.endpoint;
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    const j = await res.json();
    return parseInt(j.result, 16);
  } catch {
    return null;
  }
}

async function waitForCatchUp(timeoutMs = 90000) {
  const custom = pick(harness, ["waitForIndexer", "waitForIndexerCatchUp", "waitForCatchUp", "waitForCatchup", "waitForSync"]);
  if (custom) {
    try {
      await custom(ctx);
      return;
    } catch {
      // fall through to polling
    }
  }
  const deadline = Date.now() + timeoutMs;
  const head = await rpcBlockNumber();
  // The indexer only processes up to head-CONFIRMATIONS (1 in tests), so on an
  // idle chain "caught up" means lastBlock >= head-1. runScenario mines a
  // finalize block after absorbDefault so every scenario event is in range.
  const target = head == null ? null : head - 1;
  while (Date.now() < deadline) {
    try {
      const { json } = await get("/health");
      if (json && typeof json.lastBlock === "number" && (target == null || json.lastBlock >= target)) {
        const l = await get("/ledger");
        if (l.json && typeof l.json.total === "number" && l.json.total >= 8) return;
      }
    } catch {
      // retry
    }
    await sleep(500);
  }
  throw new Error("indexer did not catch up in time");
}

function walk(node, cb, key = null) {
  cb(key, node);
  if (Array.isArray(node)) {
    for (const v of node) walk(v, cb, key);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) walk(v, cb, k);
  }
}

function assertAmounts(json, label) {
  let count = 0;
  walk(json, (k, v) => {
    if (k && AMOUNT_KEYS.test(k) && v !== null && typeof v !== "object") {
      count++;
      assert.equal(typeof v, "string", `${label}: ${k} must be a string, got ${typeof v}`);
      assert.match(v, DIGITS, `${label}: ${k} must be digits`);
    }
  });
  return count;
}

function apiTest(name, fn, opts = { timeout: 120000 }) {
  it(name, opts, async (t) => {
    if (!apiAvailable) {
      t.skip("api module not built yet");
      return;
    }
    await fn(t);
  });
}

describe("API contract shapes", () => {
  before(
    async () => {
      ctx = await harness.setupStack();
      services = ctx.services;
      api = services.api;
      availability = services.availability;
      deploy = ctx.deploy;
      anvil = ctx.anvil;
      db = ctx.db;
      apiAvailable = availability.api !== false && !!(api && api.url);
      if (!apiAvailable) return;
      baseUrl = `${api.url}/api/v1`;

      scenario = await harness.runScenario(ctx);
      ctx.scenario = scenario;

      await waitForCatchUp();

      if (availability.scoreEngine !== false && typeof services.runScoring === "function") {
        try {
          await services.runScoring();
        } catch (e) {
          console.warn("scoring run failed:", e?.message);
        }
      }
    },
    { timeout: 300000 }
  );

  after(
    async () => {
      if (ctx && typeof ctx.teardown === "function") await ctx.teardown();
    },
    { timeout: 60000 }
  );

  apiTest("GET /health", async () => {
    const { status, json } = await get("/health");
    assert.equal(status, 200);
    assert.equal(json.status, "ok");
    assert.equal(json.chainId, 31337);
    assert.equal(typeof json.lastBlock, "number");
    const deployBlock = Number(deploy?.deployBlock ?? 0);
    assert.ok(json.lastBlock >= deployBlock, "lastBlock >= deployBlock");
    assert.equal(typeof json.lastSyncAt, "string");
    assert.equal(typeof json.confirmations, "number");
    assert.equal(json.db, "ok");
    assert.equal(json.rpc, "ok");
    assert.equal(typeof json.services, "object");
    for (const key of ["indexer", "scoreEngine", "oraclePublisher"]) {
      if (availability[key] === false) {
        assert.ok(["ok", "down", "unknown"].includes(json.services[key]), `services.${key}`);
      } else {
        assert.equal(json.services[key], "ok", `services.${key}`);
      }
    }
  });

  apiTest("GET /protocol", async () => {
    const { status, json } = await get("/protocol");
    assert.equal(status, 200);
    assert.equal(json.active, true);
    assert.equal(json.chainId, 31337);
    assert.equal(json.chainName, "Robinhood Chain");
    assert.match(json.asset.address, ADDR);
    assert.equal(json.asset.decimals, 18);
    assert.equal(typeof json.asset.symbol, "string");
    const keys = ["registry", "creditManager", "backerVault", "scoreOracle", "feeRouter"];
    const deployed = deploy?.contracts ?? deploy?.addresses ?? deploy ?? {};
    for (const k of keys) {
      assert.match(json.contracts[k], ADDR, `contracts.${k}`);
      const expected = deployed[k];
      if (typeof expected === "string") {
        assert.equal(json.contracts[k].toLowerCase(), expected.toLowerCase(), `contracts.${k} matches deploy`);
      } else if (expected && typeof expected.address === "string") {
        assert.equal(json.contracts[k].toLowerCase(), expected.address.toLowerCase(), `contracts.${k} matches deploy`);
      }
    }
    assert.equal(json.scoreModel.version, 1);
    assert.equal(json.scoreModel.status, "provisional");
  });

  apiTest("GET /stats", async () => {
    const { status, json } = await get("/stats");
    assert.equal(status, 200);
    assert.equal(json.agents, 2);
    // creditIssued = total borrowed principal (per the frozen contract example
    // 500 = 120 repaid + 380 active): 100 + 200 here.
    assert.equal(json.creditIssued, "300000000000000000000");
    assert.equal(json.repaid, "100000000000000000000");
    assert.equal(json.activeCredit, "0");
    // repaymentRate = repaid / (repaid + defaulted drawn) = 100 / 300
    assert.ok(Math.abs(json.repaymentRate - 100 / 300) < 1e-9, `repaymentRate ≈ 1/3, got ${json.repaymentRate}`);
    assert.equal(json.decimals, 18);
  });

  apiTest("GET /agents pagination and item shape", async () => {
    const { status, json } = await get("/agents?limit=1&offset=1");
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.items));
    assert.equal(json.items.length, 1);
    assert.equal(json.total, 2);
    const item = json.items[0];
    assert.equal(item.agentId, "2");
    assert.equal(typeof item.agentId, "string");
    assert.match(item.owner, ADDR);
    assert.ok(item.score === null || typeof item.score === "number");
    assert.ok(item.band === null || typeof item.band === "string");
    assert.equal(typeof item.creditLimit, "string");
    assert.match(item.creditLimit, DIGITS);
    assert.equal(typeof item.loansRepaid, "number");
    assert.equal(typeof item.defaults, "number");
    assert.ok(item.utilization === null || typeof item.utilization === "number");
    assert.equal(typeof item.ageDays, "number");

    const all = await get("/agents");
    assert.equal(all.status, 200);
    const ids = all.json.items.map((i) => BigInt(i.agentId));
    for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1], "agent_id ascending");
  });

  apiTest("GET /agents/1 dossier", async () => {
    const { status, json } = await get("/agents/1");
    assert.equal(status, 200);

    const id = json.identity;
    assert.ok(id && typeof id === "object");
    for (const k of ["agentId", "owner", "metadataUri", "active", "ageDays", "registeredAt"]) {
      assert.ok(k in id, `identity.${k}`);
    }
    assert.match(id.owner, ADDR);
    assert.equal(typeof id.active, "boolean");
    assert.equal(typeof id.ageDays, "number");

    assert.ok("score" in json);
    if (json.score !== null) {
      for (const k of ["value", "band", "modelVersion", "updatedAt", "dimensions"]) {
        assert.ok(k in json.score, `score.${k}`);
      }
      assert.equal(typeof json.score.value, "number");
      assert.ok(json.score.value <= 890, "score <= 890");
      assert.equal(typeof json.score.band, "string");
      assert.ok(json.score.band.length > 0);
      assert.equal(typeof json.score.dimensions, "object");
    }

    const c = json.credit;
    for (const k of ["limit", "drawn", "feeOwed", "feeBps", "active", "defaulted"]) {
      assert.ok(k in c, `credit.${k}`);
    }
    assert.equal(c.limit, "1000000000000000000000");
    assert.equal(c.feeBps, 500);
    assert.equal(typeof c.active, "boolean");
    assert.equal(typeof c.defaulted, "boolean");

    const h = json.history;
    for (const k of ["borrowed", "repaid", "loans", "defaults", "onTimeRate"]) {
      assert.ok(k in h, `history.${k}`);
    }
    assert.equal(h.loans, 1);
    assert.equal(h.defaults, 0);

    const e = json.economics;
    for (const k of ["paymentVolume", "utilization", "backers", "vouched"]) {
      assert.ok(k in e, `economics.${k}`);
    }
    assert.equal(e.backers, 1);
    assert.ok("decimals" in json);
    assert.equal(json.decimals, 18);
  });

  apiTest("GET /agents/999 → 404", async () => {
    const { status, json } = await get("/agents/999");
    assert.equal(status, 404);
    assert.equal(json.error.code, "agent_not_found");
    assert.equal(typeof json.error.message, "string");
  });

  apiTest("GET /agents/1/scores", async () => {
    const { status, json } = await get("/agents/1/scores");
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.items));
    for (const it of json.items) {
      assert.equal(typeof it.t, "string");
      assert.equal(typeof it.score, "number");
    }
    for (let i = 1; i < json.items.length; i++) {
      assert.ok(
        new Date(json.items[i].t).getTime() >= new Date(json.items[i - 1].t).getTime(),
        "scores ascending by t"
      );
    }
  });

  apiTest("GET /ledger", async () => {
    const { status, json } = await get("/ledger");
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.items));
    assert.equal(typeof json.total, "number");
    assert.ok(json.total >= 8, `total >= 8, got ${json.total}`);
    for (const it of json.items) {
      for (const k of ["type", "agentId", "amount", "txHash", "blockNumber", "t"]) {
        assert.ok(k in it, `ledger item.${k}`);
      }
      assert.ok(LEDGER_TYPES.has(it.type), `unexpected ledger type ${it.type}`);
    }
    for (let i = 1; i < json.items.length; i++) {
      assert.ok(
        Number(json.items[i].blockNumber) <= Number(json.items[i - 1].blockNumber),
        "blockNumber non-increasing"
      );
    }
  });

  apiTest("GET /ledger?type=repay and invalid type", async () => {
    const { status, json } = await get("/ledger?type=repay");
    assert.equal(status, 200);
    assert.equal(json.items.length, 2);
    for (const it of json.items) assert.equal(it.type, "repay");

    const bogus = await get("/ledger?type=bogus");
    assert.ok(bogus.status < 500, `bogus type must not 500, got ${bogus.status}`);
    if (bogus.status === 200) {
      assert.ok(Array.isArray(bogus.json.items));
      assert.equal(bogus.json.items.length, 0);
    } else {
      assert.equal(bogus.status, 400);
    }
  });

  apiTest("Cache-Control headers", async () => {
    const stats = await get("/stats");
    assert.match(stats.headers.get("cache-control") ?? "", /max-age=15/);
    const agents = await get("/agents");
    assert.match(agents.headers.get("cache-control") ?? "", /max-age=15/);
    const dossier = await get("/agents/1");
    assert.match(dossier.headers.get("cache-control") ?? "", /max-age=60/);
  });

  apiTest("Amounts are decimal strings", async () => {
    const dossier = await get("/agents/1");
    const stats = await get("/stats");
    const n1 = assertAmounts(dossier.json, "/agents/1");
    const n2 = assertAmounts(stats.json, "/stats");
    assert.ok(n1 > 0, "found amount keys in /agents/1");
    assert.ok(n2 > 0, "found amount keys in /stats");
  });
});
