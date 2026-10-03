import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../types.js";
import { dec, int, sendError } from "./util.js";

interface StatsRow {
  agents: string | number | null;
  credit_issued: string | number | null;
  repaid_principal: string | number | null;
  active_credit: string | number | null;
  defaulted_drawn: string | number | null;
}

const STATS_SQL = `
  SELECT
    (SELECT COUNT(*) FROM agents) AS agents,
    (SELECT COALESCE(SUM(amount), 0) FROM borrows) AS credit_issued,
    (SELECT COALESCE(SUM(amount - fee_portion), 0) FROM repays) AS repaid_principal,
    (SELECT COALESCE(SUM(drawn), 0) FROM credit_lines WHERE active) AS active_credit,
    (SELECT COALESCE(SUM(drawn_amount), 0) FROM defaults) AS defaulted_drawn
`;

export function registerStats(app: FastifyInstance, deps: AppDeps): void {
  app.get("/stats", async (_request, reply) => {
    try {
      const result = await deps.db.query<StatsRow>(STATS_SQL);
      const row = result.rows[0];

      const repaidStr = dec(row?.repaid_principal ?? null);
      const defaultedStr = dec(row?.defaulted_drawn ?? null);

      const repaid = Number(repaidStr);
      const defaulted = Number(defaultedStr);
      const denominator = repaid + defaulted;
      const repaymentRate = denominator > 0 ? repaid / denominator : null;

      reply.header("Cache-Control", "public, max-age=15");

      return {
        agents: int(row?.agents ?? null),
        creditIssued: dec(row?.credit_issued ?? null),
        repaid: repaidStr,
        activeCredit: dec(row?.active_credit ?? null),
        repaymentRate,
        decimals: deps.config.assetDecimals,
      };
    } catch (err) {
      deps.logger.error({ err }, "failed to load stats");
      sendError(reply, 500, "internal_error", "failed to load stats");
      return reply;
    }
  });
}
