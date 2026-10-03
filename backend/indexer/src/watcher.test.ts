import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { createDb, runMigrations } from "@spore/common";
import type { Interface } from "ethers";
import { ChainWatcher, type ChainReader } from "./watcher.js";
import { loadSporeAbis, buildSporeInterface } from "./abis.js";

type DbClient = Awaited<ReturnType<typeof createDb>>;

const here = path.dirname(fileURLToPath(import.meta.url));
const artifactsDir = path.resolve(here, "../../../contracts/out");
const migrationsDir = path.resolve(here, "../../db/migrations");

const logger = pino({ level: "silent" });
const OWNER = "0x" + "11".repeat(20);
const MERCHANT = "0x" + "22".repeat(20);

function blockHash(n: number): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function rowsOf(res: any): any[] {
  return Array.isArray(res) ? res : res.rows;
}

type RawLog = {
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  index: number;
  topics: readonly string[];
  data: string;
};

class MockReader implements ChainReader {
  blocks = new Map<number, { hash: string | null; timestamp: number }>();
  logs: RawLog[] = [];
  head = 0;
  failGetBlockNumber = 0;

  constructor() {
    for (let n = 1; n <= 30; n++) {
      this.blocks.set(n, { hash: blockHash(n), timestamp: 1700000000 + n });
    }
  }

  async getBlockNumber(): Promise<number> {
    if (this.failGetBlockNumber > 0) {
      this.failGetBlockNumber--;
      throw new Error("rpc down");
    }
    return this.head;
  }

  async getBlock(n: number) {
    return this.blocks.get(n) ?? null;
  }

  async getLogs(f: { address: string[]; fromBlock: number; toBlock: number }) {
    return this.logs
      .filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock)
      .sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  }

  async getNetwork() {
    return { chainId: 4663n };
  }
}

describe("ChainWatcher", () => {
  let db: DbClient;
  let reader: MockReader;
  let iface: Interface;
  let applied: Array<{ name: string; blockNumber: number; logIndex: number }>;

  beforeAll(async () => {
    const abis = loadSporeAbis(artifactsDir);
    iface = buildSporeInterface(abis);
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
    reader = new MockReader();
    applied = [];
  });

  function mkLog(
    blockNumber: number,
    index: number,
    eventName: string,
    args: unknown[],
    txHash: string,
  ): RawLog {
    const ev = iface.getEvent(eventName)!;
    const { topics, data } = iface.encodeEventLog(ev, args);
    return {
      blockNumber,
      blockHash: blockHash(blockNumber),
      transactionHash: txHash,
      index,
      topics,
      data,
    };
  }

  function seed(r: MockReader) {
    r.head = 20;
    r.logs = [
      mkLog(12, 1, "Borrow", [1n, 3000n, 150n], "0x" + "b1".repeat(32)),
      mkLog(10, 0, "AgentRegistered", [1n, OWNER, "ipfs://meta"], "0x" + "b2".repeat(32)),
      mkLog(11, 0, "CreditIssued", [1n, 10000n, 500n], "0x" + "b3".repeat(32)),
      mkLog(10, 1, "Payment", [1n, MERCHANT, 100n], "0x" + "b4".repeat(32)),
    ];
  }

  function makeWatcher(overrides: Record<string, unknown> = {}, r: MockReader = reader) {
    return new ChainWatcher({
      reader: r,
      db,
      iface,
      config: {
        chainId: 4663,
        deployBlock: 10,
        confirmations: 2,
        pollMs: 20,
        backfillChunkSize: 5,
        contractAddresses: ["0x" + "aa".repeat(20)],
      },
      logger,
      applyEventFn: async (ev: { name: string }, meta: { logIndex: number; blockNumber: number }) => {
        applied.push({ name: ev.name, blockNumber: meta.blockNumber, logIndex: meta.logIndex });
      },
      ...overrides,
    } as any);
  }

  async function syncState() {
    const res = await db.query("SELECT last_block, last_hash FROM sync_state");
    const r = rowsOf(res)[0];
    return { lastBlock: Number(r.last_block), lastHash: r.last_hash as string };
  }

  it("backfill processes logs in order and advances cursor", async () => {
    seed(reader);
    const watcher = makeWatcher();
    await watcher.tick();

    expect(applied).toEqual([
      { name: "AgentRegistered", blockNumber: 10, logIndex: 0 },
      { name: "Payment", blockNumber: 10, logIndex: 1 },
      { name: "CreditIssued", blockNumber: 11, logIndex: 0 },
      { name: "Borrow", blockNumber: 12, logIndex: 1 },
    ]);
    const s = await syncState();
    expect(s.lastBlock).toBe(18);
    expect(s.lastHash).toBe(blockHash(18));
  });

  it("restart resumes from cursor without duplicates", async () => {
    seed(reader);
    await makeWatcher().tick();
    const n = applied.length;
    expect(n).toBe(4);

    const reader2 = new MockReader();
    seed(reader2);
    await makeWatcher({}, reader2).tick();

    expect(applied.length).toBe(n);
    const s = await syncState();
    expect(s.lastBlock).toBe(18);
  });

  it("reorg triggers full rebuild", async () => {
    seed(reader);
    const watcher = makeWatcher();
    await watcher.tick();
    expect((await syncState()).lastBlock).toBe(18);

    await db.query(
      "INSERT INTO agents (agent_id, owner, chain_id, block_number, tx_hash, log_index, block_time) VALUES (999, '0xabc', 4663, 18, '0xmarker', 0, now())",
    );
    const before = rowsOf(await db.query("SELECT count(*)::int AS c FROM agents"))[0];
    expect(Number(before.c)).toBe(1);

    reader.blocks.set(18, { hash: "0xdead", timestamp: 1700000018 });
    await watcher.tick();

    const after = rowsOf(await db.query("SELECT count(*)::int AS c FROM agents"))[0];
    expect(Number(after.c)).toBe(0);
    const s = await syncState();
    expect(s.lastBlock).toBe(18);
    expect(s.lastHash).toBe("0xdead");
  });

  it("RPC errors back off without crashing", async () => {
    seed(reader);
    reader.failGetBlockNumber = 2;
    const watcher = makeWatcher();
    const p = watcher.start();
    await sleep(6000);
    await watcher.stop();
    await expect(p).resolves.toBeUndefined();

    const s = await syncState();
    expect(s.lastBlock).toBe(18);
  }, 25000);
});
