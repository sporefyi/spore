import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../types.js";
import { sendError } from "./util.js";
import { ethers } from "ethers";

/**
 * SPORE GPU merchant — paid image generation via Replicate (serverless GPUs).
 *
 * POST /api/v1/market/gpu — 1 USDG per image.
 * Body: { prompt: string, paymentTx }
 *
 * 1. Validates inputs + rate-limits per IP.
 * 2. Verifies paymentTx on-chain: a USDG Transfer of >= 1 USDG to MERCHANT.
 *    Each tx hash is accepted once — no double-spend.
 * 3. Runs Flux Schnell on Replicate and returns the image URL.
 */

const MERCHANT = "0x4c7cfbd388249f3c3027c52635cf70bb78084ed5";
const PRICE = 1_000_000n; // 1 USDG (6 decimals)
const REPLICATE_URL = "https://api.replicate.com/v1/predictions";
// Flux Schnell — fast, high-quality image generation
const MODEL_VERSION = "black-forest-labs/flux-schnell";
const UPSTREAM_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 40;

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 10;

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (arr.length >= RATE_LIMIT_MAX) return true;
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

/** Verify paymentTx contains a USDG transfer of >= PRICE to MERCHANT. Returns payer or null. */
async function verifyPayment(rpcUrl: string, asset: string, paymentTx: string): Promise<string | null> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(paymentTx);
  } catch {
    return null;
  }
  if (!receipt || receipt.status !== 1) return null;
  const assetLc = asset.toLowerCase();
  const merchantLc = MERCHANT.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== assetLc) continue;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const to = ("0x" + log.topics[2]?.slice(-40)).toLowerCase();
    if (to !== merchantLc) continue;
    const value = BigInt(log.data);
    if (value < PRICE) continue;
    return ("0x" + log.topics[1]?.slice(-40)).toLowerCase();
  }
  return null;
}

interface ReplicatePrediction {
  id: string;
  status: string;
  output?: string[];
  error?: string;
}

async function runReplicate(apiKey: string, prompt: string, logger: AppDeps["logger"]): Promise<string[]> {
  // Create prediction
  const createRes = await fetch(REPLICATE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL_VERSION,
      input: { prompt, num_outputs: 1, aspect_ratio: "1:1", output_format: "png" },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!createRes.ok) {
    const t = await createRes.text().catch(() => "");
    throw new Error(`replicate create ${createRes.status}: ${t.slice(0, 200)}`);
  }
  const pred = (await createRes.json()) as ReplicatePrediction;
  const predictionId = pred.id;

  // Poll until complete
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollRes = await fetch(`${REPLICATE_URL}/${predictionId}`, {
      headers: { Authorization: `Token ${apiKey}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!pollRes.ok) continue;
    const p = (await pollRes.json()) as ReplicatePrediction;
    if (p.status === "succeeded" && p.output) return p.output;
    if (p.status === "failed" || p.status === "canceled") {
      throw new Error(`replicate prediction ${p.status}: ${(p.error ?? "").slice(0, 200)}`);
    }
  }
  throw new Error("replicate prediction timed out");
}

export function registerMarketGpu(v1: FastifyInstance, deps: AppDeps): void {
  const { db, config, logger } = deps;

  v1.post("/market/gpu", async (req, reply) => {
    if (rateLimited(req.ip)) return sendError(reply, 429, "rate_limited", "too many requests");
    const body = req.body as Record<string, unknown> | undefined;
    const prompt = typeof body?.prompt === "string" ? body.prompt.slice(0, 500).trim() : "";
    const paymentTx = typeof body?.paymentTx === "string" ? body.paymentTx : "";
    if (!prompt) return sendError(reply, 400, "bad_request", "prompt (1-500 chars) required");
    if (!/^0x[0-9a-fA-F]{64}$/.test(paymentTx)) {
      return sendError(reply, 400, "bad_request", "paymentTx (0x + 64 hex chars) required");
    }

    const apiKey = process.env.REPLICATE_API_TOKEN ?? "";
    if (!apiKey) return sendError(reply, 503, "not_configured", "gpu merchant not configured");

    const payer = await verifyPayment(config.rpcUrl, config.assetAddress, paymentTx);
    if (!payer) {
      return sendError(reply, 402, "payment_not_found", "no confirmed 1 USDG payment to merchant in that tx");
    }

    // Idempotency: one generation per payment tx — return the cached result.
    const dup = await db.query(
      `SELECT id, model, prompt, output_urls FROM gpu_generations WHERE payment_tx = $1`,
      [paymentTx.toLowerCase()],
    );
    if (dup.rows.length > 0) {
      const j = dup.rows[0];
      return reply.send({ id: j.id, model: j.model, prompt: j.prompt, images: j.output_urls, cached: true });
    }

    let outputUrls: string[];
    try {
      outputUrls = await runReplicate(apiKey, prompt, logger);
    } catch (e) {
      logger.error({ err: e }, "replicate generation failed");
      return sendError(reply, 502, "generation_failed", "could not generate image");
    }

    const r = await db.query(
      `INSERT INTO gpu_generations (model, prompt, payment_tx, payer, output_urls)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (payment_tx) DO NOTHING
       RETURNING id`,
      [MODEL_VERSION, prompt, paymentTx.toLowerCase(), payer, JSON.stringify(outputUrls)],
    );
    const id = r.rows[0]?.id ?? null;
    logger.info({ id, payer, prompt: prompt.slice(0, 50) }, "gpu generation complete");
    return reply.send({ id, model: MODEL_VERSION, prompt, images: outputUrls });
  });
}
