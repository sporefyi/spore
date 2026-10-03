import type { FastifyReply } from "fastify";

export function parsePagination(q: Record<string, unknown>): { limit: number; offset: number } {
  const toInt = (v: unknown): number | null => {
    if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    return null;
  };
  const rawLimit = toInt(q["limit"]);
  const rawOffset = toInt(q["offset"]);
  const limit = rawLimit === null || rawLimit < 1 ? 25 : Math.min(100, rawLimit);
  const offset = rawOffset === null ? 0 : Math.max(0, rawOffset);
  return { limit, offset };
}

function normalizeDecimal(input: string): string | null {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(input.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? "-" : "";
  const intPart = m[2] ?? "";
  const fracPart = m[3] ?? "";
  if (intPart === "" && fracPart === "") return null;
  const exp = m[4] !== undefined ? parseInt(m[4], 10) : 0;
  if (!Number.isFinite(exp) || Math.abs(exp) > 1000) return null;
  let digits = intPart + fracPart;
  let pointPos = intPart.length + exp;
  if (pointPos <= 0) {
    digits = "0".repeat(-pointPos) + digits;
    pointPos = 0;
  } else if (pointPos > digits.length) {
    digits = digits + "0".repeat(pointPos - digits.length);
  }
  const i = digits.slice(0, pointPos).replace(/^0+/, "") || "0";
  const f = digits.slice(pointPos).replace(/0+$/, "");
  const res = f ? `${i}.${f}` : i;
  return res === "0" ? "0" : sign + res;
}

export function dec(v: unknown): string {
  if (v === null || v === undefined) return "0";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "0";
    return normalizeDecimal(String(v)) ?? "0";
  }
  if (typeof v === "string") return normalizeDecimal(v) ?? "0";
  return "0";
}

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "string") {
    if (v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function int(v: unknown): number {
  const n = num(v);
  if (n === null) return 0;
  return Math.trunc(n) + 0;
}

export function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  let d: Date;
  if (v instanceof Date) {
    d = v;
  } else if (typeof v === "string" || typeof v === "number") {
    if (typeof v === "string" && v.trim() === "") return null;
    d = new Date(v);
  } else {
    return null;
  }
  const t = d.getTime();
  return Number.isFinite(t) ? d.toISOString() : null;
}

export function ageDays(v: unknown): number | null {
  const s = iso(v);
  if (s === null) return null;
  const diff = Date.now() - new Date(s).getTime();
  return Math.max(0, Math.floor(diff / 86_400_000));
}

export function utilization(drawn: unknown, limit: unknown): number | null {
  const l = num(limit);
  if (l === null || l <= 0) return null;
  const d = num(drawn) ?? 0;
  const r = d / l;
  return Number.isFinite(r) ? r : null;
}

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.status(status).send({ error: { code, message } });
}
