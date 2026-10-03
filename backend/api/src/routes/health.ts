import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../types.js";
import { int, iso } from "./util.js";

type CheckStatus = "ok" | "error";

interface SyncRow {
  last_block: unknown;
  updated_at: unknown;
}

async function checkDb(
  deps: AppDeps,
): Promise<{ db: CheckStatus; lastBlock: number; lastSyncAt: string | null }> {
  try {
    const res = await deps.db.query<SyncRow>(
      "SELECT last_block, updated_at FROM sync_state WHERE id = 1",
    );
    const row = res.rows[0];
    return {
      db: "ok",
      lastBlock: int(row?.last_block ?? 0),
      lastSyncAt: iso(row?.updated_at),
    };
  } catch {
    return { db: "error", lastBlock: 0, lastSyncAt: null };
  }
}

async function checkRpc(deps: AppDeps): Promise<CheckStatus> {
  const url = deps.config.rpcUrl;
  if (!url) return "error";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_blockNumber",
        params: [],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return "error";
    const body = (await res.json()) as unknown;
    if (
      body !== null &&
      typeof body === "object" &&
      typeof (body as { result?: unknown }).result === "string"
    ) {
      return "ok";
    }
    return "error";
  } catch {
    return "error";
  } finally {
    clearTimeout(timer);
  }
}

export function registerHealth(app: FastifyInstance, deps: AppDeps): void {
  app.get("/health", async (_request, reply) => {
    const [dbResult, rpc] = await Promise.all([checkDb(deps), checkRpc(deps)]);

    const services = deps.config.serviceStatusOverride ?? {
      indexer: "unknown",
      scoreEngine: "unknown",
      oraclePublisher: "unknown",
    };

    const status = dbResult.db === "ok" && rpc === "ok" ? "ok" : "degraded";

    reply.header("Cache-Control", "no-store");
    return reply.status(200).send({
      status,
      chainId: deps.config.chainId,
      lastBlock: dbResult.lastBlock,
      lastSyncAt: dbResult.lastSyncAt,
      confirmations: deps.config.confirmations,
      db: dbResult.db,
      rpc,
      services,
    });
  });
}
