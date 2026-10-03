import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../types.js";
import { sendError } from "./util.js";
import { ethers } from "ethers";

/**
 * POST /api/v1/market/search — SPORE Web Search merchant.
 *
 * Agents pay 0.2 USDG to the merchant and get the top 10 REAL DuckDuckGo
 * web search results for their query.
 * Body: { query, paymentTx }
 *
 * 1. Validates inputs + rate-limits per IP.
 * 2. Verifies paymentTx on-chain: a USDG Transfer of >= 0.2 USDG to MERCHANT.
 *    Each tx hash is accepted once — no double-spend (idempotency via
 *    payment_tx; cached results are returned for repeat calls).
 * 3. Fetches live results from DuckDuckGo's HTML endpoint and parses them
 *    with regex (dependency-free). Never fabricates results: if DuckDuckGo
 *    is unreachable or yields zero parseable results, returns 502.
 */

const MERCHANT = "0x4c7cfbd388249f3c3027c52635cf70bb78084ed5";
const PRICE = 200_000n; // 0.2 USDG (6 decimals)
const MAX_QUERY_LEN = 300;
const MAX_RESULTS = 10;
const DDG_TIMEOUT_MS = 20_000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 10;

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DDG_URL = "https://html.duckduckgo.com/html/";
const DDG_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

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
    const to = ("0x" + log.topics[2]?.slice(-40)).toLowerCase();
    if (to !== merchantLc) continue;
    const value = BigInt(log.data);
    if (value < price) continue;
    return ("0x" + log.topics[1]?.slice(-40)).toLowerCase();
  }
  return null;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const cp = Number(n);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n: string) => {
      const cp = parseInt(n, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * DuckDuckGo sometimes wraps outbound URLs as
 * `//duckduckgo.com/l/?uddg=<urlencoded>` — unwrap to the real URL.
 */
function unwrapUrl(href: string): string {
  let url = href.trim();
  if (url.startsWith("//")) url = "https:" + url;
  const uddg = /[?&]uddg=([^&]+)/.exec(url);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
      return uddg[1];
    }
  }
  return url;
}

/**
 * Parse DuckDuckGo HTML results with regex, in document order.
 * Result links: <a ... class="result__a" href="...">Title</a>
 * Snippets:     <a ... class="result__snippet" ...>Snippet</a>
 * Each snippet is paired with the most recent result link that still lacks one.
 */
function parseDuckDuckGo(html: string): SearchResult[] {
  const results: { title: string; url: string; snippet: string }[] = [];
  const re =
    /<a\s+[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/a>|<a\s+[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  let lastIdx = -1;
  while ((m = re.exec(html)) !== null) {
    const full = m[0];
    const cls = m[1] ?? "";
    const inner = m[2] ?? m[3] ?? "";
    if (/\bresult__a\b/.test(cls) && /\bresult__snippet\b/.test(cls)) continue;
    if (/\bresult__a\b/.test(cls)) {
      const hrefMatch = /href="([^"]+)"/i.exec(full);
      if (!hrefMatch) continue;
      const url = unwrapUrl(hrefMatch[1]);
      if (!/^https?:\/\//i.test(url)) continue;
      const title = decodeEntities(stripTags(inner));
      if (!title) continue;
      results.push({ title, url, snippet: "" });
      lastIdx = results.length - 1;
    } else if (/\bresult__snippet\b/.test(cls)) {
      if (lastIdx < 0) continue;
      const snippet = decodeEntities(stripTags(inner));
      if (snippet) results[lastIdx].snippet = snippet;
    }
  }
  return results.slice(0, MAX_RESULTS);
}

/** Fetch live results from DuckDuckGo. Throws if blocked/unreachable/empty. */
async function fetchSearchResults(query: string): Promise<SearchResult[]> {
  let res: Response;
  try {
    // NOTE: the html endpoint's documented form submission is POST, and from some
    // networks GET is answered with an "anomaly" interstitial (HTTP 202, no
    // results) while POST returns the real results page. Same endpoint either way.
    const body = new URLSearchParams({ q: query });
    res = await fetch(DDG_URL, {
      method: "POST",
      headers: {
        "User-Agent": DDG_UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      body,
      signal: AbortSignal.timeout(DDG_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`duckduckgo request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Error(`duckduckgo responded ${res.status}`);
  const html = await res.text();
  if (/anomaly-modal|captcha|challenges\.cloudflare/i.test(html)) {
    throw new Error("duckduckgo presented a challenge page");
  }
  const results = parseDuckDuckGo(html);
  if (results.length === 0) throw new Error("no parseable results in duckduckgo response");
  return results;
}

export function registerMarketSearch(v1: FastifyInstance, deps: AppDeps): void {
  const { db, config, logger } = deps;

  v1.post("/market/search", async (req, reply) => {
    const ip = req.ip;
    if (rateLimited(ip)) return sendError(reply, 429, "rate_limited", "too many requests");
    const body = req.body as Record<string, unknown> | undefined;
    const query = typeof body?.query === "string" ? body.query.trim() : "";
    const paymentTx = typeof body?.paymentTx === "string" ? body.paymentTx : "";
    if (!query || query.length > MAX_QUERY_LEN || !/^0x[0-9a-fA-F]{64}$/.test(paymentTx)) {
      return sendError(
        reply,
        400,
        "bad_request",
        "query (1-300 chars) and paymentTx (0x + 64 hex chars) required",
      );
    }

    const payer = await verifyPayment(config.rpcUrl, config.assetAddress, paymentTx, PRICE);
    if (!payer) {
      return sendError(reply, 402, "payment_not_found", "no confirmed 0.2 USDG payment to merchant in that tx");
    }

    // Idempotency: one search per payment tx — return cached results.
    const dup = await db.query(`SELECT id, query, results FROM search_queries WHERE payment_tx = $1`, [
      paymentTx.toLowerCase(),
    ]);
    if (dup.rows.length > 0) {
      const j = dup.rows[0];
      const cached =
        typeof j.results === "string" ? (JSON.parse(j.results) as SearchResult[]) : j.results;
      return reply.send({
        id: j.id,
        query: j.query,
        results: cached,
        payer,
        merchant: MERCHANT,
      });
    }

    let results: SearchResult[];
    try {
      results = await fetchSearchResults(query);
    } catch (e) {
      logger.error({ err: e }, "duckduckgo search failed");
      return sendError(reply, 502, "search_unavailable", "web search is currently unavailable; results were not fabricated");
    }

    const r = await db.query(
      `INSERT INTO search_queries (query, payment_tx, payer, results)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [query, paymentTx.toLowerCase(), payer, JSON.stringify(results)],
    );
    logger.info({ id: r.rows[0].id, payer, query: query.slice(0, 60) }, "web search complete");
    return reply.send({
      id: r.rows[0].id,
      query,
      results,
      payer,
      merchant: MERCHANT,
    });
  });
}
