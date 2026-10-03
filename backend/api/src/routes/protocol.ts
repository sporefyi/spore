import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../types.js";

export function registerProtocol(app: FastifyInstance, deps: AppDeps): void {
  app.get("/protocol", async (_request, reply) => {
    const { config } = deps;
    const c = config.contracts;

    const isSet = (v: unknown): boolean => typeof v === "string" && v.length > 0;

    const active =
      isSet(c.registry) &&
      isSet(c.creditManager) &&
      isSet(c.backerVault) &&
      isSet(c.scoreOracle) &&
      isSet(c.feeRouter);

    reply.header("Cache-Control", "public, max-age=60");

    return {
      active,
      chainId: config.chainId,
      chainName: config.chainName,
      asset: {
        address: config.assetAddress,
        decimals: config.assetDecimals,
        symbol: config.assetSymbol,
      },
      contracts: {
        registry: c.registry,
        creditManager: c.creditManager,
        backerVault: c.backerVault,
        scoreOracle: c.scoreOracle,
        feeRouter: c.feeRouter,
      },
      scoreModel: {
        version: config.scoreModelVersion,
        status: "provisional",
      },
    };
  });
}
