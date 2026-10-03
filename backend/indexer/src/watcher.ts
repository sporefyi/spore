import { Interface } from "ethers";
import type { DbClient, Logger, SyncStateRow } from "@spore/common";
import { applyEvent } from "./handlers.js";

export interface ChainReader {
  getBlockNumber(): Promise<number>;
  getBlock(n: number): Promise<{ hash: string | null; timestamp: number } | null>;
  getLogs(f: { address: string[]; fromBlock: number; toBlock: number }): Promise<
    Array<{
      blockNumber: number;
      blockHash: string;
      transactionHash: string;
      index: number; // log index within the block (ethers v6 names this `index`)
      topics: readonly string[];
      data: string;
    }>
  >;
  getNetwork(): Promise<{ chainId: bigint }>;
}

export interface WatcherConfig {
  chainId: number;
  deployBlock: number;
  confirmations: number;
  pollMs: number;
  backfillChunkSize: number;
  contractAddresses: string[];
}

// Chain-derived tables truncated on rebuild. `agents` is NOT truncated:
// scores/score_history hold FKs to agents(agent_id) and must be kept per
// EVENT_MAPPING.md, and Postgres refuses TRUNCATE on an FK-referenced table.
// Instead agents are deleted except those still referenced by scores — the
// re-backfill re-registers every agent idempotently (rowCount-gated
// handlers), so kept agents' state is rebuilt and their scores stay valid.
const TRUNCATE_TABLES = [
  "credit_lines",
  "borrows",
  "repays",
  "defaults",
  "sponsors",
  "payments",
  "revenues",
  "credit_limit_changes",
  "yield_allocations",
];

export class ChainWatcher {
  private readonly reader: ChainReader;
  private readonly db: DbClient;
  private readonly iface: Interface;
  private readonly config: WatcherConfig;
  private readonly logger: Logger;
  private readonly applyEventFn: typeof applyEvent;

  private chainId: number;
  private stopping = false;
  private wake: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(deps: {
    reader: ChainReader;
    db: DbClient;
    iface: Interface;
    config: WatcherConfig;
    logger: Logger;
    applyEventFn?: typeof applyEvent;
  }) {
    this.reader = deps.reader;
    this.db = deps.db;
    this.iface = deps.iface;
    this.config = deps.config;
    this.logger = deps.logger;
    this.applyEventFn = deps.applyEventFn ?? applyEvent;
    this.chainId = deps.config.chainId;
  }

  async start(): Promise<void> {
    this.stopping = false;
    const network = await this.reader.getNetwork();
    const reported = Number(network.chainId);
    if (this.config.chainId !== 0 && reported !== this.config.chainId) {
      throw new Error(
        `chain id mismatch: expected ${this.config.chainId}, provider reports ${reported}`,
      );
    }
    this.chainId = this.config.chainId === 0 ? reported : this.config.chainId;
    this.logger.info({ chainId: this.chainId }, "watcher starting");

    this.loopPromise = this.runLoop();
    await this.loopPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.wake) this.wake();
    if (this.loopPromise) {
      await this.loopPromise;
    }
    this.logger.info("watcher stopped");
  }

  async tick(): Promise<void> {
    const head = await this.reader.getBlockNumber();
    const safeHead = head - this.config.confirmations;
    if (safeHead < 0) {
      this.logger.debug({ head }, "safe head below zero, nothing to do");
      return;
    }

    let state = await this.readSyncState();
    if (!state) {
      await this.db.query(
        "INSERT INTO sync_state (id, last_block, last_hash, deploy_block) VALUES (1, 0, '', $1) ON CONFLICT (id) DO NOTHING",
        [this.config.deployBlock],
      );
      state = await this.readSyncState();
      if (!state) throw new Error("failed to initialise sync_state");
    }

    const lastBlock = Number(state.last_block);

    if (lastBlock === 0) {
      await this.processRange(this.config.deployBlock, safeHead);
      return;
    }

    const chainBlock = await this.reader.getBlock(lastBlock);
    if (!chainBlock?.hash || chainBlock.hash !== state.last_hash) {
      this.logger.warn(
        {
          lastBlock,
          storedHash: state.last_hash,
          chainHash: chainBlock?.hash ?? null,
        },
        "reorg detected, performing full rebuild",
      );
      await this.db.withTx(async (tx) => {
        await tx.query(`TRUNCATE ${TRUNCATE_TABLES.join(", ")}`, []);
        await tx.query(
          `DELETE FROM agents WHERE agent_id NOT IN (
             SELECT agent_id FROM scores UNION SELECT agent_id FROM score_history
           )`,
          [],
        );
        await tx.query("UPDATE sync_state SET last_block=0, last_hash=''", []);
      });
      await this.processRange(this.config.deployBlock, safeHead);
      return;
    }

    if (lastBlock < safeHead) {
      await this.processRange(lastBlock + 1, safeHead);
    } else {
      this.logger.debug({ lastBlock, safeHead }, "no new blocks");
    }
  }

  private async readSyncState(): Promise<SyncStateRow | null> {
    const res = await this.db.query(
      "SELECT last_block, last_hash, deploy_block FROM sync_state WHERE id = 1",
      [],
    );
    const rows = res.rows as SyncStateRow[];
    return rows.length > 0 ? (rows[0] as SyncStateRow) : null;
  }

  private async processRange(from: number, to: number): Promise<void> {
    if (from > to) return;
    const chunkSize = Math.max(1, this.config.backfillChunkSize);

    for (let chunkStart = from; chunkStart <= to; chunkStart += chunkSize) {
      if (this.stopping) return;
      const chunkEnd = Math.min(to, chunkStart + chunkSize - 1);

      const logs = await this.reader.getLogs({
        address: this.config.contractAddresses,
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });

      const sorted = [...logs].sort((a, b) =>
        a.blockNumber !== b.blockNumber
          ? a.blockNumber - b.blockNumber
          : a.index - b.index,
      );

      const decoded = sorted.map((log) => {
        let parsed;
        try {
          parsed = this.iface.parseLog({ topics: log.topics, data: log.data });
        } catch (err) {
          throw new Error(
            `failed to decode log block=${log.blockNumber} index=${log.index} tx=${log.transactionHash}: ${String(err)}`,
          );
        }
        if (!parsed) {
          // Not a known SPORE event (e.g. an OZ RoleGranted from admin ops or a
          // future event). Skip with a warning — never halt the indexer on it.
          // Truly unknown *parsed* event names still throw in handlers.
          this.logger.warn(
            { block: log.blockNumber, index: log.index, tx: log.transactionHash },
            "skipping log with unrecognised topic",
          );
          return null;
        }
        const args: Record<string, unknown> = {};
        parsed.fragment.inputs.forEach((input, i) => {
          args[input.name] = parsed.args[i];
        });
        return { log, name: parsed.name, args };
      }).filter((d): d is { log: (typeof sorted)[number]; name: string; args: Record<string, unknown> } => d !== null);

      // The frozen indexer set (docs/EVENT_MAPPING.md). Anything else the
      // contracts emit (e.g. OZ RoleGranted from admin ops) is operational
      // noise — skip with a warning, never halt the indexer on it.
      const KNOWN_EVENTS = new Set([
        "AgentRegistered", "CreditIssued", "Borrow", "Repay", "Default",
        "Revenue", "Payment", "Sponsor", "CreditLimitChanged", "YieldAllocated",
      ]);
      const events = decoded.filter((d) => {
        if (KNOWN_EVENTS.has(d.name)) return true;
        this.logger.warn(
          { block: d.log.blockNumber, name: d.name, tx: d.log.transactionHash },
          "skipping event outside the frozen indexer set",
        );
        return false;
      });

      const blockTimes = new Map<number, number>();
      for (const { log } of events) {
        if (blockTimes.has(log.blockNumber)) continue;
        const block = await this.reader.getBlock(log.blockNumber);
        if (!block) {
          throw new Error(`block ${log.blockNumber} not found`);
        }
        blockTimes.set(log.blockNumber, block.timestamp);
      }

      const endBlock = await this.reader.getBlock(chunkEnd);
      if (!endBlock || !endBlock.hash) {
        throw new Error(`block ${chunkEnd} hash unavailable`);
      }
      const endHash = endBlock.hash;

      await this.db.withTx(async (tx) => {
        for (const { log, name, args } of events) {
          const ts = blockTimes.get(log.blockNumber) as number;
          await this.applyEventFn(
            { name, args },
            {
              blockNumber: log.blockNumber,
              blockHash: log.blockHash,
              txHash: log.transactionHash,
              logIndex: log.index,
              blockTime: new Date(ts * 1000),
            },
            tx,
            this.chainId,
          );
        }
        await tx.query(
          "UPDATE sync_state SET last_block=$1, last_hash=$2, updated_at=now() WHERE id = 1",
          [chunkEnd, endHash],
        );
      });

      this.logger.debug(
        { from: chunkStart, to: chunkEnd, events: events.length },
        "processed range",
      );
    }
  }

  private async runLoop(): Promise<void> {
    let attempt = 0;
    let failing = false;

    while (!this.stopping) {
      let delay: number;
      try {
        await this.tick();
        if (failing) {
          this.logger.info("watcher recovered");
          failing = false;
        }
        attempt = 0;
        delay = this.config.pollMs;
      } catch (err) {
        failing = true;
        this.logger.warn({ err, attempt }, "watcher tick failed");
        delay =
          Math.min(60000, 1000 * Math.pow(2, attempt)) *
          (0.5 + Math.random() * 0.5);
        attempt += 1;
      }
      if (this.stopping) break;
      await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.stopping) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}
