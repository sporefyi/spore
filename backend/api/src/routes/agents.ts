import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppDeps } from "../types.js";
import {
  parsePagination,
  dec,
  int,
  num,
  iso,
  ageDays,
  utilization,
  sendError,
} from "./util.js";

type Ts = Date | string | null;

interface AgentListRow {
  agent_id: string | number;
  owner: string;
  score: number | string | null;
  band: string | null;
  credit_limit: string | number;
  loans_repaid: string | number;
  defaults: string | number;
  drawn: string | number;
  registered_at: Ts;
}

interface AgentRow {
  agent_id: string | number;
  owner: string;
  metadata_uri: string | null;
  active: boolean | null;
  registered_at: Ts;
}

interface ScoreRow {
  score: number | string;
  band: string;
  model_version: number | string;
  computed_at: Ts;
  dimensions: unknown;
}

interface CreditRow {
  line_limit: string | number;
  drawn: string | number;
  fee_owed: string | number;
  fee_bps: number | string;
  active: boolean | null;
  defaulted: boolean | null;
}

interface HistoryRow {
  borrowed: string | number;
  repaid: string | number;
  loans: string | number;
  defaults: string | number;
}

interface EconomicsRow {
  payment_volume: string | number;
  backers: string | number;
  vouched: string | number;
}

interface ScoreHistoryRow {
  computed_at: Ts;
  score: number | string;
}

const ID_PATTERN = /^\d+$/;

function parseDimensions(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

function notFound(reply: FastifyReply, id: string): FastifyReply {
  return sendError(reply, 404, "agent_not_found", `agent ${id} not found`);
}

export function registerAgents(app: FastifyInstance, deps: AppDeps): void {
  const { db, config, logger } = deps;

  app.get("/agents", async (request, reply) => {
    const { limit, offset } = parsePagination(
      request.query as Record<string, unknown>,
    );
    try {
      const [itemsRes, totalRes] = await Promise.all([
        db.query<AgentListRow>(
          `SELECT a.agent_id,
                  a.owner,
                  s.score,
                  s.band,
                  COALESCE(cl.line_limit, 0) AS credit_limit,
                  COUNT(DISTINCT r.id) AS loans_repaid,
                  COUNT(DISTINCT d.id) AS defaults,
                  COALESCE(cl.drawn, 0) AS drawn,
                  a.registered_at
             FROM agents a
             LEFT JOIN scores s ON s.agent_id = a.agent_id
             LEFT JOIN credit_lines cl ON cl.agent_id = a.agent_id
             LEFT JOIN repays r ON r.agent_id = a.agent_id
             LEFT JOIN defaults d ON d.agent_id = a.agent_id
            GROUP BY a.agent_id, a.owner, a.registered_at, s.score, s.band, cl.line_limit, cl.drawn
            ORDER BY a.agent_id ASC
            LIMIT $1 OFFSET $2`,
          [limit, offset],
        ),
        db.query<{ count: string | number }>("SELECT COUNT(*) FROM agents"),
      ]);

      const items = itemsRes.rows.map((row) => ({
        agentId: String(row.agent_id),
        owner: row.owner,
        score: row.score === null || row.score === undefined ? null : num(row.score),
        band: row.band ?? null,
        creditLimit: dec(row.credit_limit),
        loansRepaid: int(row.loans_repaid),
        defaults: int(row.defaults),
        utilization: utilization(row.drawn, row.credit_limit),
        ageDays: ageDays(row.registered_at),
      }));

      const total = int(totalRes.rows[0]?.count ?? 0);

      reply.header("Cache-Control", "public, max-age=15");
      return reply.send({ items, total });
    } catch (err) {
      logger.error({ err }, "failed to list agents");
      return sendError(reply, 500, "internal_error", "internal error");
    }
  });

  app.get<{ Params: { id: string } }>("/agents/:id", async (request, reply) => {
    const id = request.params.id;
    if (!ID_PATTERN.test(id)) return notFound(reply, id);

    try {
      const agentRes = await db.query<AgentRow>(
        `SELECT agent_id, owner, metadata_uri, active, registered_at
           FROM agents WHERE agent_id = $1`,
        [id],
      );
      const agent = agentRes.rows[0];
      if (!agent) return notFound(reply, id);

      const [scoreRes, creditRes, historyRes, econRes] = await Promise.all([
        db.query<ScoreRow>(
          `SELECT score, band, model_version, computed_at, dimensions
             FROM scores WHERE agent_id = $1`,
          [id],
        ),
        db.query<CreditRow>(
          `SELECT line_limit, drawn, fee_owed, fee_bps, active, defaulted
             FROM credit_lines WHERE agent_id = $1`,
          [id],
        ),
        db.query<HistoryRow>(
          `SELECT
             (SELECT COALESCE(SUM(amount), 0) FROM borrows WHERE agent_id = $1) AS borrowed,
             (SELECT COALESCE(SUM(amount - fee_portion), 0) FROM repays WHERE agent_id = $1) AS repaid,
             (SELECT COUNT(*) FROM borrows WHERE agent_id = $1) AS loans,
             (SELECT COUNT(*) FROM defaults WHERE agent_id = $1) AS defaults`,
          [id],
        ),
        db.query<EconomicsRow>(
          `SELECT
             (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE agent_id = $1) AS payment_volume,
             (SELECT COUNT(DISTINCT backer) FROM sponsors WHERE agent_id = $1) AS backers,
             (SELECT COALESCE(SUM(amount), 0) FROM sponsors WHERE agent_id = $1) AS vouched`,
          [id],
        ),
      ]);

      const scoreRow = scoreRes.rows[0];
      const creditRow = creditRes.rows[0];
      const hist = historyRes.rows[0];
      const econ = econRes.rows[0];

      const score = scoreRow
        ? {
            value: int(scoreRow.score),
            band: scoreRow.band,
            modelVersion: int(scoreRow.model_version),
            updatedAt: iso(scoreRow.computed_at) ?? "",
            dimensions: parseDimensions(scoreRow.dimensions),
          }
        : null;

      const credit = creditRow
        ? {
            limit: dec(creditRow.line_limit),
            drawn: dec(creditRow.drawn),
            feeOwed: dec(creditRow.fee_owed),
            feeBps: int(creditRow.fee_bps),
            active: !!creditRow.active,
            defaulted: !!creditRow.defaulted,
          }
        : {
            limit: dec(0),
            drawn: dec(0),
            feeOwed: dec(0),
            feeBps: 0,
            active: false,
            defaulted: false,
          };

      const loans = int(hist?.loans ?? 0);
      const defaultCount = int(hist?.defaults ?? 0);
      const onTimeRate = loans > 0 ? (loans - defaultCount) / loans : null;

      const history = {
        borrowed: dec(hist?.borrowed ?? 0),
        repaid: dec(hist?.repaid ?? 0),
        loans,
        defaults: defaultCount,
        onTimeRate,
      };

      const economics = {
        paymentVolume: dec(econ?.payment_volume ?? 0),
        backers: int(econ?.backers ?? 0),
        vouched: dec(econ?.vouched ?? 0),
        utilization: creditRow
          ? utilization(creditRow.drawn, creditRow.line_limit)
          : null,
      };

      const identity = {
        agentId: String(agent.agent_id),
        owner: agent.owner,
        metadataUri: agent.metadata_uri ?? "",
        active: !!agent.active,
        ageDays: ageDays(agent.registered_at),
        registeredAt: iso(agent.registered_at),
      };

      reply.header("Cache-Control", "public, max-age=60");
      return reply.send({
        identity,
        score,
        credit,
        history,
        economics,
        decimals: config.assetDecimals,
      });
    } catch (err) {
      logger.error({ err, agentId: id }, "failed to load agent dossier");
      return sendError(reply, 500, "internal_error", "internal error");
    }
  });

  app.get<{ Params: { id: string } }>(
    "/agents/:id/scores",
    async (request, reply) => {
      const id = request.params.id;
      if (!ID_PATTERN.test(id)) return notFound(reply, id);

      try {
        const agentRes = await db.query<{ agent_id: string | number }>(
          "SELECT agent_id FROM agents WHERE agent_id = $1",
          [id],
        );
        if (agentRes.rows.length === 0) return notFound(reply, id);

        const res = await db.query<ScoreHistoryRow>(
          `SELECT computed_at, score
             FROM score_history
            WHERE agent_id = $1
            ORDER BY computed_at ASC, id ASC`,
          [id],
        );

        const items = res.rows.map((row) => ({
          t: iso(row.computed_at),
          score: int(row.score),
        }));

        reply.header("Cache-Control", "public, max-age=60");
        return reply.send({ items });
      } catch (err) {
        logger.error({ err, agentId: id }, "failed to load score history");
        return sendError(reply, 500, "internal_error", "internal error");
      }
    },
  );
}
