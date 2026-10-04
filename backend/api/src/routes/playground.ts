import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps, DbClient, Logger } from "../types.js";
import { sendError } from "./util.js";
import { ethers } from "ethers";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

/**
 * SPORE Playground — credit-based access to Orbio models.
 *
 * Credits are funded two ways:
 *   1. Burning $SPORE to the dead address (100 credits per SPORE) via
 *      POST /api/v1/playground/credits/burn  { txHash }
 *   2. Paying USDG to the merchant wallet (1000 credits per USDG) via
 *      POST /api/v1/playground/merchant/spend  { paymentTx }
 *
 * Chat/image endpoints are authenticated with an EIP-191 signature over:
 *   SPORE Playground\nWallet: <lowercase addr>\nTimestamp: <ts>
 * with the timestamp within 5 minutes of the server clock.
 *
 * Pricing: chat = 10 credits, image = 50 credits.
 *
 * Admin endpoints (x-admin-secret = WORKER_SECRET):
 *   GET  /api/v1/playground/admin/models  — raw Orbio /v1/models list
 *   POST /api/v1/playground/admin/probe    — minimal live probe of one model
 */

const SPORE = "0xa5127fae2d0986a4cb6619b9c4ec53461726454b";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const MERCHANT = "0x4c7cfbd388249f3c3027c52635cf70bb78084Ed5";

const ORBIO_CHAT_URL = "https://api.orbio.so/api/v1/chat/completions";
const ORBIO_MODELS_URL = "https://api.orbio.so/api/v1/models";
// Primary images endpoint (OpenAI shape). If Orbio 404s here, /v1/images is the
// documented fallback — the proxy tries both in order.
const ORBIO_IMAGES_URL = "https://api.orbio.so/api/v1/images/generations";
const ORBIO_IMAGES_FALLBACK_URL = "https://api.orbio.so/api/v1/images";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const CHAT_COST = 10;
const IMAGE_COST = 50;
const UPSTREAM_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 10_000;

const AUTH_WINDOW_MS = 5 * 60 * 1000;
const MAX_INPUT_CHARS = 8000;
const MAX_PROMPT_CHARS = 1000;
const MAX_TOKENS_CAP = 4000;
const DEFAULT_MAX_TOKENS = 1000;

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const WALLET_RATE_LIMIT_MAX = 20;

// ---------------------------------------------------------------------------
// working-models.json loading
// ---------------------------------------------------------------------------

interface WorkingModelEntry {
  id: string;
  type: string;
  name?: string;
}

function loadWorkingModels(): { models: WorkingModelEntry[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dist layout (if the JSON is copied next to the built file)
    join(here, "playground", "working-models.json"),
    // running from dist/ with the repo's src/ present (Render ships the repo)
    join(here, "..", "..", "src", "playground", "working-models.json"),
    // running from src/ directly (vitest / ts-node)
    join(here, "playground", "working-models.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const models = (parsed as { models?: unknown }).models;
        if (Array.isArray(models)) {
          const clean: WorkingModelEntry[] = [];
          for (const m of models) {
            if (m !== null && typeof m === "object" && !Array.isArray(m)) {
              const rec = m as Record<string, unknown>;
              if (typeof rec.id === "string" && typeof rec.type === "string") {
                const entry: WorkingModelEntry = { id: rec.id, type: rec.type };
                if (typeof rec.name === "string") entry.name = rec.name;
                clean.push(entry);
              }
            }
          }
          return { models: clean };
        }
      }
      return { models: [] };
    } catch {
      // try the next candidate
    }
  }
  return { models: [] };
}

// ---------------------------------------------------------------------------
// Rate limiting (per wallet, per hour)
// ---------------------------------------------------------------------------

const walletHits = new Map<string, number[]>();
function walletRateLimited(wallet: string): boolean {
  const now = Date.now();
  const arr = (walletHits.get(wallet) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (arr.length >= WALLET_RATE_LIMIT_MAX) return true;
  arr.push(now);
  walletHits.set(wallet, arr);
  return false;
}

const ipHits = new Map<string, number[]>();
function ipRateLimited(ip: string, max: number): boolean {
  const now = Date.now();
  const arr = (ipHits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (arr.length >= max) return true;
  arr.push(now);
  ipHits.set(ip, arr);
  return false;
}

// ---------------------------------------------------------------------------
// Signature auth
// ---------------------------------------------------------------------------

interface AuthBody {
  wallet?: unknown;
  signature?: unknown;
  timestamp?: unknown;
}

function verifyPlaygroundAuth(body: AuthBody): { ok: true; wallet: string } | { ok: false; reason: string } {
  const wallet = typeof body.wallet === "string" ? body.wallet : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return { ok: false, reason: "wallet (0x address) required" };
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature) && !/^0x[0-9a-fA-F]{132}$/.test(signature)) {
    return { ok: false, reason: "signature (65-byte 0x hex) required" };
  }
  const ts = Number(body.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) {
    return { ok: false, reason: "timestamp required" };
  }
  const tsMs = ts < 1e12 ? ts * 1000 : ts; // accept seconds or ms
  if (Math.abs(Date.now() - tsMs) > AUTH_WINDOW_MS) {
    return { ok: false, reason: "timestamp expired (must be within 5 minutes)" };
  }
  const addr = wallet.toLowerCase();
  const message = `SPORE Playground\nWallet: ${addr}\nTimestamp: ${String(ts)}`;
  let recovered: string;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch {
    return { ok: false, reason: "invalid signature" };
  }
  if (recovered.toLowerCase() !== addr) {
    return { ok: false, reason: "signature does not match wallet" };
  }
  return { ok: true, wallet: addr };
}

// ---------------------------------------------------------------------------
// On-chain verification
// ---------------------------------------------------------------------------

interface BurnTransfer {
  from: string;
  value: bigint;
}

/** Find a $SPORE Transfer to the dead address in the tx receipt. */
async function verifyBurn(rpcUrl: string, txHash: string): Promise<BurnTransfer | null> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch {
    return null;
  }
  if (!receipt || receipt.status !== 1) return null;
  const sporeLc = SPORE.toLowerCase();
  const deadLc = DEAD.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== sporeLc) continue;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (!log.topics[1] || !log.topics[2]) continue;
    const to = ("0x" + log.topics[2].slice(-40)).toLowerCase();
    if (to !== deadLc) continue;
    const value = BigInt(log.data);
    if (value <= 0n) continue;
    const from = ("0x" + log.topics[1].slice(-40)).toLowerCase();
    return { from, value };
  }
  return null;
}

interface UsdgPayment {
  payer: string;
  value: bigint;
}

/** Find a USDG Transfer of any positive amount to MERCHANT in the tx receipt. */
async function verifyUsdgPayment(rpcUrl: string, paymentTx: string): Promise<UsdgPayment | null> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(paymentTx);
  } catch {
    return null;
  }
  if (!receipt || receipt.status !== 1) return null;
  const usdgLc = USDG.toLowerCase();
  const merchantLc = MERCHANT.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdgLc) continue;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (!log.topics[1] || !log.topics[2]) continue;
    const to = ("0x" + log.topics[2].slice(-40)).toLowerCase();
    if (to !== merchantLc) continue;
    const value = BigInt(log.data);
    if (value <= 0n) continue;
    const payer = ("0x" + log.topics[1].slice(-40)).toLowerCase();
    return { payer, value };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Credit ledger helpers
// ---------------------------------------------------------------------------

async function getBalance(db: DbClient, wallet: string): Promise<number> {
  const r = await db.query<{ credits: number }>(`SELECT credits FROM playground_credits WHERE wallet = $1`, [
    wallet,
  ]);
  return r.rows.length > 0 ? Number(r.rows[0].credits) : 0;
}

async function grantCredits(db: DbClient, wallet: string, amount: number): Promise<number> {
  const r = await db.query<{ credits: number }>(
    `INSERT INTO playground_credits (wallet, credits) VALUES ($1, $2)
     ON CONFLICT (wallet) DO UPDATE
       SET credits = playground_credits.credits + EXCLUDED.credits, updated_at = NOW()
     RETURNING credits`,
    [wallet, amount],
  );
  return Number(r.rows[0].credits);
}

/**
 * Atomically deduct credits only when the balance covers the cost.
 * Returns the new balance, or null when funds are insufficient.
 */
async function spendCredits(db: DbClient, wallet: string, cost: number): Promise<number | null> {
  const r = await db.query<{ credits: number }>(
    `UPDATE playground_credits SET credits = credits - $2, updated_at = NOW()
     WHERE wallet = $1 AND credits >= $2
     RETURNING credits`,
    [wallet, cost],
  );
  return r.rows.length > 0 ? Number(r.rows[0].credits) : null;
}

async function refundCredits(db: DbClient, wallet: string, amount: number): Promise<void> {
  await db.query(
    `UPDATE playground_credits SET credits = credits + $2, updated_at = NOW() WHERE wallet = $1`,
    [wallet, amount],
  );
}

// ---------------------------------------------------------------------------
// Orbio helpers
// ---------------------------------------------------------------------------

function orbioHeaders(apiKey: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}

interface OrbioChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

async function orbioChat(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  timeoutMs: number,
  logger: Logger,
): Promise<{ ok: true; text: string; model: string; usage: OrbioChatResponse["usage"] } | { ok: false; code: string; message: string }> {
  let upstream: Response;
  try {
    upstream = await fetch(ORBIO_CHAT_URL, {
      method: "POST",
      headers: orbioHeaders(apiKey),
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    logger.error({ err: e }, "orbio playground chat fetch failed");
    return { ok: false, code: "upstream_error", message: "model provider unreachable" };
  }
  if (!upstream.ok) {
    const t = await upstream.text().catch(() => "");
    logger.error({ status: upstream.status, body: t.slice(0, 300) }, "orbio playground chat rejected");
    return { ok: false, code: "upstream_error", message: "model provider rejected the request" };
  }
  let data: OrbioChatResponse;
  try {
    data = (await upstream.json()) as OrbioChatResponse;
  } catch (e) {
    logger.error({ err: e }, "orbio playground chat returned non-JSON");
    return { ok: false, code: "upstream_error", message: "model provider returned an invalid response" };
  }
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.length === 0) {
    logger.error("orbio playground chat returned no content");
    return { ok: false, code: "upstream_error", message: "model provider returned no content" };
  }
  return { ok: true, text, model: data.model ?? model, usage: data.usage };
}

interface OrbioImageResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
}

async function orbioImage(
  apiKey: string,
  model: string,
  prompt: string,
  logger: Logger,
): Promise<{ ok: true; urls: string[] } | { ok: false; code: string; message: string }> {
  const urls = [ORBIO_IMAGES_URL, ORBIO_IMAGES_FALLBACK_URL];
  let lastStatus = 0;
  for (const url of urls) {
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: "POST",
        headers: orbioHeaders(apiKey),
        body: JSON.stringify({ model, prompt }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (e) {
      logger.error({ err: e, url }, "orbio playground image fetch failed");
      return { ok: false, code: "upstream_error", message: "model provider unreachable" };
    }
    if (upstream.status === 404 && url === ORBIO_IMAGES_URL) {
      // Primary endpoint not found on this Orbio build — try the /v1/images fallback.
      logger.info("orbio images/generations 404, trying /v1/images fallback");
      continue;
    }
    lastStatus = upstream.status;
    if (!upstream.ok) {
      const t = await upstream.text().catch(() => "");
      logger.error({ status: upstream.status, body: t.slice(0, 300) }, "orbio playground image rejected");
      return { ok: false, code: "upstream_error", message: "model provider rejected the request" };
    }
    let data: OrbioImageResponse;
    try {
      data = (await upstream.json()) as OrbioImageResponse;
    } catch (e) {
      logger.error({ err: e }, "orbio playground image returned non-JSON");
      return { ok: false, code: "upstream_error", message: "model provider returned an invalid response" };
    }
    const out: string[] = [];
    for (const item of data.data ?? []) {
      if (typeof item.url === "string" && item.url.length > 0) out.push(item.url);
      else if (typeof item.b64_json === "string" && item.b64_json.length > 0) {
        out.push(`data:image/png;base64,${item.b64_json}`);
      }
    }
    if (out.length === 0) {
      logger.error({ body: JSON.stringify(data).slice(0, 300) }, "orbio playground image returned no usable images");
      return { ok: false, code: "upstream_error", message: "model provider returned no images" };
    }
    return { ok: true, urls: out };
  }
  logger.error({ status: lastStatus }, "orbio playground image: all endpoints 404");
  return { ok: false, code: "upstream_error", message: "image endpoint not available on the provider" };
}

// ---------------------------------------------------------------------------
// Message validation (same rules as market-inference.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Model probing helpers
// ---------------------------------------------------------------------------

type ModelKind = "chat" | "image" | "audio" | "video";

function inferKind(modelId: string): ModelKind {
  const s = modelId.toLowerCase();
  if (["flux", "seedream", "dall", "imagen", "image", "sd-", "stable-diffusion"].some((k) => s.includes(k))) {
    return "image";
  }
  if (["whisper", "tts", "audio", "suno", "music"].some((k) => s.includes(k))) return "audio";
  if (["video", "sora", "veo", "kling", "runway", "pika", "luma"].some((k) => s.includes(k))) return "video";
  return "chat";
}

interface ModelCache {
  at: number;
  ids: Set<string>;
  raw: unknown;
}

let modelCache: ModelCache | null = null;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchOrbioModels(apiKey: string, logger: Logger): Promise<ModelCache | null> {
  if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_TTL_MS) return modelCache;
  let upstream: Response;
  try {
    upstream = await fetch(ORBIO_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    logger.error({ err: e }, "orbio models fetch failed");
    return null;
  }
  if (!upstream.ok) {
    const t = await upstream.text().catch(() => "");
    logger.error({ status: upstream.status, body: t.slice(0, 300) }, "orbio models rejected");
    return null;
  }
  let raw: unknown;
  try {
    raw = (await upstream.json()) as unknown;
  } catch {
    return null;
  }
  const ids = new Set<string>();
  const arr = Array.isArray(raw) ? raw : (raw as { data?: unknown }).data;
  if (Array.isArray(arr)) {
    for (const m of arr) {
      const id = typeof m === "string" ? m : (m as { id?: unknown } | null)?.id;
      if (typeof id === "string") ids.add(id);
    }
  }
  modelCache = { at: Date.now(), ids, raw };
  return modelCache;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function checkAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  const secret = process.env.WORKER_SECRET ?? "";
  const provided = req.headers["x-admin-secret"];
  if (!secret || typeof provided !== "string" || provided !== secret) {
    sendError(reply, 401, "unauthorized", "admin secret required");
    return false;
  }
  return true;
}

export function registerPlayground(v1: FastifyInstance, deps: AppDeps): void {
  const { db, config, logger } = deps;

  const apiKey = (): string => process.env.ORBIO_API_KEY ?? "";

  // --- POST /api/v1/playground/credits/burn --------------------------------
  v1.post("/playground/credits/burn", async (req, reply) => {
    if (ipRateLimited(req.ip, 10)) return sendError(reply, 429, "rate_limited", "too many requests");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const txHash = typeof body.txHash === "string" ? body.txHash : "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return sendError(reply, 400, "bad_request", "txHash (0x + 64 hex chars) required");
    }
    const txLc = txHash.toLowerCase();

    // Idempotency: a burn tx is credited once. Return the stored row on dup.
    const dup = await db.query<{ wallet: string; spore_amount: string; credits_granted: number }>(
      `SELECT wallet, spore_amount, credits_granted FROM playground_burns WHERE tx_hash = $1`,
      [txLc],
    );
    if (dup.rows.length > 0) {
      const j = dup.rows[0];
      const balance = await getBalance(db, j.wallet);
      return reply.send({
        wallet: j.wallet,
        sporeBurned: j.spore_amount,
        creditsGranted: Number(j.credits_granted),
        balance,
        cached: true,
      });
    }

    const burn = await verifyBurn(config.rpcUrl, txHash);
    if (!burn) {
      return sendError(reply, 402, "burn_not_found", "no confirmed $SPORE burn to the dead address in that tx");
    }

    // 100 credits per SPORE, exact BigInt math (18 decimals).
    const credits = Number((burn.value * 100n) / 10n ** 18n);
    const sporeBurned = ethers.formatEther(burn.value);

    const ins = await db.query<{ wallet: string }>(
      `INSERT INTO playground_burns (wallet, tx_hash, spore_amount, credits_granted)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tx_hash) DO NOTHING
       RETURNING wallet`,
      [burn.from, txLc, sporeBurned, credits],
    );
    let wallet = burn.from;
    if (ins.rows.length === 0) {
      // Race: another request credited this tx first.
      const existing = await db.query<{ wallet: string; spore_amount: string; credits_granted: number }>(
        `SELECT wallet, spore_amount, credits_granted FROM playground_burns WHERE tx_hash = $1`,
        [txLc],
      );
      const j = existing.rows[0];
      const balance = await getBalance(db, j.wallet);
      return reply.send({
        wallet: j.wallet,
        sporeBurned: j.spore_amount,
        creditsGranted: Number(j.credits_granted),
        balance,
        cached: true,
      });
    }

    const balance = await grantCredits(db, wallet, credits);
    logger.info({ wallet, tx: txLc, sporeBurned, credits }, "playground burn credited");
    return reply.send({ wallet, sporeBurned, creditsGranted: credits, balance });
  });

  // --- POST /api/v1/playground/merchant/spend -------------------------------
  v1.post("/playground/merchant/spend", async (req, reply) => {
    if (ipRateLimited(req.ip, 10)) return sendError(reply, 429, "rate_limited", "too many requests");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const paymentTx = typeof body.paymentTx === "string" ? body.paymentTx : "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(paymentTx)) {
      return sendError(reply, 400, "bad_request", "paymentTx (0x + 64 hex chars) required");
    }
    const txLc = paymentTx.toLowerCase();

    const dup = await db.query<{ wallet: string; usdg_amount: string; credits_granted: number }>(
      `SELECT wallet, usdg_amount, credits_granted FROM playground_merchant_spends WHERE payment_tx = $1`,
      [txLc],
    );
    if (dup.rows.length > 0) {
      const j = dup.rows[0];
      const balance = await getBalance(db, j.wallet);
      return reply.send({
        wallet: j.wallet,
        usdgSpent: j.usdg_amount,
        creditsGranted: Number(j.credits_granted),
        balance,
        cached: true,
      });
    }

    const payment = await verifyUsdgPayment(config.rpcUrl, paymentTx);
    if (!payment) {
      return sendError(reply, 402, "payment_not_found", "no confirmed USDG payment to the merchant in that tx");
    }

    // 1000 credits per USDG, exact BigInt math (6 decimals).
    const credits = Number((payment.value * 1000n) / 10n ** 6n);
    const usdgSpent = ethers.formatUnits(payment.value, 6);

    const ins = await db.query(
      `INSERT INTO playground_merchant_spends (wallet, payment_tx, usdg_amount, credits_granted)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (payment_tx) DO NOTHING`,
      [payment.payer, txLc, usdgSpent, credits],
    );
    if (ins.rowCount === 0) {
      const existing = await db.query<{ wallet: string; usdg_amount: string; credits_granted: number }>(
        `SELECT wallet, usdg_amount, credits_granted FROM playground_merchant_spends WHERE payment_tx = $1`,
        [txLc],
      );
      const j = existing.rows[0];
      const balance = await getBalance(db, j.wallet);
      return reply.send({
        wallet: j.wallet,
        usdgSpent: j.usdg_amount,
        creditsGranted: Number(j.credits_granted),
        balance,
        cached: true,
      });
    }

    const balance = await grantCredits(db, payment.payer, credits);
    logger.info({ wallet: payment.payer, tx: txLc, usdgSpent, credits }, "playground merchant spend credited");
    return reply.send({ wallet: payment.payer, usdgSpent, creditsGranted: credits, balance });
  });

  // --- GET /api/v1/playground/credits/:wallet --------------------------------
  v1.get("/playground/credits/:wallet", async (req, reply) => {
    const params = req.params as { wallet?: string };
    const wallet = typeof params.wallet === "string" ? params.wallet : "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return sendError(reply, 400, "bad_request", "wallet must be a 0x address");
    }
    const addr = wallet.toLowerCase();
    const credits = await getBalance(db, addr);
    return reply.send({ wallet: addr, credits });
  });

  // --- GET /api/v1/playground/models ------------------------------------------
  v1.get("/playground/models", async (_req, reply) => {
    return reply.send(loadWorkingModels());
  });

  // --- GET /api/v1/playground/stats -------------------------------------------
  v1.get("/playground/stats", async (_req, reply) => {
    const [burns, merchant, usage, wallets] = await Promise.all([
      db.query(
        `SELECT COALESCE(SUM(spore_amount::numeric), 0) AS total_spore,
                COALESCE(SUM(credits_granted), 0) AS total_credits_granted,
                COUNT(*) AS burn_count
         FROM playground_burns`
      ),
      db.query(
        `SELECT COALESCE(SUM(usdg_amount::numeric), 0) AS total_usdg,
                COALESCE(SUM(credits_granted), 0) AS total_credits_granted,
                COUNT(*) AS spend_count
         FROM playground_merchant_spends`
      ),
      db.query(
        `SELECT COALESCE(SUM(credits_spent), 0) AS total_spent,
                COUNT(*) AS call_count,
                COUNT(DISTINCT wallet) AS active_wallets
         FROM playground_usage`
      ),
      db.query(
        `SELECT COUNT(*) AS funded_wallets,
                COALESCE(SUM(credits), 0) AS credits_outstanding
         FROM playground_credits`
      ),
    ]);
    return reply.send({
      ok: true,
      data: {
        totalSporeBurned: burns.rows[0].total_spore,
        totalUsdgSpent: merchant.rows[0].total_usdg,
        totalCreditsGranted:
          Number(burns.rows[0].total_credits_granted) +
          Number(merchant.rows[0].total_credits_granted),
        burnCount: Number(burns.rows[0].burn_count),
        merchantSpendCount: Number(merchant.rows[0].spend_count),
        totalCreditsSpent: usage.rows[0].total_spent,
        totalCalls: Number(usage.rows[0].call_count),
        activeWallets: Number(usage.rows[0].active_wallets),
        fundedWallets: Number(wallets.rows[0].funded_wallets),
        creditsOutstanding: wallets.rows[0].credits_outstanding,
      },
    });
  });

  // --- POST /api/v1/playground/chat -------------------------------------------
  v1.post("/playground/chat", async (req, reply) => {
    const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
    const auth = verifyPlaygroundAuth(body);
    if (!auth.ok) return sendError(reply, 401, "unauthorized", auth.reason);
    if (walletRateLimited(auth.wallet)) return sendError(reply, 429, "rate_limited", "too many requests (20/hour)");

    const model = typeof body.model === "string" ? body.model : "";
    if (!model) return sendError(reply, 400, "bad_request", "model required");
    const entry = loadWorkingModels().models.find((m) => m.id === model);
    if (!entry) return sendError(reply, 400, "bad_request", "unknown model");
    if (entry.type !== "chat") return sendError(reply, 400, "bad_request", "model is not a chat model");

    const validated = validateMessages(body.messages);
    if (!validated.ok) return sendError(reply, 400, "bad_request", validated.reason);

    let maxTokens = DEFAULT_MAX_TOKENS;
    if (body.maxTokens !== undefined) {
      const n = Number(body.maxTokens);
      if (!Number.isInteger(n) || n < 1 || n > MAX_TOKENS_CAP) {
        return sendError(reply, 400, "bad_request", `maxTokens must be an integer 1-${MAX_TOKENS_CAP}`);
      }
      maxTokens = n;
    }

    const key = apiKey();
    if (!key) return sendError(reply, 503, "not_configured", "playground not configured");

    const balanceAfterSpend = await spendCredits(db, auth.wallet, CHAT_COST);
    if (balanceAfterSpend === null) {
      return sendError(reply, 402, "insufficient_credits", `chat costs ${CHAT_COST} credits`);
    }

    const result = await orbioChat(key, model, validated.messages, maxTokens, UPSTREAM_TIMEOUT_MS, logger);
    if (!result.ok) {
      await refundCredits(db, auth.wallet, CHAT_COST);
      return sendError(reply, 502, result.code, result.message);
    }

    await db.query(
      `INSERT INTO playground_usage (wallet, kind, model, credits_spent) VALUES ($1, 'chat', $2, $3)`,
      [auth.wallet, model, CHAT_COST],
    );

    logger.info({ wallet: auth.wallet, model, balance: balanceAfterSpend }, "playground chat complete");
    return reply.send({
      response: result.text,
      model: result.model,
      usage: {
        totalTokens: result.usage?.total_tokens ?? null,
        promptTokens: result.usage?.prompt_tokens ?? null,
        completionTokens: result.usage?.completion_tokens ?? null,
      },
      balance: balanceAfterSpend,
    });
  });

  // --- POST /api/v1/playground/image ------------------------------------------
  v1.post("/playground/image", async (req, reply) => {
    const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
    const auth = verifyPlaygroundAuth(body);
    if (!auth.ok) return sendError(reply, 401, "unauthorized", auth.reason);
    if (walletRateLimited(auth.wallet)) return sendError(reply, 429, "rate_limited", "too many requests (20/hour)");

    const model = typeof body.model === "string" ? body.model : "";
    if (!model) return sendError(reply, 400, "bad_request", "model required");
    const entry = loadWorkingModels().models.find((m) => m.id === model);
    if (!entry) return sendError(reply, 400, "bad_request", "unknown model");
    if (entry.type !== "image") return sendError(reply, 400, "bad_request", "model is not an image model");

    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (prompt.length === 0) return sendError(reply, 400, "bad_request", "prompt required");
    if (prompt.length > MAX_PROMPT_CHARS) {
      return sendError(reply, 400, "bad_request", `prompt exceeds ${MAX_PROMPT_CHARS} chars`);
    }

    const key = apiKey();
    if (!key) return sendError(reply, 503, "not_configured", "playground not configured");

    const balanceAfterSpend = await spendCredits(db, auth.wallet, IMAGE_COST);
    if (balanceAfterSpend === null) {
      return sendError(reply, 402, "insufficient_credits", `image generation costs ${IMAGE_COST} credits`);
    }

    const result = await orbioImage(key, model, prompt, logger);
    if (!result.ok) {
      await refundCredits(db, auth.wallet, IMAGE_COST);
      return sendError(reply, 502, result.code, result.message);
    }

    await db.query(
      `INSERT INTO playground_usage (wallet, kind, model, credits_spent) VALUES ($1, 'image', $2, $3)`,
      [auth.wallet, model, IMAGE_COST],
    );

    logger.info({ wallet: auth.wallet, model, balance: balanceAfterSpend }, "playground image complete");
    return reply.send({ images: result.urls, balance: balanceAfterSpend });
  });

  // --- GET /api/v1/playground/admin/models ------------------------------------
  v1.get("/playground/admin/models", async (req, reply) => {
    if (!checkAdmin(req, reply)) return;
    const key = apiKey();
    if (!key) return sendError(reply, 503, "not_configured", "playground not configured");
    const cache = await fetchOrbioModels(key, logger);
    if (!cache) return sendError(reply, 502, "upstream_error", "could not fetch model list from provider");
    return reply.send(cache.raw);
  });

  // --- POST /api/v1/playground/admin/probe ------------------------------------
  v1.post("/playground/admin/probe", async (req, reply) => {
    if (!checkAdmin(req, reply)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const modelId = typeof body.model_id === "string" ? body.model_id : "";
    if (!modelId) return sendError(reply, 400, "bad_request", "model_id required");
    const key = apiKey();
    if (!key) return sendError(reply, 503, "not_configured", "playground not configured");

    const cache = await fetchOrbioModels(key, logger);
    if (!cache) return sendError(reply, 502, "upstream_error", "could not fetch model list from provider");
    if (!cache.ids.has(modelId)) {
      return reply.send({ model_id: modelId, kind: inferKind(modelId), ok: false, ms: 0, error: "model_not_found" });
    }

    const kind = inferKind(modelId);
    if (kind === "audio" || kind === "video") {
      return reply.send({ model_id: modelId, kind, ok: false, ms: 0, error: "no_minimal_probe" });
    }

    const t0 = Date.now();
    try {
      let url: string;
      let probeBody: Record<string, unknown>;
      if (kind === "chat") {
        url = ORBIO_CHAT_URL;
        probeBody = { model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 5 };
      } else {
        url = ORBIO_IMAGES_URL;
        probeBody = { model: modelId, prompt: "a red dot" };
      }
      let upstream = await fetch(url, {
        method: "POST",
        headers: orbioHeaders(key),
        body: JSON.stringify(probeBody),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (kind === "image" && upstream.status === 404) {
        upstream = await fetch(ORBIO_IMAGES_FALLBACK_URL, {
          method: "POST",
          headers: orbioHeaders(key),
          body: JSON.stringify(probeBody),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
      }
      const ms = Date.now() - t0;
      if (!upstream.ok) {
        const t = await upstream.text().catch(() => "");
        return reply.send({ model_id: modelId, kind, ok: false, ms, error: `http_${upstream.status}: ${t.slice(0, 200)}` });
      }
      return reply.send({ model_id: modelId, kind, ok: true, ms });
    } catch (e) {
      const ms = Date.now() - t0;
      const msg = e instanceof Error ? e.message : String(e);
      return reply.send({ model_id: modelId, kind, ok: false, ms, error: msg.slice(0, 200) });
    }
  });
}

