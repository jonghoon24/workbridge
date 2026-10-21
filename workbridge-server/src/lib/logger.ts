import { env } from '../env';
import { getRequestContext } from './requestContext';

/**
 * Dependency-free JSON-line logger (BEHAVIOR.md rule 9).
 *
 * **Only `error` goes to `console.error`**; `debug`/`info`/`warn` go to `console.log`. The
 * suite pins "a 500 is logged exactly once" with a `console.error` spy, so error level is
 * reserved: in the request path only `errorHandler` uses it, and only for a 500.
 *
 * `LOG_LEVEL` is read on every call (it is cheap), so tests can change it without reloading.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

const LEVEL_RANK: Record<LogLevel | 'silent', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function threshold(): number {
  const configured = env.LOG_LEVEL as LogLevel | 'silent';
  return LEVEL_RANK[configured] ?? LEVEL_RANK.info;
}

function isErrorLike(value: unknown): value is Record<string, unknown> {
  if (value instanceof Error) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.message === 'string' || typeof candidate.stack === 'string';
}

/**
 * `Error`'s `name`, `message` and `stack` are non-enumerable, so `JSON.stringify(err)` yields
 * `{}`. Spell them out, plus the fields our errors and Prisma's carry: `code` (P2002, …),
 * `statusCode` (AppError) and `meta` (Prisma).
 */
export function serializeError(err: unknown): Record<string, unknown> {
  if (!isErrorLike(err)) {
    return { message: String(err) };
  }

  const out: Record<string, unknown> = {
    name: err.name ?? (err.constructor as { name?: string } | undefined)?.name,
    message: err.message,
    stack: err.stack,
  };
  if (err.code !== undefined) out.code = err.code;
  if (err.statusCode !== undefined) out.statusCode = err.statusCode;
  if (err.meta !== undefined) out.meta = err.meta;
  if (err.cause !== undefined) out.cause = isErrorLike(err.cause) ? serializeError(err.cause) : err.cause;
  return out;
}

/** `JSON.stringify` that survives cycles and BigInt instead of throwing mid-log. */
function stringify(record: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(record, (_key, value: unknown) => {
    if (typeof value === 'bigint') return value.toString();
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  });
}

function write(level: LogLevel, msg: string, fields: LogFields = {}): void {
  if (LEVEL_RANK[level] < threshold()) return;

  const context = getRequestContext();
  const record: Record<string, unknown> = { time: new Date().toISOString(), level, msg };
  if (context?.requestId) record.requestId = context.requestId;
  if (context?.jobId) record.jobId = context.jobId;

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    record[key] = isErrorLike(value) ? serializeError(value) : value;
  }

  const line = stringify(record);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (msg: string, fields?: LogFields) => write('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => write('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => write('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => write('error', msg, fields),
};

export type Logger = typeof logger;
