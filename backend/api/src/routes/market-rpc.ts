import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../types.js";
import { sendError, iso } from "./util.js";
import { ethers } from "ethers";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * SPORE RPC merchant (metered JSON-RPC proxy).
 *
 * POST /api/v1/market/rpc/key — buy an API key (5 USDG, 30-day expiry).
 * POST /api/v1/market/rpc     — metered JSON-RPC proxy (X-API-Key auth, 100 req/min).
 *
 * Keys are stored as SHA256 digests only. The raw key is returned exactly once
 * at purchase time and is never logged.
 */

const MERCHANT = "0x4c7cfbd388249f3c3027c52635cf70bb78084ed5";
const KEY_PRICE = 5_000_000n; // 5 USDG (6 decimals)
const UPSTREAM = "https://rpc.mainnet.chain.robinhood.com"; // chain 4663
const RPC_PROXY_TIMEOUT_MS = 30_000;
const KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REQUESTS_PER_MINUTE = 100;
const RATE_LIMIT_WINDOW_MS = 60_000;

// Per-IP rate limit for the key-purchase endpoint (same pattern as market.ts).
const IP_WINDOW_MS = 60 * 60 * 1000;
const IP_MAX = 10;
const ipHits = new Map<string, number[]>();
function ipRateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (ipHits.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  if (arr.length >= IP_MAX) return true;
  arr.push(now);
  ipHits.set(ip, arr);
  return false;
}

// Per-key rolling-window rate limit: 100 requests per 60s.
const keyHits = new Map<string, number[]>();
function keyRateLimited(keyHashHex: string): boolean {
  const now = Date.now();
  const arr = (keyHits.get(keyHashHex) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (arr.length >= REQUESTS_PER_MINUTE) return true;
  arr.push(now);
  keyHits.set(keyHashHex, arr);
  return false;
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Verify paymentTx contains a USDG transfer of >= price to MERCHANT. Returns payer or null. */
async function verifyPayment(
  rpcUrl: string,
  asset: string,
  paymentTx: string,
  price: bigint,
): Promise<string | null> {
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
    if (value < price) continue;
    return ("0x" + log.topics[1]?.slice(-40)).toLowerCase();
  }
  return null;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function registerMarketRpc(v1: FastifyInstance, deps: AppDeps): void {
  const { db, config, logger } = deps;

  // Buy an API key: 5 USDG to the merchant.
  v1.post("/market/rpc/key", async (req, reply) => {
    if (ipRateLimited(req.ip)) return sendError(reply, 429, "rate_limited", "too many requests");
    const body = req.body as Record<string, unknown> | undefined;
    const paymentTx = typeof body?.paymentTx === "string" ? body.paymentTx : "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(paymentTx)) {
      return sendError(reply, 400, "bad_request", "paymentTx (0x + 64 hex chars) required");
    }

    const payer = await verifyPayment(config.rpcUrl, config.assetAddress, paymentTx, KEY_PRICE);
    if (!payer) {
      return sendError(reply, 402, "payment_not_found", "no confirmed 5 USDG payment to merchant in that tx");
    }

    // Idempotency: one key per payment tx — never re-issue (the key was shown once).
    const dup = await db.query(`SELECT id FROM rpc_keys WHERE payment_tx = $1`, [paymentTx.toLowerCase()]);
    if (dup.rows.length > 0) {
      return sendError(reply, 409, "already_used", "this payment tx already bought a key");
    }

    const apiKey = randomBytes(32).toString("hex"); // 64-char hex, raw key shown ONCE
    const keyHash = sha256Hex(apiKey);
    const expiresAt = new Date(Date.now() + KEY_TTL_MS);

    const r = await db.query(
      `INSERT INTO rpc_keys (key_hash, payer, payment_tx, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [keyHash, payer, paymentTx.toLowerCase(), expiresAt],
    );
    const id = r.rows[0].id;
    logger.info({ id, payer }, "rpc key purchased");
    return reply.send({
      id,
      apiKey,
      expiresAt: iso(expiresAt),
      requestsPerMinute: REQUESTS_PER_MINUTE,
    });
  });

  // Metered JSON-RPC proxy.
  v1.post("/market/rpc", async (req, reply) => {
    const hdr = req.headers["x-api-key"];
    const apiKey = Array.isArray(hdr) ? hdr[0] ?? "" : (hdr ?? "");
    if (!apiKey) return sendError(reply, 401, "missing_key", "X-API-Key header required");

    const keyHashBuf = createHash("sha256").update(apiKey, "utf8").digest();
    const keyHashHex = keyHashBuf.toString("hex");

    const row = await db.query(
      `SELECT id, key_hash, expires_at, request_count FROM rpc_keys WHERE key_hash = $1`,
      [keyHashHex],
    );
    if (row.rows.length === 0) return sendError(reply, 401, "invalid_key", "unknown API key");

    // Timing-safe comparison of the digests for good measure.
    const stored = row.rows[0].key_hash as string;
    let storedBuf: Buffer;
    try {
      storedBuf = Buffer.from(stored, "hex");
    } catch {
      return sendError(reply, 401, "invalid_key", "unknown API key");
    }
    if (storedBuf.length !== keyHashBuf.length || !timingSafeEqual(keyHashBuf, storedBuf)) {
      return sendError(reply, 401, "invalid_key", "unknown API key");
    }

    const keyId = row.rows[0].id as number;
    if (new Date(row.rows[0].expires_at).getTime() < Date.now()) {
      return sendError(reply, 401, "key_expired", "API key has expired");
    }

    if (keyRateLimited(keyHashHex)) return sendError(reply, 429, "rate_limited", "100 requests per minute exceeded");

    const jsonBody = req.body as unknown;
    if (typeof jsonBody !== "object" || jsonBody === null || typeof (jsonBody as Record<string, unknown>).method !== "string") {
      return sendError(reply, 400, "bad_request", "body must be a JSON-RPC object with a string method");
    }

    await db.query(`UPDATE rpc_keys SET request_count = request_count + 1 WHERE id = $1`, [keyId]);

    let upstream: Response;
    try {
      upstream = await fetch(UPSTREAM, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(jsonBody),
        signal: AbortSignal.timeout(RPC_PROXY_TIMEOUT_MS),
      });
    } catch (e) {
      logger.error({ err: e, keyId }, "rpc proxy upstream fetch failed");
      return sendError(reply, 502, "upstream_error", "upstream RPC unreachable");
    }

    let payload: unknown;
    try {
      payload = await upstream.json();
    } catch (e) {
      logger.error({ err: e, keyId, status: upstream.status }, "rpc proxy upstream returned non-JSON");
      return sendError(reply, 502, "upstream_error", "upstream RPC returned an invalid response");
    }

    return reply.status(upstream.status).send(payload);
  });
}
