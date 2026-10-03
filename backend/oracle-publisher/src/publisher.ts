import { Contract, isError, type Provider, type Signer } from "ethers";
import { type OraclePublisherConfig } from "./config.js";
import { type Logger } from "./logger.js";
import {
  type DbClient,
  type ScoreRow,
  getPendingScores,
  markPublished,
} from "./db.js";

/* ------------------------------------------------------------------ */
/* ABI                                                                 */
/* ------------------------------------------------------------------ */

export const SCORE_ORACLE_ABI = [
  "function publishScore(uint256 agentId, uint16 score, uint256 limit, uint8 modelVersion)",
  "function getScore(uint256 agentId) view returns (tuple(uint16 score, uint256 limit, uint64 updatedAt, uint8 modelVersion) data)",
  "function hasScore(uint256 agentId) view returns (bool)",
  "function isFresh(uint256 agentId) view returns (bool)",
  "function maxStalePeriod() view returns (uint64)",
] as const;

/* ------------------------------------------------------------------ */
/* Abstractions                                                        */
/* ------------------------------------------------------------------ */

export interface OnChainScore {
  score: number;
  limit: bigint;
  updatedAt: bigint;
  modelVersion: number;
}

export interface OracleReader {
  hasScore(agentId: bigint): Promise<boolean>;
  getScore(agentId: bigint): Promise<OnChainScore>;
  isFresh(agentId: bigint): Promise<boolean>;
  maxStalePeriod(): Promise<bigint>;
}

export interface OracleWriter {
  publishScore(
    agentId: bigint,
    score: number,
    limit: bigint,
    modelVersion: number,
  ): Promise<string>;
}

interface ScoreStructResult {
  score: bigint | number;
  limit: bigint;
  updatedAt: bigint | number;
  modelVersion: bigint | number;
}

export function createOracleReader(
  provider: Provider,
  oracleAddress: string,
): OracleReader {
  const contract = new Contract(oracleAddress, SCORE_ORACLE_ABI, provider);
  return {
    async hasScore(agentId: bigint): Promise<boolean> {
      return (await contract.getFunction("hasScore")(agentId)) as boolean;
    },
    async getScore(agentId: bigint): Promise<OnChainScore> {
      const r = (await contract.getFunction("getScore")(
        agentId,
      )) as ScoreStructResult;
      return {
        score: Number(r.score),
        limit: BigInt(r.limit),
        updatedAt: BigInt(r.updatedAt),
        modelVersion: Number(r.modelVersion),
      };
    },
    async isFresh(agentId: bigint): Promise<boolean> {
      return (await contract.getFunction("isFresh")(agentId)) as boolean;
    },
    async maxStalePeriod(): Promise<bigint> {
      return BigInt(
        (await contract.getFunction("maxStalePeriod")()) as bigint | number,
      );
    },
  };
}

export function createOracleWriter(
  signer: Signer,
  oracleAddress: string,
): OracleWriter {
  const contract = new Contract(oracleAddress, SCORE_ORACLE_ABI, signer);
  return {
    async publishScore(
      agentId: bigint,
      score: number,
      limit: bigint,
      modelVersion: number,
    ): Promise<string> {
      const tx = (await contract.getFunction("publishScore")(
        agentId,
        score,
        limit,
        modelVersion,
      )) as { hash: string; wait: () => Promise<{ status: number | null } | null> };
      const receipt = await tx.wait();
      if (receipt === null || receipt.status !== 1) {
        throw new Error(`publishScore transaction failed: ${tx.hash}`);
      }
      return tx.hash;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Limit conversion                                                    */
/* ------------------------------------------------------------------ */

export const LIMIT_LADDER_WHOLE = [0, 25, 100, 250, 500] as const;

export function limitToBaseUnits(
  limitFromDb: string,
  assetDecimals: number,
): bigint {
  if (typeof limitFromDb !== "string" && typeof limitFromDb !== "number" && typeof limitFromDb !== "bigint") {
    throw new Error("limit: unparseable value");
  }
  const raw = String(limitFromDb).trim();
  const dot = raw.indexOf(".");
  const intPart = dot >= 0 ? raw.slice(0, dot) : raw;
  if (!/^\d+$/.test(intPart)) {
    throw new Error(`limit: unparseable value "${raw}"`);
  }
  if (!Number.isInteger(assetDecimals) || assetDecimals < 0) {
    throw new Error(`limit: invalid assetDecimals ${assetDecimals}`);
  }
  const value = BigInt(intPart);
  const isLadder = LIMIT_LADDER_WHOLE.some((w) => BigInt(w) === value);
  if (isLadder && assetDecimals > 0) {
    return value * 10n ** BigInt(assetDecimals);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Publish decision                                                    */
/* ------------------------------------------------------------------ */

export type PublishAction = "publish" | "skip-identical" | "skip-born-stale";

export interface PublishDecision {
  action: PublishAction;
  reason: string;
}

function toEpochSec(value: Date | string): bigint {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error("computed_at: invalid date");
  }
  return BigInt(Math.floor(ms / 1000));
}

export function decidePublish(
  row: ScoreRow,
  onChain: OnChainScore | null,
  targetLimitBaseUnits: bigint,
  maxStalePeriodSec: bigint,
  nowSec: bigint,
): PublishDecision {
  const computedAtSec = toEpochSec(row.computed_at as Date | string);
  const age = nowSec - computedAtSec;
  if (age > maxStalePeriodSec) {
    return {
      action: "skip-born-stale",
      reason: `computed_at age ${age.toString()}s exceeds maxStalePeriod ${maxStalePeriodSec.toString()}s`,
    };
  }
  if (onChain === null) {
    return { action: "publish", reason: "no on-chain record" };
  }

  const diffs: string[] = [];
  if (onChain.score !== Number(row.score)) diffs.push("score-changed");
  if (onChain.limit !== targetLimitBaseUnits) diffs.push("limit-changed");
  if (onChain.modelVersion !== Number(row.model_version)) {
    diffs.push("model-changed");
  }
  if (nowSec - onChain.updatedAt > maxStalePeriodSec) {
    diffs.push("stale-onchain-refresh");
  }

  if (diffs.length === 0) {
    return { action: "skip-identical", reason: "on-chain record identical and fresh" };
  }
  return { action: "publish", reason: diffs.join(",") };
}

/* ------------------------------------------------------------------ */
/* Retry                                                               */
/* ------------------------------------------------------------------ */

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts: number;
    baseMs: number;
    logger: Logger;
    label: string;
    sleepMs?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const sleep = opts.sleepMs ?? defaultSleep;
  const max = Math.max(1, opts.maxAttempts);
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= max) throw err;
      const delay = Math.random() * opts.baseMs * 2 ** (attempt - 1);
      opts.logger.warn(
        {
          attempt,
          maxAttempts: max,
          label: opts.label,
          delayMs: Math.round(delay),
          err: err instanceof Error ? err.message : String(err),
        },
        "operation failed, retrying",
      );
      await sleep(delay);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Round                                                               */
/* ------------------------------------------------------------------ */

export interface RoundDeps {
  db: DbClient;
  config: OraclePublisherConfig;
  logger: Logger;
  reader: OracleReader | null;
  writer: OracleWriter | null;
  nowMs?: () => number;
  sleepMs?: (ms: number) => Promise<void>;
}

export interface RoundResult {
  checked: number;
  published: number;
  skippedIdentical: number;
  skippedBornStale: number;
  failed: number;
  dryLogged: number;
}

interface ValidatedRow {
  agentId: bigint;
  score: number;
  modelVersion: number;
}

function validateRow(row: ScoreRow): ValidatedRow {
  let agentId: bigint;
  try {
    agentId = BigInt(String(row.agent_id));
  } catch {
    throw new Error(`invalid agent_id "${String(row.agent_id)}"`);
  }
  if (agentId < 0n) throw new Error(`negative agent_id ${agentId.toString()}`);

  const score = Number(row.score);
  if (!Number.isInteger(score) || score < 0 || score > 1000) {
    throw new Error(`score out of range 0..1000: ${String(row.score)}`);
  }
  const modelVersion = Number(row.model_version);
  if (!Number.isInteger(modelVersion) || modelVersion < 0 || modelVersion > 255) {
    throw new Error(`model_version out of range 0..255: ${String(row.model_version)}`);
  }
  return { agentId, score, modelVersion };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runPublishRound(deps: RoundDeps): Promise<RoundResult> {
  const { db, config, logger } = deps;
  const nowMs = deps.nowMs ?? Date.now;
  const sleepMs = deps.sleepMs ?? defaultSleep;

  const result: RoundResult = {
    checked: 0,
    published: 0,
    skippedIdentical: 0,
    skippedBornStale: 0,
    failed: 0,
    dryLogged: 0,
  };

  const dry = config.dryRun || config.watchMode;
  if (dry && (deps.reader !== null || deps.writer !== null)) {
    throw new Error("dry/watch mode requires reader and writer to be null");
  }
  if (!dry && (deps.reader === null || deps.writer === null)) {
    throw new Error("live mode requires reader and writer");
  }

  const rows = await getPendingScores(db);
  if (rows.length === 0) {
    logger.debug("no pending scores");
    return result;
  }
  result.checked = rows.length;

  const retryOpts = (label: string) => ({
    maxAttempts: config.maxPublishAttempts,
    baseMs: config.baseBackoffMs,
    logger,
    label,
    sleepMs,
  });

  if (dry) {
    for (const row of rows) {
      try {
        const v = validateRow(row);
        const targetLimit = limitToBaseUnits(row.limit_base, config.assetDecimals);
        logger.info(
          {
            agentId: v.agentId.toString(),
            score: v.score,
            band: row.band,
            limitBaseUnits: targetLimit.toString(),
            modelVersion: v.modelVersion,
          },
          "would publish score",
        );
        result.dryLogged++;
      } catch (err) {
        logger.error(
          { agentId: String(row.agent_id), err: errMsg(err) },
          "invalid score row in dry run",
        );
        result.failed++;
      }
    }
    return result;
  }

  const reader = deps.reader as OracleReader;
  const writer = deps.writer as OracleWriter;

  let maxStale: bigint;
  try {
    maxStale = await withRetry(
      () => reader.maxStalePeriod(),
      retryOpts("maxStalePeriod"),
    );
  } catch (err) {
    logger.error({ err: errMsg(err) }, "failed to read maxStalePeriod; aborting round");
    result.failed = rows.length;
    return result;
  }

  for (const row of rows) {
    const agentIdStr = String(row.agent_id);
    try {
      const v = validateRow(row);
      const targetLimit = limitToBaseUnits(row.limit_base, config.assetDecimals);

      const exists = await withRetry(
        () => reader.hasScore(v.agentId),
        retryOpts(`hasScore:${agentIdStr}`),
      );
      let onChain: OnChainScore | null = null;
      if (exists) {
        onChain = await withRetry(async () => {
          try {
            return await reader.getScore(v.agentId);
          } catch (err) {
            if (isError(err, "CALL_EXCEPTION")) return null;
            throw err;
          }
        }, retryOpts(`getScore:${agentIdStr}`));
      }

      const nowSec = BigInt(Math.floor(nowMs() / 1000));
      const decision = decidePublish(row, onChain, targetLimit, maxStale, nowSec);

      if (decision.action === "skip-identical") {
        logger.info({ agentId: agentIdStr, reason: decision.reason }, "skip identical score");
        result.skippedIdentical++;
        continue;
      }
      if (decision.action === "skip-born-stale") {
        logger.warn({ agentId: agentIdStr, reason: decision.reason }, "skip born-stale score");
        result.skippedBornStale++;
        continue;
      }

      const txHash = await withRetry(
        () => writer.publishScore(v.agentId, v.score, targetLimit, v.modelVersion),
        retryOpts(`publishScore:${agentIdStr}`),
      );
      await markPublished(db, v.agentId, txHash);
      logger.info(
        {
          agentId: agentIdStr,
          score: v.score,
          limitBaseUnits: targetLimit.toString(),
          modelVersion: v.modelVersion,
          reason: decision.reason,
          txHash,
        },
        "score published",
      );
      result.published++;
    } catch (err) {
      logger.error(
        { agentId: agentIdStr, err: errMsg(err) },
        "failed to publish score; will retry next round",
      );
      result.failed++;
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                           */
/* ------------------------------------------------------------------ */

export interface PublisherHandle {
  stop(): Promise<void>;
}

export async function startPublisher(
  config: OraclePublisherConfig,
  logger: Logger,
  db: DbClient,
  reader: OracleReader | null,
  writer: OracleWriter | null,
): Promise<PublisherHandle> {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inflight: Promise<void> = Promise.resolve();

  const runOnce = async (): Promise<void> => {
    try {
      const res = await runPublishRound({ db, config, logger, reader, writer });
      logger.info(res, "publish round complete");
    } catch (err) {
      logger.error({ err: errMsg(err) }, "publish round failed");
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      inflight = runOnce().then(schedule);
    }, config.scoreIntervalMs);
  };

  logger.info(
    {
      intervalMs: config.scoreIntervalMs,
      dryRun: config.dryRun,
      watchMode: config.watchMode,
    },
    "oracle publisher starting",
  );

  inflight = runOnce();
  await inflight;
  schedule();

  let stopPromise: Promise<void> | null = null;

  return {
    stop(): Promise<void> {
      if (stopPromise === null) {
        stopPromise = (async () => {
          stopped = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          await inflight;
          await db.close();
          logger.info("oracle publisher stopped");
        })();
      }
      return stopPromise;
    },
  };
}

