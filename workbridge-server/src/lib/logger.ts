import { env } from '../env';
import { getRequestContext } from './requestContext';

/**
 * Dependency-free JSON-line logger.
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

/**
 * An `Error`, or an error-shaped object that is not one (some SDKs throw plain objects). A bare
 * `message` is not enough — `Notification`, `Message` and `ZodIssue` all have one — so a
 * non-`Error` needs a string `stack`, or a string `name` alongside its string `message`.
 */
function isErrorLike(value: unknown): value is Record<string, unknown> {
  if (value instanceof Error) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.stack === 'string'
    || (typeof candidate.name === 'string' && typeof candidate.message === 'string');
}

/**
 * `Error`'s `name`, `message` and `stack` are non-enumerable, so `JSON.stringify(err)` yields
 * `{}`. Spell them out, plus the fields our errors and Prisma's carry: `code` (P2002, …),
 * `statusCode` (AppError) and `meta` (Prisma).
 */
export function serializeError(err: unknown, seen: WeakSet<object> = new WeakSet()): Record<string, unknown> {
  if (!isErrorLike(err)) {
    return { message: String(err) };
  }
  seen.add(err);

  const out: Record<string, unknown> = {
    name: err.name ?? (err.constructor as { name?: string } | undefined)?.name,
    message: err.message,
    stack: err.stack,
  };
  if (err.code !== undefined) out.code = err.code;
  if (err.statusCode !== undefined) out.statusCode = err.statusCode;
  if (err.meta !== undefined) out.meta = err.meta;
  if (err.cause !== undefined) {
    // A cause chain can loop back on itself (`e.cause = e`); recursing would overflow the stack
    // inside `errorHandler` and lose both the log line and the response.
    if (isErrorLike(err.cause)) {
      out.cause = seen.has(err.cause) ? '[Circular]' : serializeError(err.cause, seen);
    } else {
      out.cause = err.cause;
    }
  }
  return out;
}

/**
 * `JSON.stringify` that survives cycles and BigInt instead of throwing mid-log. Only a value
 * that is its own ancestor is a cycle; the same object referenced twice side by side is printed
 * twice.
 */
function stringify(record: Record<string, unknown>): string {
  const ancestors: object[] = [];
  return JSON.stringify(record, function replacer(this: unknown, _key: string, value: unknown) {
    if (typeof value === 'bigint') return value.toString();
    if (!value || typeof value !== 'object') return value;

    // `this` is the object holding `value`; drop ancestors we have walked back out of.
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (ancestors.includes(value)) return '[Circular]';
    ancestors.push(value);
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
