import { pino, type Logger } from "pino";

export type { Logger };

const REDACTED = "[Redacted]";
const MAX_DEPTH = 8;

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower === "privatekey" || lower.includes("private_key");
}

function scrub(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, depth + 1, seen));
  }
  if (value instanceof Date || value instanceof Error) return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : scrub(inner, depth + 1, seen);
  }
  return out;
}

export function createLogger(name: string): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "privateKey",
        "private_key",
        "*.privateKey",
        "*.private_key",
        "*.*.privateKey",
        "*.*.private_key",
      ],
      censor: REDACTED,
    },
    formatters: {
      log(object: Record<string, unknown>): Record<string, unknown> {
        return scrub(object, 0, new WeakSet<object>()) as Record<string, unknown>;
      },
    },
  });
}
