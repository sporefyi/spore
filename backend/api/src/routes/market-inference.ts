import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../types.js";
import { sendError } from "./util.js";
import { ethers } from "ethers";

/**
 * SPORE Inference merchant — paid AI chat completions via Orbio gateway.
 *
 * POST /api/v1/market/inference — 0.5 USDG per request.
 * Body: { messages: [{ role: "user"|"assistant"|"system", content: string }], maxTokens?, paymentTx }
 *
 * 1. Validates inputs + rate-limits per IP.
 * 2. Verifies paymentTx on-chain: a USDG Transfer of >= 0.5 USDG to MERCHANT.
 *    Each tx hash is accepted once — no double-spend.
 * 3. Forwards to the Orbio chat-completions API and returns the response.
 */

const MERCHANT = "0x4c7cfbd388249f3c3027c52635cf70bb78084ed5";
const PRICE = 500_000n; // 0.5 USDG (6 decimals)
const MODEL = "anthropic/claude-haiku-4.5";
const ORBIO_URL = "https://api.orbio.so/api/v1/chat/completions";
const MAX_INPUT_CHARS = 8000;
const MAX_TOKENS_CAP = 4000;
const DEFAULT_MAX_TOKENS = 1000;
const UPSTREAM_TIMEOUT_MS = 120_000;

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

const VALID_ROLES = new Set(["user", "assistant", "system"]);

interface ChatMessage {
  role: string;
  content: string;
}

function validateMessages(raw: unknown): { ok: true; messages: ChatMessage[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, reason: "messages must be a non-empty array" };
  if (raw.length > 50) return { ok: false, reason: "too many messages (max 50)" };
  const messages: ChatMessage[] = [];
  let totalChars = 0;
  for (const m of raw) {
    if (typeof m !== "object" || m === null) return { ok: false, reason: "each message must be an object" };
    const { role, content } = m as Record<string, unknown>;
    if (typeof role !== "string" || !VALID_ROLES.has(role)) {
      return { ok: false, reason: 'each message role must be "user", "assistant" or "system"' };
    }
    if (typeof content !== "string" || content.length === 0) {
      return { ok: false, reason: "each message content must be a non-empty string" };
    }
    totalChars += content.length;
    if (totalChars > MAX_INPUT_CHARS) return { ok: false, reason: `total input exceeds ${MAX_INPUT_CHARS} chars` };
    messages.push({ role, content });
  }
  return { ok: true, messages };
}

export function registerMarketInference(v1: FastifyInstance, deps: AppDeps): void {
  const { db, config, logger } = deps;

  v1.post("/market/inference", async (req, reply) => {
    if (rateLimited(req.ip)) return sendError(reply, 429, "rate_limited", "too many requests");
    const body = req.body as Record<string, unknown> | undefined;
    const paymentTx = typeof body?.paymentTx === "string" ? body.paymentTx : "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(paymentTx)) {
      return sendError(reply, 400, "bad_request", "paymentTx (0x + 64 hex chars) required");
    }

    const validated = validateMessages(body?.messages);
    if (!validated.ok) return sendError(reply, 400, "bad_request", validated.reason);

    let maxTokens = DEFAULT_MAX_TOKENS;
    if (body?.maxTokens !== undefined) {
      const n = Number(body.maxTokens);
      if (!Number.isInteger(n) || n < 1 || n > MAX_TOKENS_CAP) {
        return sendError(reply, 400, "bad_request", `maxTokens must be an integer 1-${MAX_TOKENS_CAP}`);
      }
      maxTokens = n;
    }

    const apiKey = process.env.ORBIO_API_KEY ?? "";
    if (!apiKey) return sendError(reply, 503, "not_configured", "inference merchant not configured");

    const payer = await verifyPayment(config.rpcUrl, config.assetAddress, paymentTx);
    if (!payer) {
      return sendError(reply, 402, "payment_not_found", "no confirmed 0.5 USDG payment to merchant in that tx");
    }

    // Idempotency: one inference per payment tx — return the cached response.
    const dup = await db.query(
      `SELECT id, model, response, tokens_used FROM inference_requests WHERE payment_tx = $1`,
      [paymentTx.toLowerCase()],
    );
    if (dup.rows.length > 0) {
      const j = dup.rows[0];
      return reply.send({ id: j.id, model: j.model, response: j.response, usage: { totalTokens: j.tokens_used }, cached: true });
    }

    let upstream: Response;
    try {
      upstream = await fetch(ORBIO_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: MODEL, messages: validated.messages, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (e) {
      logger.error({ err: e }, "orbio inference fetch failed");
      return sendError(reply, 502, "upstream_error", "inference provider unreachable");
    }
    if (!upstream.ok) {
      const t = await upstream.text().catch(() => "");
      logger.error({ status: upstream.status, body: t.slice(0, 300) }, "orbio inference rejected");
      return sendError(reply, 502, "upstream_error", "inference provider rejected the request");
    }

    let data: {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    try {
      data = (await upstream.json()) as typeof data;
    } catch (e) {
      logger.error({ err: e }, "orbio inference returned non-JSON");
      return sendError(reply, 502, "upstream_error", "inference provider returned an invalid response");
    }

    const responseText = data.choices?.[0]?.message?.content;
    if (typeof responseText !== "string" || responseText.length === 0) {
      logger.error("orbio inference returned no content");
      return sendError(reply, 502, "upstream_error", "inference provider returned no content");
    }
    const tokensUsed = data.usage?.total_tokens ?? null;
    const modelUsed = data.model ?? MODEL;

    const r = await db.query(
      `INSERT INTO inference_requests (model, messages, payment_tx, payer, response, tokens_used)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (payment_tx) DO NOTHING
       RETURNING id`,
      [modelUsed, JSON.stringify(validated.messages), paymentTx.toLowerCase(), payer, responseText, tokensUsed],
    );
    // Race: another request won the insert; return its row.
    let id: number = r.rows[0]?.id;
    if (id === undefined) {
      const existing = await db.query(`SELECT id FROM inference_requests WHERE payment_tx = $1`, [
        paymentTx.toLowerCase(),
      ]);
      id = existing.rows[0].id;
    }

    logger.info({ id, payer, model: modelUsed, tokensUsed }, "inference complete");
    return reply.send({
      id,
      model: modelUsed,
      response: responseText,
      usage: {
        totalTokens: tokensUsed,
        promptTokens: data.usage?.prompt_tokens ?? null,
        completionTokens: data.usage?.completion_tokens ?? null,
      },
      payer,
      merchant: MERCHANT,
    });
  });
}
