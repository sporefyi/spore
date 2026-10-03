import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppDeps } from "../types.js";
import { sendError } from "./util.js";
import { ethers } from "ethers";

/**
 * POST /api/v1/onboard/orbio — "Bring your Orbio agent".
 *
 * Body: { orbioKey, agentName, ownerAddress }
 *
 * 1. Validates inputs.
 * 2. Rate-limits per IP (gas-sponsored registration must not be spammable).
 * 3. Verifies the Orbio API key against api.orbio.so (transient — the key is
 *    never logged, never persisted; a 401 means unknown/revoked key).
 * 4. Registers the agent on the SporeRegistry with a dedicated gas-sponsor
 *    key (ONBOARDER_PRIVATE_KEY — holds no protocol roles), then transfers
 *    ownership to `ownerAddress` via setAgentOwner.
 *
 * registerAgent is permissionless on-chain; this endpoint exists to sponsor
 * gas and to bind the onboarding to a verified Orbio account.
 *
 * Deployed 2026-10-03.
 */

const ORBIO_VERIFY_URL = "https://api.orbio.so/api/v1/tools/social.post.status";
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (arr.length >= RATE_LIMIT_MAX) return true;
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

function isAddress(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}

/** Returns true when the key authenticates (any non-401 response). */
async function verifyOrbioKey(key: string): Promise<"ok" | "invalid" | "unreachable"> {
  let res: Response;
  try {
    res = await fetch(ORBIO_VERIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ post_id: "spore-key-verify" }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return "unreachable";
  }
  if (res.status === 401) return "invalid";
  return "ok";
}

const REGISTRY_ABI = [
  "function registerAgent(string metadataURI) returns (uint256)",
  "function setAgentOwner(uint256 agentId, address newOwner)",
];

export function registerOnboard(v1: FastifyInstance, deps: AppDeps): void {
  v1.post("/onboard/orbio", async (request, reply: FastifyReply) => {
    const ip = request.ip;
    if (rateLimited(ip)) {
      return sendError(reply, 429, "rate_limited", "too many onboarding attempts; try again later");
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const orbioKey = body.orbioKey;
    const agentName = typeof body.agentName === "string" ? body.agentName.trim() : "";
    const ownerAddress = body.ownerAddress;

    if (typeof orbioKey !== "string" || orbioKey.length < 10 || orbioKey.length > 500) {
      return sendError(reply, 400, "bad_request", "a valid Orbio API key is required");
    }
    if (agentName.length < 1 || agentName.length > 64) {
      return sendError(reply, 400, "bad_request", "agent name must be 1–64 characters");
    }
    if (!isAddress(ownerAddress)) {
      return sendError(reply, 400, "bad_request", "ownerAddress must be a 0x address");
    }

    // The key is used transiently for this one verification call only.
    const keyCheck = await verifyOrbioKey(orbioKey);
    if (keyCheck === "invalid") {
      return sendError(reply, 401, "invalid_orbio_key", "this Orbio API key is unknown or revoked");
    }
    if (keyCheck === "unreachable") {
      return sendError(reply, 502, "orbio_unreachable", "could not reach Orbio; try again");
    }

    const sponsorKey = process.env.ONBOARDER_PRIVATE_KEY;
    if (!sponsorKey) {
      deps.logger.error("ONBOARDER_PRIVATE_KEY not configured");
      return sendError(reply, 503, "onboarding_unavailable", "onboarding is not configured yet");
    }

    try {
      const provider = new ethers.JsonRpcProvider(deps.config.rpcUrl);
      const sponsor = new ethers.Wallet(sponsorKey, provider);
      const registry = new ethers.Contract(deps.config.contracts.registry, REGISTRY_ABI, sponsor);

      // Predict the agent id first so we can return it even if parsing fails.
      const agentId: bigint = await registry.registerAgent.staticCall(agentName);
      const tx = await registry.registerAgent(agentName);
      const receipt = await tx.wait(1);
      if (receipt?.status !== 1) {
        return sendError(reply, 502, "registration_failed", "on-chain registration reverted");
      }
      const tx2 = await registry.setAgentOwner(agentId, ownerAddress);
      const receipt2 = await tx2.wait(1);
      if (receipt2?.status !== 1) {
        // Registration succeeded but ownership transfer failed — the sponsor
        // still owns it; surface honestly so it can be retried/completed.
        return sendError(reply, 502, "transfer_failed", "agent registered but ownership transfer reverted");
      }

      return reply.send({
        agentId: agentId.toString(),
        owner: ownerAddress,
        txHash: tx.hash,
        transferTxHash: tx2.hash,
        explorerUrl: `https://robinhoodchain.blockscout.com/address/${deps.config.contracts.registry}`,
      });
    } catch (err) {
      deps.logger.error({ err }, "orbio onboarding failed");
      return sendError(reply, 502, "onboarding_failed", "on-chain onboarding failed; try again");
    }
  });
}
