import pino from "pino";
import type { Logger } from "pino";
import { Transform } from "node:stream";
import type { TransformCallback } from "node:stream";

export type { Logger } from "pino";

const VALID_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

const LEVEL_LABELS: Readonly<Record<number, string>> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};

const SKIP_KEYS = new Set(["pid", "hostname", "time", "level", "service", "msg"]);

function resolveLevel(raw: string | undefined): string {
  const candidate = (raw ?? "info").trim().toLowerCase();
  return VALID_LEVELS.has(candidate) ? candidate : "info";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return /[\s="]/.test(value) || value.length === 0 ? JSON.stringify(value) : value;
  }
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function formatTime(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function formatLevel(value: unknown): string {
  if (typeof value === "number") {
    return (LEVEL_LABELS[value] ?? String(value)).padEnd(5);
  }
  if (typeof value === "string") return value.toUpperCase().padEnd(5);
  return "".padEnd(5);
}

function prettyLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isRecord(parsed)) return line;

  const service = typeof parsed.service === "string" ? parsed.service : "";
  const msg = typeof parsed.msg === "string" ? parsed.msg : "";
  let out = `${formatTime(parsed.time)} ${formatLevel(parsed.level)} [${service}] ${msg}`;

  const extras: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (SKIP_KEYS.has(key)) continue;
    extras.push(`${key}=${formatValue(value)}`);
  }
  if (extras.length > 0) out += ` ${extras.join(" ")}`;
  return out;
}

function createPrettyStream(): Transform {
  let remainder = "";
  return new Transform({
    transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
      remainder += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const lines = remainder.split("\n");
      remainder = lines.pop() ?? "";
      let output = "";
      for (const line of lines) {
        if (line.length === 0) continue;
        output += `${prettyLine(line)}\n`;
      }
      callback(null, output);
    },
    flush(callback: TransformCallback): void {
      const last = remainder;
      remainder = "";
      callback(null, last.length > 0 ? `${prettyLine(last)}\n` : "");
    },
  });
}

let sharedPretty: Transform | undefined;

function getPrettyStream(): Transform {
  if (sharedPretty === undefined) {
    sharedPretty = createPrettyStream();
    // pipe() handles backpressure; do not end stdout when the transform ends.
    sharedPretty.pipe(process.stdout, { end: false });
  }
  return sharedPretty;
}

export function createLogger(service: string): Logger {
  const options: pino.LoggerOptions = {
    level: resolveLevel(process.env.LOG_LEVEL),
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (process.env.NODE_ENV === "production") {
    return pino(options);
  }
  return pino(options, getPrettyStream());
}
