import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pino from 'pino';
import { runBatch, ScoreEngine, startAdminServer } from './engine.js';
import type { Db } from './inputs.js';

const NOW = Date.UTC(2026, 9, 3, 8, 25, 0);
const DAY = 86400000;
const iso = (ms: number): string => new Date(ms).toISOString();

let pg: PGlite;
let db: Db;

const schemaPath = fileURLToPath(new URL('../../db/migrations/001_schema.sql', import.meta.url));

const SCHEMA_SQL = readFileSync(path.resolve(schemaPath), 'utf8');
const TABLES =
  'sync_state, agents, credit_lines, borrows, repays, defaults, sponsors, ' +
  'payments, revenues, credit_limit_changes, yield_allocations, scores, score_history';

// One PGlite instance per file: WASM init is slow, so share it and reset
// tables between tests instead of recreating the database each time.
beforeAll(async () => {
  pg = new PGlite();
  db = pg as unknown as Db;
  await pg.exec(SCHEMA_SQL);
}, 120000);

beforeEach(async () => {
  await pg.exec(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await pg.close();
});

const silent = () => pino({ level: 'silent' });

let txCounter = 0;
const nextTx = (): string => `0xseed${++txCounter}`;

async function insertAgent(d: Db, id: number, owner: string, registeredAt: number): Promise<void> {
  await d.query(
    `INSERT INTO agents (agent_id, owner, metadata_uri, active, registered_at, chain_id, block_number, tx_hash, log_index, block_time)
     VALUES ($1, $2, '', true, $3::timestamptz, 4663, 1, $4, 0, $3::timestamptz)`,
    [id, owner, iso(registeredAt), '0xseed' + id],
  );
}

async function seed(d: Db): Promise<void> {
  await insertAgent(d, 1, '0xaaa', NOW - 500 * DAY);
  await insertAgent(d, 2, '0xbbb', NOW - 10 * DAY);

  await d.query(
    `INSERT INTO credit_lines (agent_id, line_limit, drawn, active) VALUES ($1, $2, $3, true)`,
    [1, '2000000000', '500000000'],
  );

  await d.query(
    `INSERT INTO borrows (agent_id, amount, fee, merchant, chain_id, block_number, tx_hash, log_index, block_time)
     VALUES ($1, $2, '0', 'm1', 4663, 2, $3, 0, $4::timestamptz)`,
    [1, '1000000000', nextTx(), iso(NOW - 100 * DAY)],
  );

  await d.query(
    `INSERT INTO repays (agent_id, amount, fee_portion, payer, chain_id, block_number, tx_hash, log_index, block_time)
     VALUES ($1, $2, '0', '0xaaa', 4663, 3, $3, 0, $4::timestamptz)`,
    [1, '1000000000', nextTx(), iso(NOW - 80 * DAY)],
  );

  for (const off of [80, 50, 10]) {
    await d.query(
      `INSERT INTO payments (agent_id, amount, merchant, chain_id, block_number, tx_hash, log_index, block_time)
       VALUES ($1, $2, 'm1', 4663, 4, $3, 0, $4::timestamptz)`,
      [1, '100000000', nextTx(), iso(NOW - off * DAY)],
    );
  }
}

const EXPECTED_1 = [1000, 1000, 750, 1000, 0, 1000, 1000, 300, 30, 1000, 0, 0];
const EXPECTED_2 = [400, 500, 500, 300, 0, 27, 1000, 300, 0, 1000, 0, 500];

function dimsOf(row: Record<string, unknown>): number[] {
  const raw = row.dimensions;
  const obj = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, number>;
  return Array.from({ length: 12 }, (_, i) => obj[`dim${i + 1}`]!);
}

async function scoreRows() {
  const r = await db.query(
    'SELECT agent_id, score, band, limit_base, model_version, dimensions, computed_at FROM scores ORDER BY agent_id',
    [],
  );
  return r.rows as Record<string, unknown>[];
}

async function historyCount(agentId?: number): Promise<number> {
  const r =
    agentId === undefined
      ? await db.query('SELECT COUNT(*) AS n FROM score_history', [])
      : await db.query('SELECT COUNT(*) AS n FROM score_history WHERE agent_id = $1', [agentId]);
  return Number((r.rows[0] as { n: unknown }).n);
}

const cfg = () => ({
  db,
  intervalMs: 60000,
  assetDecimals: 6,
  logger: silent(),
  now: () => NOW,
});

describe('engine', () => {
  it('runBatch writes scores rows', async () => {
    await seed(db);
    await runBatch(cfg());
    const rows = await scoreRows();
    expect(rows).toHaveLength(2);
    const [a, b] = rows as [Record<string, unknown>, Record<string, unknown>];
    expect(Number(a.agent_id)).toBe(1);
    expect(Number(a.score)).toBe(702);
    expect(a.band).toBe('LOW');
    expect(String(a.limit_base)).toBe('250');
    expect(Number(a.model_version)).toBe(1);
    expect(dimsOf(a)).toEqual(EXPECTED_1);
    expect(a.computed_at).not.toBeNull();
    expect(Number(b.agent_id)).toBe(2);
    expect(Number(b.score)).toBe(415);
    expect(b.band).toBe('ELEVATED');
    expect(String(b.limit_base)).toBe('25');
    expect(Number(b.model_version)).toBe(1);
    expect(dimsOf(b)).toEqual(EXPECTED_2);
    expect(b.computed_at).not.toBeNull();
  });

  it('history appended only on change', async () => {
    await seed(db);
    await runBatch(cfg());
    expect(await historyCount()).toBe(2);
    await runBatch(cfg());
    expect(await historyCount()).toBe(2);

    await db.query(
      `INSERT INTO defaults (agent_id, drawn_amount, covered_amount, shortfall, chain_id, block_number, tx_hash, log_index, block_time)
       VALUES ($1, '100000000', '0', '100000000', 4663, 2, '0xdef1', 0, $2::timestamptz)`,
      [1, iso(NOW - 5 * DAY)],
    );
    await runBatch(cfg());
    expect(await historyCount()).toBe(3);
    const rows = await scoreRows();
    expect(Number(rows[0]!.score)).toBe(662);
    expect(rows[0]!.band).toBe('LOW');
    expect(Number(rows[1]!.score)).toBe(415);
    expect(await historyCount(2)).toBe(1);
  });

  it('runBatch continues past a failing agent', async () => {
    await seed(db);
    await insertAgent(db, 3, '0xccc', NOW - 30 * DAY);
    const flaky: Db = {
      query: (t, p) => {
        if (String((p as unknown[] | undefined)?.[0]) === '3' && /borrows/.test(t)) {
          throw new Error('boom');
        }
        return db.query(t, p);
      },
    };
    await runBatch({ ...cfg(), db: flaky });
    const rows = await scoreRows();
    expect(rows).toHaveLength(2);
    expect(Number(rows[0]!.agent_id)).toBe(1);
    expect(Number(rows[0]!.score)).toBe(702);
    expect(Number(rows[1]!.agent_id)).toBe(2);
    expect(Number(rows[1]!.score)).toBe(415);
  });

  it('admin server: localhost-only on-demand run', async () => {
    await seed(db);
    const engine = new ScoreEngine({
      db,
      intervalMs: 3600000,
      assetDecimals: 6,
      logger: silent(),
      now: () => NOW,
    });
    const app = await startAdminServer(engine, 0, silent());
    const addr = app.server.address();
    expect(addr).toMatchObject({ address: '127.0.0.1' });
    expect(typeof addr === 'object' && addr !== null).toBe(true);
    const port = (addr as import('node:net').AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const health = await (await fetch(base + '/internal/health')).json();
    expect(health).toMatchObject({ ok: true, modelVersion: 1 });
    const run1 = await fetch(base + '/internal/run', { method: 'POST' });
    expect(run1.status).toBe(200);
    expect(await run1.json()).toMatchObject({ ok: true, results: 2 });
    await app.close();
  });
});
