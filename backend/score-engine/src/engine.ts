/**
 * @spore/score-engine — scoring batch job.
 *
 * This engine writes ONLY to the `scores` and `score_history` tables.
 * It NEVER publishes on-chain; on-chain publishing is the oracle publisher's job.
 */
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { computeDimensions, computeScore, MODEL_VERSION } from './model.js';
import {
  listAgentIds,
  gatherInputs,
  snapshotHash,
  type Db,
  type AgentInputSnapshot,
} from './inputs.js';

export interface EngineConfig {
  db: Db;
  intervalMs: number;
  assetDecimals: number;
  logger?: pino.Logger;
  now?: () => number;
}

export interface AgentScoreResult {
  agentId: string;
  score: number;
  band: string;
  limitWholeUnits: number;
  dims: number[];
  inputHash: string;
  historyAppended: boolean;
}

function defaultLogger(): pino.Logger {
  return pino({ level: process.env.LOG_LEVEL ?? 'info' });
}

/** Gather inputs, compute dimensions and score. Pure orchestration, no writes. */
export async function scoreAgent(
  db: Db,
  agentId: string,
  nowMs: number,
  assetDecimals: number,
): Promise<{
  snapshot: AgentInputSnapshot;
  dims: number[];
  score: number;
  band: string;
  limitWholeUnits: number;
}> {
  const snapshot = await gatherInputs(db, agentId, nowMs, assetDecimals);
  const dims = computeDimensions(snapshot);
  const { score, band, limitWholeUnits } = computeScore(dims);
  return { snapshot, dims, score, band, limitWholeUnits };
}

export async function runBatch(config: EngineConfig): Promise<AgentScoreResult[]> {
  const { db, assetDecimals } = config;
  const log = config.logger ?? defaultLogger();
  const nowMs = (config.now ?? Date.now)();

  const agentIds = await listAgentIds(db);
  const results: AgentScoreResult[] = [];
  let failed = 0;

  for (const agentId of agentIds) {
    try {
      const { snapshot, dims, score, band, limitWholeUnits } = await scoreAgent(
        db,
        agentId,
        nowMs,
        assetDecimals,
      );
      const inputHash = snapshotHash(snapshot);

      const prev = await db.query('SELECT score FROM scores WHERE agent_id = $1', [agentId]);
      const prevRow = prev.rows[0] as { score: number | string } | undefined;
      const hadPrev = prevRow !== undefined;

      const dimensions = JSON.stringify({
        dim1: dims[0],
        dim2: dims[1],
        dim3: dims[2],
        dim4: dims[3],
        dim5: dims[4],
        dim6: dims[5],
        dim7: dims[6],
        dim8: dims[7],
        dim9: dims[8],
        dim10: dims[9],
        dim11: dims[10],
        dim12: dims[11],
      });

      // limit_base stores WHOLE units (as a string); the oracle publisher
      // converts to base units using the asset decimals.
      await db.query(
        `INSERT INTO scores (agent_id, score, band, limit_base, model_version, dimensions, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb, to_timestamp($7/1000.0))
         ON CONFLICT (agent_id) DO UPDATE SET score=EXCLUDED.score, band=EXCLUDED.band, limit_base=EXCLUDED.limit_base, model_version=EXCLUDED.model_version, dimensions=EXCLUDED.dimensions, computed_at=EXCLUDED.computed_at`,
        [agentId, score, band, String(limitWholeUnits), MODEL_VERSION, dimensions, nowMs],
      );

      let historyAppended = false;
      if (!hadPrev || Number(prevRow.score) !== score) {
        await db.query(
          `INSERT INTO score_history (agent_id, score, band, model_version, computed_at)
           VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0))`,
          [agentId, score, band, MODEL_VERSION, nowMs],
        );
        historyAppended = true;
      }

      log.info({ agentId, score, band, modelVersion: MODEL_VERSION, inputHash }, 'agent scored');

      results.push({
        agentId,
        score,
        band,
        limitWholeUnits,
        dims,
        inputHash,
        historyAppended,
      });
    } catch (err) {
      failed++;
      log.error({ agentId, err }, 'failed to score agent');
    }
  }

  log.info(
    { agents: agentIds.length, scored: results.length, failed, modelVersion: MODEL_VERSION },
    'score batch complete',
  );
  return results;
}

export class ScoreEngine {
  private readonly config: EngineConfig;
  private readonly log: pino.Logger;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(config: EngineConfig) {
    this.config = config;
    this.log = config.logger ?? defaultLogger();
  }

  async start(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      this.log.error({ err }, 'initial batch failed');
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) {
        this.log.warn('previous scoring run still in progress; skipping');
        return;
      }
      this.runOnce().catch((err: unknown) => {
        this.log.error({ err }, 'scheduled batch failed');
      });
    }, this.config.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<AgentScoreResult[]> {
    if (this.running) {
      throw new Error('run already in progress');
    }
    this.running = true;
    try {
      return await runBatch({ ...this.config, logger: this.log });
    } finally {
      this.running = false;
    }
  }
}

/**
 * Admin server. The admin port is PORT+1000 (see index.ts) and is
 * bound to localhost ONLY (127.0.0.1) — never expose it publicly.
 */
export async function startAdminServer(
  engine: ScoreEngine,
  port: number,
  logger: pino.Logger,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.post('/internal/run', async (_req, reply) => {
    try {
      const results = await engine.runOnce();
      return reply.code(200).send({ ok: true, results: results.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'run already in progress') {
        return reply.code(409).send({ ok: false, error: message });
      }
      logger.error({ err }, 'admin run failed');
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  app.get('/internal/health', async () => ({ ok: true, modelVersion: MODEL_VERSION }));

  await app.listen({ port, host: '127.0.0.1' });
  logger.info({ port, host: '127.0.0.1' }, 'admin server listening');
  return app;
}
