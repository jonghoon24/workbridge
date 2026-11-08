import type * as SentryNode from '@sentry/node';

import { env } from '../env';
import { logger } from './logger';

/**
 * Error reporting to Sentry — **off unless `SENTRY_DSN` is set**.
 *
 * Reports exactly two things: a response that ends as 500 (`errorHandler`) and a job that fails
 * for good (`jobs/runner.ts`). Errors only (`tracesSampleRate: 0`), no PII.
 *
 * `@sentry/node` is loaded with a dynamic `import()` the first time it is needed, so without a
 * DSN nothing beyond this module is loaded and every function here returns at once. `SENTRY_DSN`
 * is read on every call (like `RATE_LIMIT_ENABLED`), so tests can switch it without reloading.
 *
 * Nothing here may throw into the caller or log at `error` level: error level is reserved for
 * `errorHandler`'s 500s and job failures (the suite counts `console.error` lines). A Sentry
 * failure is a `warn`.
 */

type Sentry = typeof SentryNode;

/** Resolves to the initialized SDK, or `null` if it could not be loaded. Created once. */
let loading: Promise<Sentry | null> | undefined;

export function isSentryEnabled(): boolean {
  return Boolean(env.SENTRY_DSN);
}

function sentryEnvironment(): string {
  return env.SENTRY_ENVIRONMENT || env.VERCEL_ENV || env.NODE_ENV || 'development';
}

function load(): Promise<Sentry | null> {
  loading ??= import('@sentry/node')
    .then((Sentry) => {
      Sentry.init({
        dsn: env.SENTRY_DSN,
        environment: sentryEnvironment(),
        release: env.VERCEL_GIT_COMMIT_SHA || undefined,
        tracesSampleRate: 0,
        sendDefaultPii: false,
      });
      return Sentry;
    })
    .catch((err: unknown) => {
      logger.warn('sentry init failed', { err });
      return null;
    });
  return loading;
}

/**
 * Starts loading and initializing the SDK when a DSN is set. Called by the entry points
 * (`index.ts`, `jobs/cli.ts`) right after `dotenv/config`; a no-op without a DSN.
 */
export function initSentry(): void {
  if (isSentryEnabled()) void load();
}

export interface CaptureContext {
  tags?: Record<string, string | number | undefined>;
  userId?: string;
  extra?: Record<string, unknown>;
}

/** Sends `err` to Sentry. Resolves once it is queued (not sent — see `flushSentry`). */
export async function captureError(err: unknown, context: CaptureContext = {}): Promise<void> {
  if (!isSentryEnabled()) return;

  try {
    const Sentry = await load();
    if (!Sentry) return;

    const tags: Record<string, string> = {};
    for (const [key, value] of Object.entries(context.tags ?? {})) {
      if (value !== undefined) tags[key] = String(value);
    }

    Sentry.captureException(err, {
      tags,
      ...(context.userId ? { user: { id: context.userId } } : {}),
      ...(context.extra ? { extra: context.extra } : {}),
    });
  } catch (captureErr) {
    logger.warn('sentry capture failed', { err: captureErr });
  }
}

/**
 * Waits up to `timeoutMs` for queued events to be sent. On serverless the function may be
 * frozen as soon as the response goes out, so callers flush before responding. A timeout is not
 * an error: the event may be lost, and the caller carries on.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!isSentryEnabled() || !loading) return;

  try {
    const Sentry = await loading;
    if (!Sentry) return;

    const drained = await Sentry.flush(timeoutMs);
    if (!drained) logger.warn('sentry flush timed out', { timeoutMs });
  } catch (err) {
    logger.warn('sentry flush failed', { err });
  }
}
