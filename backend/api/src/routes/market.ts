import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../types.js";
import { sendError } from "./util.js";
import { ethers } from "ethers";

/**
 * POST /api/v1/market/storage/pin — SPORE Storage merchant (first live integration).
 *
 * Agents pay 1 USDG to the merchant and get a file pinned on IPFS via Pinata.
 * Body: { fileName, fileData (base64, max 10MB), paymentTx }
 *
 * 1. Validates inputs + rate-limits per IP.
 * 2. Verifies paymentTx on-chain: a USDG Transfer of >= 1 USDG to MERCHANT.
 *    Each tx hash is accepted once (UNIQUE constraint) — no double-spend.
 * 3. Queues the pin job in storage_pins; a VM worker polls pending jobs,
 *    pins via Pinata (credential lives on the VM), and marks them done.
 *
 * GET /api/v1/market/storage/pin/:id — job status + CID.
 * GET /api/v1/market/storage/pending — worker: list pending jobs (needs WORKER_SECRET).
 * POST /api/v1/market/storage/complete — worker: { id, cid } or { id, error }.
 */

const MERCHANT = "0x4c7cfbd388249f3c3027c52635cf70bb78084ed5";
const PRICE = 1_000_000n; // 1 USDG (6 decimals)
const MAX_BYTES = 10 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

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

function workerAuthed(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const secret = process.env.WORKER_SECRET ?? "";
  if (!secret) return false;
  const got = req.headers["x-worker-secret"];
  return got === secret;
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
    // topics[1] = from, topics[2] = to (both 32-byte padded)
    const to = ("0x" + log.topics[2]?.slice(-40)).toLowerCase();
    if (to !== merchantLc) continue;
    const value = BigInt(log.data);
    if (value < PRICE) continue;
    return ("0x" + log.topics[1]?.slice(-40)).toLowerCase();
  }
  return null;
}

export function registerMarket(v1: FastifyInstance, deps: AppDeps): void {
  const { db, config, logger } = deps;

  v1.post("/market/storage/pin", async (req, reply) => {
    const ip = req.ip;
    if (rateLimited(ip)) return sendError(reply, 429, "rate_limited", "too many requests");
    const body = req.body as Record<string, unknown> | undefined;
    const fileName = typeof body?.fileName === "string" ? body.fileName.slice(0, 200) : "";
    const fileData = typeof body?.fileData === "string" ? body.fileData : "";
    const paymentTx = typeof body?.paymentTx === "string" ? body.paymentTx : "";
    if (!fileName || !fileData || !/^0x[0-9a-fA-F]{64}$/.test(paymentTx)) {
      return sendError(reply, 400, "bad_request", "fileName, fileData (base64) and paymentTx required");
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(fileData, "base64");
    } catch {
      return sendError(reply, 400, "bad_request", "fileData is not valid base64");
    }
    if (buf.length === 0 || buf.length > MAX_BYTES) {
      return sendError(reply, 400, "bad_request", "file must be 1 byte - 10 MB");
    }

    const payer = await verifyPayment(config.rpcUrl, config.assetAddress, paymentTx);
    if (!payer) {
      return sendError(reply, 402, "payment_not_found", "no confirmed 1 USDG payment to merchant in that tx");
    }

    try {
      const r = await db.query(
        `INSERT INTO storage_pins (file_name, file_data, payment_tx, payer, status)
         VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
        [fileName, buf, paymentTx.toLowerCase(), payer],
      );
      const id = r.rows[0].id;
      logger.info({ id, payer }, "storage pin queued");
      return reply.send({ id, status: "pending", price: "1000000", merchant: MERCHANT });
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "23505") {
        return sendError(reply, 409, "tx_reused", "this payment tx was already used");
      }
      throw e;
    }
  });

  v1.get("/market/storage/pin/:id", async (req, reply) => {
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isInteger(id) || id <= 0) return sendError(reply, 400, "bad_request", "invalid id");
    const r = await db.query(
      `SELECT id, file_name, payer, status, cid, created_at FROM storage_pins WHERE id = $1`,
      [id],
    );
    if (r.rows.length === 0) return sendError(reply, 404, "not_found", "no such pin job");
    const j = r.rows[0];
    return reply.send({
      id: j.id,
      fileName: j.file_name,
      payer: j.payer,
      status: j.status,
      cid: j.cid,
      ipfsUrl: j.cid ? `https://gateway.pinata.cloud/ipfs/${j.cid}` : null,
      createdAt: j.created_at,
    });
  });

  // Worker endpoints (shared secret).
  v1.get("/market/storage/pending", async (req, reply) => {
    if (!workerAuthed(req)) return sendError(reply, 401, "unauthorized", "bad worker secret");
    const r = await db.query(
      `SELECT id, file_name, encode(file_data, 'base64') AS file_data, payment_tx, payer
       FROM storage_pins WHERE status = 'pending' ORDER BY id LIMIT 10`,
    );
    return reply.send({ items: r.rows });
  });

  v1.post("/market/storage/complete", async (req, reply) => {
    if (!workerAuthed(req)) return sendError(reply, 401, "unauthorized", "bad worker secret");
    const body = req.body as Record<string, unknown> | undefined;
    const id = Number(body?.id);
    const cid = typeof body?.cid === "string" ? body.cid : "";
    const error = typeof body?.error === "string" ? body.error.slice(0, 500) : "";
    if (!Number.isInteger(id) || id <= 0 || (!cid && !error)) {
      return sendError(reply, 400, "bad_request", "id and cid or error required");
    }
    if (cid) {
      await db.query(
        `UPDATE storage_pins SET status = 'done', cid = $2, updated_at = NOW() WHERE id = $1`,
        [id, cid],
      );
    } else {
      await db.query(
        `UPDATE storage_pins SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`,
        [id, error],
      );
    }
    return reply.send({ ok: true });
  });
}
