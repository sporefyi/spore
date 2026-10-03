import { createHash } from 'node:crypto';
import type { DimensionInputs } from './model.js';

export interface Db {
  query<T = any>(text: string, params?: any[]): Promise<{ rows: T[] }>;
}

export interface AgentInputSnapshot extends DimensionInputs {
  agentId: string;
  computedAtMs: number;
}

export function toBigInt(v: unknown): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 0n;
    return BigInt(Math.trunc(v));
  }
  const s = String(v).trim();
  if (s === '') return 0n;
  const dot = s.indexOf('.');
  const intPart = dot >= 0 ? s.slice(0, dot) : s;
  if (intPart === '' || intPart === '-' || intPart === '+') return 0n;
  return BigInt(intPart);
}

function toMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  return new Date(String(v)).getTime();
}

export async function listAgentIds(db: Db): Promise<string[]> {
  const res = await db.query<{ agent_id: string | number | bigint }>(
    'SELECT agent_id FROM agents ORDER BY agent_id',
  );
  return res.rows.map((r) => String(r.agent_id));
}

export async function gatherInputs(
  db: Db,
  agentId: string,
  nowMs: number,
  assetDecimals: number,
): Promise<AgentInputSnapshot> {
  const DAY = 86400000;

  const agentRes = await db.query<{ registered_at: Date | string | null; active: boolean }>(
    'SELECT registered_at, active FROM agents WHERE agent_id = $1',
    [agentId],
  );
  if (agentRes.rows.length === 0) throw new Error('unknown agent');
  const agentRow = agentRes.rows[0]!;

  const lineRes = await db.query<{ line_limit: string; drawn: string; active: boolean }>(
    'SELECT line_limit, drawn, active FROM credit_lines WHERE agent_id = $1',
    [agentId],
  );
  const lineRow = lineRes.rows[0];
  const lineActive = lineRow ? Boolean(lineRow.active) : false;
  const limit = lineRow ? toBigInt(lineRow.line_limit) : 0n;
  const drawn = lineRow ? toBigInt(lineRow.drawn) : 0n;

  const borrowRes = await db.query<{ amount: string; block_time: Date | string }>(
    'SELECT amount, block_time FROM borrows WHERE agent_id = $1 ORDER BY block_time ASC, id ASC',
    [agentId],
  );
  let borrowedPrincipal = 0n;
  const borrowEvents: { amount: bigint; timeMs: number }[] = [];
  for (const r of borrowRes.rows) {
    const amount = toBigInt(r.amount);
    borrowedPrincipal += amount;
    borrowEvents.push({ amount, timeMs: toMs(r.block_time) });
  }

  const repayRes = await db.query<{
    amount: string;
    fee_portion: string;
    block_time: Date | string;
  }>(
    'SELECT amount, fee_portion, block_time FROM repays WHERE agent_id = $1 ORDER BY block_time ASC, id ASC',
    [agentId],
  );
  let repaidPrincipal = 0n;
  const repayPrincipalEvents: { amount: bigint; timeMs: number }[] = [];
  for (const r of repayRes.rows) {
    const principal = toBigInt(r.amount) - toBigInt(r.fee_portion);
    if (principal <= 0n) continue;
    repaidPrincipal += principal;
    repayPrincipalEvents.push({ amount: principal, timeMs: toMs(r.block_time) });
  }

  const defRes = await db.query<{ count: string | number }>(
    'SELECT COUNT(*) AS count FROM defaults WHERE agent_id = $1',
    [agentId],
  );
  const defaultCount = parseInt(String(defRes.rows[0]?.count ?? '0'), 10) || 0;

  const t0 = new Date(nowMs - 90 * DAY).toISOString();
  const t1 = new Date(nowMs - 60 * DAY).toISOString();
  const t2 = new Date(nowMs - 30 * DAY).toISOString();
  const t3 = new Date(nowMs).toISOString();
  const winRes = await db.query<{ w1: string | null; w2: string | null; w3: string | null }>(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE block_time >= $2 AND block_time < $3), '0') AS w1,
       COALESCE(SUM(amount) FILTER (WHERE block_time >= $3 AND block_time < $4), '0') AS w2,
       COALESCE(SUM(amount) FILTER (WHERE block_time >= $4 AND block_time <= $5), '0') AS w3
     FROM payments WHERE agent_id = $1`,
    [agentId, t0, t1, t2, t3],
  );
  const wr = winRes.rows[0];
  const w1 = toBigInt(wr?.w1); const w2 = toBigInt(wr?.w2); const w3 = toBigInt(wr?.w3);
  const paymentWindows90d: [bigint, bigint, bigint] = [w1, w2, w3];

  const merchRes = await db.query<{ merchant: string; msum: string }>(
    'SELECT merchant, SUM(amount) AS msum FROM payments WHERE agent_id = $1 GROUP BY merchant ORDER BY merchant',
    [agentId],
  );
  let totalPaymentBaseUnits = 0n;
  const merchantPaymentVolumes: bigint[] = [];
  for (const r of merchRes.rows) {
    const v = toBigInt(r.msum);
    merchantPaymentVolumes.push(v);
    totalPaymentBaseUnits += v;
  }
  const paymentVolumeWholeUnits = totalPaymentBaseUnits / 10n ** BigInt(assetDecimals);

  const daysSinceRegistration =
    agentRow.registered_at === null || agentRow.registered_at === undefined
      ? 0
      : Math.max(0, (nowMs - toMs(agentRow.registered_at)) / DAY);

  const snapshot = {
    agentId,
    computedAtMs: nowMs,
    agentActive: Boolean(agentRow.active),
    lineActive,
    lineLimit: limit,
    drawn,
    borrowedPrincipal,
    borrowEvents,
    repaidPrincipal,
    repayPrincipalEvents,
    defaultCount,
    paymentWindows90d,
    merchantPaymentVolumes,
    paymentVolumeWholeUnits,
    daysSinceRegistration,
  };
  return snapshot as AgentInputSnapshot;
}

function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = canonicalize(obj[k]);
    }
    return out;
  }
  return v;
}

export function snapshotHash(snapshot: AgentInputSnapshot): string {
  const { computedAtMs: _omit, ...rest } = snapshot as AgentInputSnapshot & Record<string, unknown>;
  void _omit;
  const json = JSON.stringify(canonicalize(rest), (_k, v) =>
    typeof v === 'bigint' ? v.toString() + 'n' : v,
  );
  return createHash('sha256').update(json).digest('hex');
}
