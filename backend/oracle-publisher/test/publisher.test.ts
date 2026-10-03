import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Logger } from "pino";
import { loadConfig } from "../src/config.js";
import type { OraclePublisherConfig } from "../src/config.js";
import { createDb, getPendingScores, markPublished } from "../src/db.js";
import type { DbClient, ScoreRow } from "../src/db.js";
import {
  decidePublish,
  limitToBaseUnits,
  withRetry,
  runPublishRound,
  startPublisher,
} from "../src/publisher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
} as unknown as Logger;

function makeRow(over: Partial<ScoreRow> = {}): ScoreRow {
  return {
    agent_id: "7",
    score: 720,
    band: "LOW",
    limit_base: "250",
    model_version: 1,
    computed_at: new Date("2026-10-03T10:00:00Z"),
    published_at: null,
    published_tx: null,
    ...over,
  } as ScoreRow;
}

class FakeDb implements DbClient {
  rows: ScoreRow[];
  closed = false;
  constructor(rows: ScoreRow[]) {
    this.rows = rows;
  }
  async query(text: string, params: unknown[] = []): Promise<any> {
    const t = text.trim().toUpperCase();
    if (t.startsWith("SELECT")) {
      const pending = this.rows
        .filter(
          (r) =>
            r.published_at === null ||
            new Date(r.computed_at as any) > new Date(r.published_at as any),
        )
        .sort((a, b) => Number(BigInt(a.agent_id as any) - BigInt(b.agent_id as any)));
      return { rows: pending };
    }
    if (t.startsWith("UPDATE")) {
      const row = this.rows.find((r) => String(r.agent_id) === String(params[0]));
      if (row) {
        (row as any).published_at = new Date();
        (row as any).published_tx = params[1];
      }
      return { rows: [] };
    }
    return { rows: [] };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeReader(over: Record<string, unknown> = {}) {
  return {
    hasScore: vi.fn(async () => true),
    getScore: vi.fn(async () => ({
      score: 720,
      limit: 250n * 10n ** 18n,
      updatedAt: 1700000000n,
      modelVersion: 1,
    })),
    isFresh: vi.fn(async () => true),
    maxStalePeriod: vi.fn(async () => 3600n),
    ...over,
  } as any;
}

function makeWriter(over: Record<string, unknown> = {}) {
  return {
    publishScore: vi.fn(async () => "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
    ...over,
  } as any;
}

function makeConfig(over: Partial<OraclePublisherConfig> | Record<string, unknown> = {}): OraclePublisherConfig {
  return {
    rpcUrl: "http://127.0.0.1:8545",
    oracleAddress: "0x0000000000000000000000000000000000000001",
    chainId: 31337,
    assetDecimals: 18,
    scoreIntervalMs: 50,
    dryRun: false,
    watchMode: false,
    livePublish: true,
    hasPrivateKey: true,
    logLevel: "silent",
    databaseUrl: "pglite://memory",
    maxPublishAttempts: 2,
    baseBackoffMs: 1,
    publishTimeoutMs: 60000,
    ...over,
  } as unknown as OraclePublisherConfig;
}

const NOW = new Date("2026-10-03T12:00:00Z").getTime();
const nowSec = BigInt(Math.floor(NOW / 1000));
const nowMs = () => NOW;

function deps(over: Record<string, unknown>) {
  return { logger: stubLogger, nowMs, ...over } as any;
}

// ---------------------------------------------------------------------------
// limitToBaseUnits
// ---------------------------------------------------------------------------

describe("limitToBaseUnits", () => {
  it("converts whole-unit ladder values", () => {
    expect(limitToBaseUnits("250", 18)).toBe(250n * 10n ** 18n);
    expect(limitToBaseUnits("0", 18)).toBe(0n);
  });

  it("passes through values already in base units", () => {
    expect(limitToBaseUnits("250000000000000000000", 18)).toBe(250000000000000000000n);
  });

  it("handles decimals 0", () => {
    expect(limitToBaseUnits("25", 0)).toBe(25n);
  });

  it("throws on non-numeric input", () => {
    expect(() => limitToBaseUnits("abc", 18)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// decidePublish
// ---------------------------------------------------------------------------

describe("decidePublish", () => {
  const maxStale = 3600n;
  const freshRow = () => makeRow({ computed_at: new Date(NOW) });
  const onChainBase = () => ({
    score: 720,
    limit: 250n * 10n ** 18n,
    modelVersion: 1,
    updatedAt: nowSec - 100n,
  });
  const decide = (row: ScoreRow, onChain: any) =>
    decidePublish(
      row,
      onChain,
      limitToBaseUnits(row.limit_base, 18),
      maxStale,
      nowSec,
    );

  it("publishes when there is no on-chain record", () => {
    const d = decide(freshRow(), null);
    expect(d.action).toBe("publish");
    expect(d.reason).toContain("no on-chain record");
  });

  it("skips identical fresh on-chain data", () => {
    expect(decide(freshRow(), onChainBase()).action).toBe("skip-identical");
  });

  it("publishes on changed score", () => {
    const d = decide(freshRow(), { ...onChainBase(), score: 700 });
    expect(d.action).toBe("publish");
    expect(d.reason).toContain("score-changed");
  });

  it("publishes on changed limit", () => {
    const d = decide(freshRow(), { ...onChainBase(), limit: 100n * 10n ** 18n });
    expect(d.action).toBe("publish");
    expect(d.reason).toContain("limit-changed");
  });

  it("refreshes stale on-chain data even if identical", () => {
    const d = decide(freshRow(), { ...onChainBase(), updatedAt: nowSec - 7200n });
    expect(d.action).toBe("publish");
    expect(d.reason).toContain("stale-onchain-refresh");
  });

  it("skips rows that are born stale", () => {
    const row = makeRow({ computed_at: new Date(NOW - 7200_000) });
    expect(decide(row, null).action).toBe("skip-born-stale");
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe("withRetry", () => {
  it("succeeds after two failures", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls <= 2) throw new Error("boom");
      return "ok";
    };
    const res = await withRetry(fn, {
      maxAttempts: 3,
      baseMs: 1,
      logger: stubLogger,
      label: "test",
      sleepMs: async () => {},
    });
    expect(res).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws after attempts are exhausted", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error("always");
    };
    await expect(
      withRetry(fn, { maxAttempts: 2, baseMs: 1, logger: stubLogger, label: "test", sleepMs: async () => {} }),
    ).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runPublishRound
// ---------------------------------------------------------------------------

describe("runPublishRound", () => {
  it("dry-run logs only and makes zero on-chain calls", async () => {
    const db = new FakeDb([makeRow({ computed_at: new Date(NOW) })]);
    const result = await runPublishRound(
      deps({
        config: makeConfig({ dryRun: true, watchMode: false, livePublish: false }),
        db,
        reader: null,
        writer: null,
      }),
    );
    expect((result as any).dryLogged).toBe(1);
    expect((result as any).published).toBe(0);
    expect(db.rows[0].published_tx).toBeNull();
  });

  it("dry mode rejects reader/writer and never calls them", async () => {
    const boom = () => {
      throw new Error("must not be called");
    };
    const reader = {
      hasScore: vi.fn(boom),
      getScore: vi.fn(boom),
      isFresh: vi.fn(boom),
      maxStalePeriod: vi.fn(boom),
    };
    const writer = { publishScore: vi.fn(boom) };
    const db = new FakeDb([makeRow({ computed_at: new Date(NOW) })]);
    await expect(
      runPublishRound(
        deps({
          config: makeConfig({ dryRun: true, watchMode: false, livePublish: false }),
          db,
          reader,
          writer,
        }),
      ),
    ).rejects.toThrow();
    for (const fn of Object.values(reader)) expect(fn).not.toHaveBeenCalled();
    expect(writer.publishScore).not.toHaveBeenCalled();
  });

  it("publishes a new record live", async () => {
    const db = new FakeDb([makeRow({ computed_at: new Date(NOW) })]);
    const reader = makeReader({ hasScore: vi.fn(async () => false) });
    const writer = makeWriter();
    const result: any = await runPublishRound(
      deps({ config: makeConfig(), db, reader, writer }),
    );
    expect(writer.publishScore).toHaveBeenCalledTimes(1);
    expect(writer.publishScore).toHaveBeenCalledWith(7n, 720, 250n * 10n ** 18n, 1);
    expect(result.published).toBe(1);
    expect(db.rows[0].published_tx).toBeTruthy();
    expect(db.rows[0].published_at).not.toBeNull();
  });

  it("skips identical on-chain data", async () => {
    const db = new FakeDb([makeRow({ computed_at: new Date(NOW) })]);
    const reader = makeReader({
      getScore: vi.fn(async () => ({
        score: 720,
        limit: 250n * 10n ** 18n,
        updatedAt: nowSec - 100n,
        modelVersion: 1,
      })),
    });
    const writer = makeWriter();
    const result: any = await runPublishRound(
      deps({ config: makeConfig(), db, reader, writer }),
    );
    expect(result.published).toBe(0);
    expect(result.skippedIdentical).toBe(1);
    expect(writer.publishScore).not.toHaveBeenCalled();
  });

  it("publishes when score changed", async () => {
    const db = new FakeDb([makeRow({ computed_at: new Date(NOW) })]);
    const reader = makeReader({
      getScore: vi.fn(async () => ({
        score: 700,
        limit: 250n * 10n ** 18n,
        updatedAt: nowSec - 100n,
        modelVersion: 1,
      })),
    });
    const writer = makeWriter();
    const result: any = await runPublishRound(
      deps({ config: makeConfig(), db, reader, writer }),
    );
    expect(result.published).toBe(1);
    expect(writer.publishScore.mock.calls[0][1]).toBe(720);
  });

  it("skips born-stale rows", async () => {
    const db = new FakeDb([makeRow({ computed_at: new Date(NOW - 7200_000) })]);
    const reader = makeReader({ hasScore: vi.fn(async () => false) });
    const writer = makeWriter();
    const result: any = await runPublishRound(
      deps({ config: makeConfig(), db, reader, writer }),
    );
    expect(result.skippedBornStale).toBe(1);
    expect(writer.publishScore).not.toHaveBeenCalled();
  });

  it("leaves row unpublished on persistent rpc failure", async () => {
    const db = new FakeDb([makeRow({ computed_at: new Date(NOW) })]);
    const reader = makeReader({ hasScore: vi.fn(async () => false) });
    const writer = makeWriter({
      publishScore: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    });
    const result: any = await runPublishRound(
      deps({ config: makeConfig(), db, reader, writer }),
    );
    expect(result.published).toBe(0);
    expect(result.failed).toBe(1);
    expect(db.rows[0].published_tx).toBeNull();
  });

  it("fails invalid rows without calling the writer", async () => {
    const db = new FakeDb([makeRow({ score: 1001, computed_at: new Date(NOW) })]);
    const reader = makeReader({ hasScore: vi.fn(async () => false) });
    const writer = makeWriter();
    const result: any = await runPublishRound(
      deps({ config: makeConfig(), db, reader, writer }),
    );
    expect(result.failed).toBe(1);
    expect(writer.publishScore).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  let saved: NodeJS.ProcessEnv;
  const KEYS = [
    "DATABASE_URL",
    "ORACLE_ADDRESS",
    "ORACLE_PRIVATE_KEY",
    "DRY_RUN",
    "RPC_URL",
    "ASSET_DECIMALS",
  ];

  beforeEach(() => {
    saved = { ...process.env };
    for (const k of KEYS) delete process.env[k];
    process.env.DATABASE_URL = "pglite://memory";
    process.env.ORACLE_ADDRESS = "0x0000000000000000000000000000000000000001";
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  });

  it("without a key: watch mode, no live publish, dry run default", () => {
    const c = loadConfig();
    expect(c.watchMode).toBe(true);
    expect(c.livePublish).toBe(false);
    expect(c.dryRun).toBe(true);
  });

  it("key + DRY_RUN=false + RPC_URL enables live publish", () => {
    process.env.ORACLE_PRIVATE_KEY = "0x" + "ab".repeat(32);
    process.env.DRY_RUN = "false";
    process.env.RPC_URL = "http://127.0.0.1:8545";
    const c = loadConfig();
    expect(c.livePublish).toBe(true);
  });

  it("key set but DRY_RUN unset stays dry", () => {
    process.env.ORACLE_PRIVATE_KEY = "0x" + "ab".repeat(32);
    const c = loadConfig();
    expect(c.dryRun).toBe(true);
    expect(c.livePublish).toBe(false);
  });

  it("throws on malformed key", () => {
    process.env.ORACLE_PRIVATE_KEY = "0x123";
    expect(() => loadConfig()).toThrow();
  });

  it("throws on missing ORACLE_ADDRESS", () => {
    delete process.env.ORACLE_ADDRESS;
    expect(() => loadConfig()).toThrow();
  });

  it("throws on bad ASSET_DECIMALS", () => {
    process.env.ASSET_DECIMALS = "abc";
    expect(() => loadConfig()).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Real PGlite
// ---------------------------------------------------------------------------

describe("db with real PGlite", () => {
  it("returns pending scores and marks them published", async () => {
    const db: any = await createDb("pglite://memory");
    try {
      const sql = readFileSync(
        new URL("../../db/migrations/001_schema.sql", import.meta.url),
        "utf8",
      );
      // PGlite rejects multi-statement prepared queries, and the frozen
      // migration contains ";" inside "--" comments, so strip full-line
      // comments before splitting into statements.
      const stmts = sql
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of stmts) await db.query(stmt);

      await db.query(
        `INSERT INTO agents (agent_id, owner, metadata_uri, active, chain_id, block_number, tx_hash, log_index, block_time)
         VALUES (7, '0x0000000000000000000000000000000000000002', '', true, 31337, 1, '0xaaa', 0, now())`,
      );
      await db.query(
        `INSERT INTO scores (agent_id, score, band, limit_base, model_version, dimensions, computed_at)
         VALUES (7, 720, 'LOW', '250', 1, '{}', now())`,
      );

      const pending = await getPendingScores(db);
      expect(pending).toHaveLength(1);
      expect(pending[0].limit_base).toBe("250");

      await markPublished(db, 7n, "0xtx");
      const after = await getPendingScores(db);
      expect(after).toHaveLength(0);
    } finally {
      await db.close();
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// startPublisher
// ---------------------------------------------------------------------------

describe("startPublisher", () => {
  it("runs dry rounds without mutating rows; stop is idempotent", async () => {
    const row = makeRow({ computed_at: new Date() });
    const db = new FakeDb([row]);
    const handle = await startPublisher(
      makeConfig({
        scoreIntervalMs: 30,
        dryRun: true,
        watchMode: false,
        livePublish: false,
      }),
      stubLogger,
      db,
      null,
      null,
    );
    await new Promise((r) => setTimeout(r, 120));
    await expect(Promise.resolve(handle.stop())).resolves.not.toThrow();
    await expect(Promise.resolve(handle.stop())).resolves.not.toThrow();
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].published_at).toBeNull();
    expect(db.rows[0].published_tx).toBeNull();
  });
});
