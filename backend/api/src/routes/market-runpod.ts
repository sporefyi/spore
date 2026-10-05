import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../types.js";
import { sendError } from "./util.js";
import { ethers } from "ethers";

/**
 * SPORE GPU rentals — real GPU rental via RunPod, paid in USDG.
 *
 * GET  /api/v1/market/gpu/catalog — GPU types with live $/hr pricing (cached).
 * POST /api/v1/market/gpu/rent     — rent a GPU for N hours. Body: { gpuTypeId, hours, paymentTx }
 * GET  /api/v1/market/gpu/rentals/:id — rental status + live pod status/ports.
 *
 * Never exposes the RunPod account balance or the API key.
 */

const MERCHANT = "0x4c7cfbd388249f3c3027c52635cf70bb78084ed5";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const RUNPOD_GRAPHQL = "https://api.runpod.io/graphql";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const POD_IMAGE = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04";
const POD_DISK_GB = 20;
const POD_PORTS = "8888/http,22/tcp";
const MAX_HOURS = 12;

const CATALOG_TTL_MS = 10 * 60 * 1000;

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 20;

const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (arr.length >= RATE_LIMIT_MAX) return true;
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

interface GpuType {
  id: string;
  displayName: string;
  memoryInGb: number | null;
  secureCloud: boolean;
  communityCloud: boolean;
  pricePerHr: number | null;
}

let catalogCache: { at: number; gpus: GpuType[] } | null = null;

async function runpodGraphql<T>(apiKey: string, query: string, variables?: unknown): Promise<T> {
  const res = await fetch(RUNPOD_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": UA,
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`runpod http ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`runpod: ${json.errors[0].message.slice(0, 160)}`);
  return json.data as T;
}

async function fetchCatalog(apiKey: string): Promise<GpuType[]> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.gpus;
  const data = await runpodGraphql<{
    gpuTypes: {
      id: string;
      displayName: string;
      memoryInGb: number | null;
      secureCloud: boolean;
      communityCloud: boolean;
      lowestPrice: { minimumBidPrice: number | null; uninterruptablePrice: number | null } | null;
    }[];
  }>(
    apiKey,
    `query { gpuTypes { id displayName memoryInGb secureCloud communityCloud
      lowestPrice { minimumBidPrice uninterruptablePrice } } }`,
  );
  const gpus: GpuType[] = (data.gpuTypes ?? [])
    .map((g) => ({
      id: g.id,
      displayName: g.displayName,
      memoryInGb: g.memoryInGb,
      secureCloud: g.secureCloud,
      communityCloud: g.communityCloud,
      pricePerHr: g.lowestPrice?.uninterruptablePrice ?? g.lowestPrice?.minimumBidPrice ?? null,
    }))
    .filter((g) => g.pricePerHr != null && g.pricePerHr > 0 && (g.secureCloud || g.communityCloud))
    .sort((a, b) => (a.pricePerHr as number) - (b.pricePerHr as number));
  catalogCache = { at: now, gpus };
  return gpus;
}

/** Verify paymentTx contains a USDG transfer of >= amount to MERCHANT. Returns payer or null. */
async function verifyPayment(
  rpcUrl: string,
  asset: string,
  paymentTx: string,
  amount: bigint,
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
    if (BigInt(log.data) < amount) continue;
    return ("0x" + log.topics[1]?.slice(-40)).toLowerCase();
  }
  return null;
}

function budgetUsd(): number {
  const raw = process.env.RUNPOD_BUDGET_USD ?? "12";
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 12;
}

async function committedUsd(db: AppDeps["db"]): Promise<number> {
  const r = await db.query(`SELECT COALESCE(SUM(price_usdg), 0) AS s FROM gpu_rentals`);
  return Number(r.rows[0]?.s ?? 0);
}

export function registerMarketRunpod(v1: FastifyInstance, deps: AppDeps): void {
  const { db, config, logger } = deps;
  const apiKey = () => process.env.RUNPOD_API_KEY ?? "";

  // In-process sweeper: terminate expired rentals so billing stops.
  // Runs inside the API process — no extra credentials or cron needed.
  const SWEEP_MS = 5 * 60 * 1000;
  const sweep = async () => {
    const key = apiKey();
    if (!key) return;
    try {
      const r = await db.query(
        `SELECT id, pod_id FROM gpu_rentals
         WHERE terminated_at IS NULL AND pod_id IS NOT NULL AND expires_at < NOW()
         LIMIT 25`,
      );
      for (const row of r.rows) {
        try {
          await runpodGraphql(key, `mutation Term($podId: String!) { podTerminate(input: { podId: $podId }) }`, {
            podId: row.pod_id,
          });
        } catch (e) {
          logger.warn({ err: e, podId: row.pod_id }, "runpod terminate failed (marking anyway)");
        }
        await db.query(`UPDATE gpu_rentals SET terminated_at = NOW(), pod_status = 'TERMINATED' WHERE id = $1`, [
          row.id,
        ]);
        logger.info({ rentalId: row.id, podId: row.pod_id }, "gpu rental terminated");
      }
    } catch (e) {
      logger.error({ err: e }, "gpu rental sweep failed");
    }
  };
  void sweep();
  setInterval(() => void sweep(), SWEEP_MS).unref?.();

  v1.get("/market/gpu/catalog", async (req, reply) => {
    const key = apiKey();
    if (!key) return sendError(reply, 503, "not_configured", "gpu rentals not configured");
    try {
      const gpus = await fetchCatalog(key);
      const spent = await committedUsd(db);
      return reply.send({
        gpus: gpus.map((g) => ({
          id: g.id,
          display: g.displayName,
          vramGb: g.memoryInGb,
          community: g.communityCloud,
          pricePerHr: g.pricePerHr,
        })),
        budgetRemainingUsd: Math.max(0, Math.round((budgetUsd() - spent) * 100) / 100),
        maxHours: MAX_HOURS,
        updatedAt: new Date(catalogCache?.at ?? Date.now()).toISOString(),
      });
    } catch (e) {
      logger.error({ err: e }, "runpod catalog failed");
      return sendError(reply, 502, "upstream_error", "could not load GPU catalog");
    }
  });

  v1.post("/market/gpu/rent", async (req, reply) => {
    if (rateLimited(req.ip)) return sendError(reply, 429, "rate_limited", "too many requests");
    const key = apiKey();
    if (!key) return sendError(reply, 503, "not_configured", "gpu rentals not configured");

    const body = req.body as Record<string, unknown> | undefined;
    const gpuTypeId = typeof body?.gpuTypeId === "string" ? body.gpuTypeId : "";
    const hours = typeof body?.hours === "number" ? Math.floor(body.hours) : 0;
    const paymentTx = typeof body?.paymentTx === "string" ? body.paymentTx : "";
    if (!gpuTypeId) return sendError(reply, 400, "bad_request", "gpuTypeId required");
    if (!(hours >= 1 && hours <= MAX_HOURS))
      return sendError(reply, 400, "bad_request", `hours must be 1-${MAX_HOURS}`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(paymentTx))
      return sendError(reply, 400, "bad_request", "paymentTx (0x + 64 hex chars) required");

    let gpus: GpuType[];
    try {
      gpus = await fetchCatalog(key);
    } catch (e) {
      logger.error({ err: e }, "runpod catalog failed");
      return sendError(reply, 502, "upstream_error", "could not load GPU catalog");
    }
    const gpu = gpus.find((g) => g.id === gpuTypeId);
    if (!gpu) return sendError(reply, 400, "bad_request", "unknown gpuTypeId");

    const priceUsd = Math.ceil((gpu.pricePerHr as number) * hours * 100) / 100;
    const priceUnits = BigInt(Math.ceil(priceUsd * 1_000_000)); // USDG 6 decimals

    const payer = await verifyPayment(config.rpcUrl, config.assetAddress, paymentTx, priceUnits);
    if (!payer) {
      return sendError(
        reply,
        402,
        "payment_not_found",
        `no confirmed ${priceUsd.toFixed(2)} USDG payment to merchant in that tx`,
      );
    }

    const dup = await db.query(`SELECT id FROM gpu_rentals WHERE payment_tx = $1`, [
      paymentTx.toLowerCase(),
    ]);
    if (dup.rows.length > 0) {
      return sendError(reply, 409, "already_used", "this payment was already used");
    }

    const spent = await committedUsd(db);
    if (spent + priceUsd > budgetUsd() + 1e-9) {
      return sendError(reply, 503, "budget_exhausted", "rental budget exhausted — try a cheaper GPU");
    }

    // Launch the pod on RunPod.
    let pod: { id: string; name: string };
    try {
      const data = await runpodGraphql<{
        podFindAndDeployOnDemand: { id: string; name: string } | null;
      }>(
        key,
        `mutation CreatePod($input: PodFindAndDeployOnDemandInput!) {
           podFindAndDeployOnDemand(input: $input) { id name }
         }`,
        {
          input: {
            name: `spore-rent-${Date.now().toString(36)}`,
            imageName: POD_IMAGE,
            gpuTypeId: gpu.id,
            gpuCount: 1,
            cloudType: gpu.communityCloud ? "COMMUNITY" : "SECURE",
            containerDiskInGb: POD_DISK_GB,
            ports: POD_PORTS,
          },
        },
      );
      if (!data.podFindAndDeployOnDemand?.id) throw new Error("no pod id returned");
      pod = { id: data.podFindAndDeployOnDemand.id, name: data.podFindAndDeployOnDemand.name };
    } catch (e) {
      logger.error({ err: e }, "runpod pod creation failed");
      return sendError(reply, 502, "provision_failed", "could not provision GPU — no charge consumed");
    }

    const expiresAt = new Date(Date.now() + hours * 3600 * 1000);
    const r = await db.query(
      `INSERT INTO gpu_rentals
         (gpu_type_id, gpu_display, hours, hourly_rate, price_usdg, payment_tx, payer, pod_id, pod_status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PROVISIONING',$9)
       ON CONFLICT (payment_tx) DO NOTHING
       RETURNING id`,
      [
        gpu.id,
        gpu.displayName,
        hours,
        gpu.pricePerHr,
        priceUsd.toFixed(2),
        paymentTx.toLowerCase(),
        payer,
        pod.id,
        expiresAt.toISOString(),
      ],
    );
    if (r.rows.length === 0) {
      return sendError(reply, 409, "already_used", "this payment was already used");
    }
    const id = r.rows[0].id;
    logger.info({ id, podId: pod.id, gpu: gpu.displayName, hours, priceUsd }, "gpu rental created");
    return reply.send({
      id,
      gpu: gpu.displayName,
      hours,
      priceUsdg: priceUsd.toFixed(2),
      podId: pod.id,
      podName: pod.name,
      status: "PROVISIONING",
      expiresAt: expiresAt.toISOString(),
      note: "Pod is provisioning — poll GET /api/v1/market/gpu/rentals/" + id + " for SSH/Jupyter access.",
    });
  });

  v1.get("/market/gpu/rentals/:id", async (req, reply) => {
    const key = apiKey();
    if (!key) return sendError(reply, 503, "not_configured", "gpu rentals not configured");
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isInteger(id) || id <= 0) return sendError(reply, 400, "bad_request", "bad id");
    const r = await db.query(`SELECT * FROM gpu_rentals WHERE id = $1`, [id]);
    if (r.rows.length === 0) return sendError(reply, 404, "not_found", "rental not found");
    const row = r.rows[0];

    let podStatus: string | null = null;
    let access: { ssh: string | null; jupyter: string | null } | null = null;
    if (row.pod_id && !row.terminated_at) {
      try {
        const data = await runpodGraphql<{
          pod: {
            desiredStatus: string;
            runtime: {
              ports: { ip: string; isIpPublic: boolean; privatePort: number; publicPort: number; type: string }[] | null;
            } | null;
          } | null;
        }>(
          key,
          `query PodStatus($podId: String!) {
             pod(input: { podId: $podId }) {
               desiredStatus
               runtime { ports { ip isIpPublic privatePort publicPort type } }
             }
           }`,
          { podId: row.pod_id },
        );
        const pod = data.pod;
        podStatus = pod?.desiredStatus ?? null;
        if (podStatus && podStatus !== row.pod_status) {
          await db.query(`UPDATE gpu_rentals SET pod_status = $1 WHERE id = $2`, [podStatus, id]);
        }
        const ports = pod?.runtime?.ports ?? [];
        const ssh = ports.find((p) => p.privatePort === 22 && p.isIpPublic);
        const jup = ports.find((p) => p.privatePort === 8888);
        access = {
          ssh: ssh ? `ssh root@${ssh.ip} -p ${ssh.publicPort}` : null,
          jupyter: jup ? `http://${jup.ip}:${jup.publicPort}` : null,
        };
      } catch (e) {
        logger.warn({ err: e, podId: row.pod_id }, "runpod pod status failed");
      }
    }

    return reply.send({
      id: row.id,
      gpu: row.gpu_display,
      hours: Number(row.hours),
      priceUsdg: String(row.price_usdg),
      podId: row.pod_id,
      status: podStatus ?? row.pod_status,
      access,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      terminatedAt: row.terminated_at,
    });
  });
}
