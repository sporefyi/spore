import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./types.js";
import { registerHealth } from "./routes/health.js";
import { registerProtocol } from "./routes/protocol.js";
import { registerStats } from "./routes/stats.js";
import { registerAgents } from "./routes/agents.js";
import { registerLedger } from "./routes/ledger.js";
import { registerOnboard } from "./routes/onboard.js";
import { registerMarket } from "./routes/market.js";

export function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.register(
    async (v1) => {
      registerHealth(v1, deps);
      registerProtocol(v1, deps);
      registerStats(v1, deps);
      registerAgents(v1, deps);
      registerLedger(v1, deps);
      registerOnboard(v1, deps);
      registerMarket(v1, deps);    },
    { prefix: "/api/v1" },
  );

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: {
        code: "not_found",
        message: `route ${request.method} ${request.url} not found`,
      },
    }),
  );

  app.setErrorHandler((err, _request, reply) => {
    deps.logger.error({ err }, "unhandled request error");
    if (reply.sent) {
      return;
    }
    void reply.status(500).send({
      error: { code: "internal_error", message: "internal error" },
    });
  });
}
