import type { DbClient, Logger } from "@spore/common";

export interface ChainLine {
  limit: bigint;
  drawn: bigint;
  feeOwed: bigint;
  feeBps: number | bigint;
  issuedAt: bigint;
  active: boolean;
  defaulted: boolean;
}

export interface LineReader {
  getLine(agentId: bigint): Promise<ChainLine>;
}

export interface ReconcileDeps {
  lineReader: LineReader;
  db: DbClient;
  logger: Logger;
}

export interface ReconcileResult {
  checked: number;
  corrected: number;
}

interface CreditLineRow {
  agent_id: string | number | bigint;
  line_limit: string | number | bigint;
  drawn: string | number | bigint;
  fee_owed: string | number | bigint;
  fee_bps: string | number | bigint | null;
  active: boolean;
  defaulted: boolean;
}

function normNumeric(v: unknown): string {
  const s = String(v);
  // Strip trailing zero fractional part (e.g. "100.000" -> "100")
  const m = /^(-?\d+)\.0*$/.exec(s);
  return m && m[1] !== undefined ? m[1] : s;
}

interface Snapshot {
  line_limit: string;
  drawn: string;
  fee_owed: string;
  active: boolean;
  defaulted: boolean;
}

export async function reconcileOnce(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { lineReader, logger, db } = deps;

  const res = await db.query<CreditLineRow>(
    "SELECT agent_id, line_limit, drawn, fee_owed, fee_bps, active, defaulted FROM credit_lines WHERE active = true",
  );

  let checked = 0;
  let corrected = 0;

  for (const row of res.rows) {
    checked++;
    const agentIdStr = normNumeric(row.agent_id);
    try {
      const agentId = BigInt(agentIdStr);
      const chain = await lineReader.getLine(agentId);

      const before: Snapshot = {
        line_limit: normNumeric(row.line_limit),
        drawn: normNumeric(row.drawn),
        fee_owed: normNumeric(row.fee_owed),
        active: Boolean(row.active),
        defaulted: Boolean(row.defaulted),
      };
      const after: Snapshot = {
        line_limit: String(chain.limit),
        drawn: String(chain.drawn),
        fee_owed: String(chain.feeOwed),
        active: chain.active,
        defaulted: chain.defaulted,
      };

      if (row.fee_bps !== null && row.fee_bps !== undefined) {
        const dbBps = normNumeric(row.fee_bps);
        const chainBps = String(chain.feeBps);
        if (dbBps !== chainBps) {
          logger.warn(
            { agentId: agentIdStr, dbFeeBps: dbBps, chainFeeBps: chainBps },
            "credit_lines fee_bps differs from chain (immutable, not corrected)",
          );
        }
      }

      const mismatch =
        before.active !== after.active ||
        before.defaulted !== after.defaulted ||
        before.line_limit !== after.line_limit ||
        before.drawn !== after.drawn ||
        before.fee_owed !== after.fee_owed;

      if (!mismatch) continue;

      await db.query(
        "UPDATE credit_lines SET line_limit = $1, drawn = $2, fee_owed = $3, active = $4, defaulted = $5, updated_at = now() WHERE agent_id = $6",
        [
          after.line_limit,
          after.drawn,
          after.fee_owed,
          after.active,
          after.defaulted,
          agentIdStr,
        ],
      );
      corrected++;
      logger.warn(
        { agentId: agentIdStr, before, after },
        "credit_lines corrected by reconciliation",
      );
    } catch (err) {
      logger.error(
        { err, agentId: agentIdStr },
        "reconciliation failed for agent",
      );
    }
  }

  return { checked, corrected };
}

export function startReconciler(
  deps: ReconcileDeps,
  intervalMs: number,
): { stop(): void } {
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new RangeError("intervalMs must be >= 1000");
  }
  const { logger } = deps;
  let running = false;
  let stopped = false;

  const run = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await reconcileOnce(deps);
      logger.debug(result, "reconciliation pass complete");
    } catch (err) {
      logger.error({ err }, "reconciliation pass failed");
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => {
    void run();
  }, intervalMs);

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
