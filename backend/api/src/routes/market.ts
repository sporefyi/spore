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
 *    Each tx hash is accepted once — no double-spend.
 * 3. Pins the file to Pinata directly (PINATA_JWT env) and returns the CID.
 *
 * GET /api/v1/market/storage/pin/:id — legacy job status lookup (queued pins).
 */

const MERCHANT = "0x4c7cfbd388249f3c3027c52635cf70bb78084ed5";
const PRICE = 1_000_000n; // 1 USDG (6 decimals)
const MAX_BYTES = 10 * 1024 * 1024;
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

/** Pin a buffer to Pinata, return the CID. */
async function pinToPinata(jwt: string, fileName: string, buf: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: "application/octet-stream" }), fileName);
  form.append("pinataMetadata", JSON.stringify({ name: `spore-storage-${fileName}` }));
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`pinata ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = (await res.json()) as { IpfsHash?: string };
  if (!j.IpfsHash) throw new Error("pinata: no IpfsHash in response");
  return j.IpfsHash;
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

    const jwt = process.env.PINATA_JWT ?? "";
    if (!jwt) return sendError(reply, 503, "not_configured", "storage merchant not configured");

    const payer = await verifyPayment(config.rpcUrl, config.assetAddress, paymentTx);
    if (!payer) {
      return sendError(reply, 402, "payment_not_found", "no confirmed 1 USDG payment to merchant in that tx");
    }

    // Idempotency: one pin per payment tx.
    const dup = await db.query(`SELECT id, cid FROM storage_pins WHERE payment_tx = $1`, [paymentTx.toLowerCase()]);
    if (dup.rows.length > 0 && dup.rows[0].cid) {
      const j = dup.rows[0];
      return reply.send({ id: j.id, status: "done", cid: j.cid, ipfsUrl: `https://gateway.pinata.cloud/ipfs/${j.cid}` });
    }

    let cid: string;
    try {
      cid = await pinToPinata(jwt, fileName, buf);
    } catch (e) {
      logger.error({ err: e }, "pinata pin failed");
      return sendError(reply, 502, "pin_failed", "could not pin file");
    }

    const r = await db.query(
      `INSERT INTO storage_pins (file_name, file_data, payment_tx, payer, status, cid)
       VALUES ($1, $2, $3, $4, 'done', $5)
       ON CONFLICT (payment_tx) DO UPDATE SET cid = EXCLUDED.cid, status = 'done'
       RETURNING id`,
      [fileName, buf, paymentTx.toLowerCase(), payer, cid],
    );
    logger.info({ id: r.rows[0].id, cid, payer }, "storage pin complete");
    return reply.send({
      id: r.rows[0].id,
      status: "done",
      cid,
      ipfsUrl: `https://gateway.pinata.cloud/ipfs/${cid}`,
      merchant: MERCHANT,
    });
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
}
