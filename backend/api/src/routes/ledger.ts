import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../types.js";
import { parsePagination, dec, int, iso, sendError } from "./util.js";

const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  "borrow",
  "repay",
  "default",
  "sponsor",
  "payment",
  "credit_issued",
  "limit_changed",
]);

const UNION_SQL = `
  SELECT 'borrow'::text AS type, agent_id, amount, tx_hash, block_number, block_time, id FROM borrows
  UNION ALL
  SELECT 'repay'::text AS type, agent_id, amount, tx_hash, block_number, block_time, id FROM repays
  UNION ALL
  SELECT 'default'::text AS type, agent_id, drawn_amount AS amount, tx_hash, block_number, block_time, id FROM defaults
  UNION ALL
  SELECT 'sponsor'::text AS type, agent_id, amount, tx_hash, block_number, block_time, id FROM sponsors
  UNION ALL
  SELECT 'payment'::text AS type, agent_id, amount, tx_hash, block_number, block_time, id FROM payments
  UNION ALL
  SELECT (CASE WHEN old_limit = 0 THEN 'credit_issued' ELSE 'limit_changed' END)::text AS type,
         agent_id, new_limit AS amount, tx_hash, block_number, block_time, id
  FROM credit_limit_changes
`;

const LIST_SQL = `
SELECT * FROM (${UNION_SQL}) e
WHERE ($1::text IS NULL OR type = $1)
ORDER BY block_time DESC, block_number DESC, id DESC
LIMIT $2 OFFSET $3
`;

const COUNT_SQL = `
SELECT COUNT(*) AS count FROM (${UNION_SQL}) e
WHERE ($1::text IS NULL OR type = $1)
`;

interface LedgerRow {
  type: string;
  agent_id: string | number | bigint;
  amount: string | number | null;
  tx_hash: string;
  block_number: string | number | bigint;
  block_time: Date | string | null;
}

interface CountRow {
  count: string | number | bigint;
}

export function registerLedger(app: FastifyInstance, deps: AppDeps): void {
  app.get("/ledger", async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const { limit, offset } = parsePagination(q);

    let type: string | null = null;
    if (q["type"] !== undefined) {
      const raw = q["type"];
      if (typeof raw !== "string" || !ALLOWED_TYPES.has(raw)) {
        return sendError(
          reply,
          400,
          "invalid_type",
          "type must be one of: borrow, repay, default, sponsor, payment, credit_issued, limit_changed",
        );
      }
      type = raw;
    }

    try {
      const [listRes, countRes] = await Promise.all([
        deps.db.query<LedgerRow>(LIST_SQL, [type, limit, offset]),
        deps.db.query<CountRow>(COUNT_SQL, [type]),
      ]);

      const items = listRes.rows.map((r) => ({
        type: r.type,
        agentId: String(r.agent_id),
        amount: dec(r.amount),
        txHash: r.tx_hash,
        blockNumber: int(r.block_number),
        t: iso(r.block_time) ?? "",
      }));

      const total = int(countRes.rows[0]?.count ?? 0);

      reply.header("Cache-Control", "public, max-age=15");
      return { items, total };
    } catch (err) {
      deps.logger.error({ err }, "ledger query failed");
      return sendError(reply, 500, "internal_error", "Internal server error");
    }
  });
}
