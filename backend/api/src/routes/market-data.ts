import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../types.js";
import { sendError } from "./util.js";
import { ethers } from "ethers";

/**
 * POST /api/v1/market/data/query — SPORE Data merchant (second live integration).
 *
 * Agents pay 0.1 USDG to the merchant and get real on-chain data back:
 *   type "balance"  -> { eth, usdg } for an address
 *   type "tx"       -> receipt + transaction detail for a tx hash
 *   type "block"    -> { number, timestamp (ISO), txCount } for a block number / "latest"
 *
 * 1. Validates inputs + rate-limits per IP.
 * 2. Verifies paymentTx on-chain: a USDG Transfer of >= 0.1 USDG to MERCHANT.
 *    Each tx hash is accepted once — idempotent via data_queries.payment_tx.
 * 3. Queries the chain with ethers v6 against config.rpcUrl. RPC failures
 *    surface as 502 upstream_error — data is never invented.
 */

const MERCHANT = "0x4c7cfbd388249f3c3027c52635cf70bb78084ed5";
const PRICE = 100_000n; // 0.1 USDG (6 decimals)
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 10;

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC20_BALANCE_ABI = ["function balanceOf(address owner) view returns (uint256)"];

const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (arr.length >= RATE_LIMIT_MAX) return true;
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

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
    if (!log.topics[1] || !log.topics[2]) continue;
    const to = ("0x" + log.topics[2].slice(-40)).toLowerCase();
    if (to !== merchantLc) continue;
    const value = BigInt(log.data);
    if (value < price) continue;
    return ("0x" + log.topics[1].slice(-40)).toLowerCase();
  }
  return null;
}

const isHexAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isHexTx = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

export function registerMarketData(v1: FastifyInstance, deps: AppDeps): void {
  const { db, config, logger } = deps;

  v1.post("/market/data/query", async (req, reply) => {
    const ip = req.ip;
    if (rateLimited(ip)) return sendError(reply, 429, "rate_limited", "too many requests");

    const body = req.body as Record<string, unknown> | undefined;
    const type = body?.type;
    if (type !== "balance" && type !== "tx" && type !== "block") {
      return sendError(reply, 400, "bad_request", 'type must be one of "balance", "tx", "block"');
    }
    const paymentTx = body?.paymentTx;
    if (!isHexTx(paymentTx)) {
      return sendError(reply, 400, "bad_request", "paymentTx must be a 0x-prefixed 64-hex tx hash");
    }

    // Per-type parameter validation.
    let queryParams: Record<string, unknown>;
    if (type === "balance") {
      if (!isHexAddress(body?.address)) {
        return sendError(reply, 400, "bad_request", "address must be a 0x-prefixed 40-hex address");
      }
      queryParams = { type, address: body.address };
    } else if (type === "tx") {
      if (!isHexTx(body?.txHash)) {
        return sendError(reply, 400, "bad_request", "txHash must be a 0x-prefixed 64-hex tx hash");
      }
      queryParams = { type, txHash: body.txHash };
    } else {
      const bn = body?.blockNumber;
      const ok = bn === "latest" || (typeof bn === "number" && Number.isInteger(bn) && bn >= 0);
      if (!ok) {
        return sendError(reply, 400, "bad_request", 'blockNumber must be a non-negative integer or "latest"');
      }
      queryParams = { type, blockNumber: bn };
    }

    const payer = await verifyPayment(config.rpcUrl, config.assetAddress, paymentTx, PRICE);
    if (!payer) {
      return sendError(reply, 402, "payment_not_found", "no confirmed 0.1 USDG payment to merchant in that tx");
    }

    // Idempotency: one response per payment tx.
    const cached = await db.query(`SELECT id, query_type, response FROM data_queries WHERE payment_tx = $1`, [
      paymentTx.toLowerCase(),
    ]);
    if (cached.rows.length > 0) {
      const j = cached.rows[0];
      return reply.send({ id: j.id, type: j.query_type, result: j.response, payer, merchant: MERCHANT });
    }

    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    let result: Record<string, unknown>;
    try {
      if (type === "balance") {
        const address = queryParams.address as string;
        const [ethWei, usdgRaw] = await Promise.all([
          provider.getBalance(address),
          new ethers.Contract(config.assetAddress, ERC20_BALANCE_ABI, provider).balanceOf(address),
        ]);
        result = {
          eth: ethers.formatUnits(ethWei, 18),
          usdg: ethers.formatUnits(usdgRaw as bigint, 6),
        };
      } else if (type === "tx") {
        const txHash = queryParams.txHash as string;
        const [receipt, tx] = await Promise.all([
          provider.getTransactionReceipt(txHash),
          provider.getTransaction(txHash),
        ]);
        if (!receipt || !tx) {
          result = { status: "pending", blockNumber: null, from: null, to: null, value: null };
        } else {
          result = {
            status: receipt.status === 1 ? "success" : "failed",
            blockNumber: Number(receipt.blockNumber),
            from: tx.from,
            to: tx.to,
            value: tx.value.toString(),
          };
        }
      } else {
        const bn = queryParams.blockNumber as number | "latest";
        const block = await provider.getBlock(bn);
        if (!block) throw new Error("block not found");
        result = {
          number: Number(block.number),
          timestamp: new Date(block.timestamp * 1000).toISOString(),
          txCount: block.transactions.length,
        };
      }
    } catch (e) {
      logger.error({ err: e, type }, "market data rpc query failed");
      const msg = e instanceof Error ? e.message.slice(0, 300) : "rpc request failed";
      return sendError(reply, 502, "upstream_error", msg);
    }

    const r = await db.query(
      `INSERT INTO data_queries (query_type, query_params, payment_tx, payer, response)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (payment_tx) DO UPDATE SET response = EXCLUDED.response
       RETURNING id`,
      [
        type,
        JSON.stringify(queryParams),
        paymentTx.toLowerCase(),
        payer,
        JSON.stringify(result),
      ],
    );
    logger.info({ id: r.rows[0].id, type, payer }, "market data query complete");
    return reply.send({ id: r.rows[0].id, type, result, payer, merchant: MERCHANT });
  });
}
