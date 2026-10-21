/**
 * Typed access to `process.env`.
 *
 * Under `strict`, `process.env.FOO` is `string | undefined`, which is rejected by
 * `jwt.sign`'s `Secret`, `URLSearchParams`'s `Record<string, string>`, and Supabase's
 * `createClient`. Reading through this module yields a plain `string` instead.
 *
 * These are **lazy getters on purpose** — they throw when accessed, not when this module
 * is imported. That preserves today's behavior: the server boots with an incomplete
 * `.env` and only fails on the code path that needs the missing value. Validating
 * everything eagerly would turn a missing `TOSS_SECRET_KEY` into a boot failure.
 *
 * `DATABASE_URL` / `DIRECT_URL` are absent here — they are read by Prisma via `env()` in
 * `schema.prisma`, never by application code.
 */

/** A var whose call site rejects `undefined`. Throws on access if unset. */
function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

/** A var with a documented fallback. */
function withDefault(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const env = {
  // --- Required: these call sites reject `undefined` -------------------------
  get JWT_ACCESS_SECRET(): string {
    return required('JWT_ACCESS_SECRET');
  },
  get JWT_REFRESH_SECRET(): string {
    return required('JWT_REFRESH_SECRET');
  },
  get GOOGLE_CLIENT_ID(): string {
    return required('GOOGLE_CLIENT_ID');
  },
  get GOOGLE_CLIENT_SECRET(): string {
    return required('GOOGLE_CLIENT_SECRET');
  },
  get GOOGLE_CALLBACK_URL(): string {
    return required('GOOGLE_CALLBACK_URL');
  },
  get SUPABASE_URL(): string {
    return required('SUPABASE_URL');
  },
  get SUPABASE_SECRET_KEY(): string {
    return required('SUPABASE_SECRET_KEY');
  },
  get OPENAI_API_KEY(): string {
    return required('OPENAI_API_KEY');
  },

  // --- Defaulted ------------------------------------------------------------
  get JWT_ACCESS_EXPIRES_IN(): string {
    return withDefault('JWT_ACCESS_EXPIRES_IN', '15m');
  },
  get JWT_REFRESH_EXPIRES_IN(): string {
    return withDefault('JWT_REFRESH_EXPIRES_IN', '7d');
  },
  get PORT(): string {
    return withDefault('PORT', '4000');
  },
  /** `debug | info | warn | error | silent`. The test config sets `error`. */
  get LOG_LEVEL(): string {
    return withDefault('LOG_LEVEL', 'info');
  },
  /** Poll interval of the development job worker, in milliseconds. */
  get JOB_POLL_INTERVAL_MS(): string {
    return withDefault('JOB_POLL_INTERVAL_MS', '5000');
  },

  // --- Optional passthrough: these call sites tolerate `undefined` ----------
  get NODE_ENV(): string | undefined {
    return process.env.NODE_ENV;
  },
  get CLIENT_URL(): string | undefined {
    return process.env.CLIENT_URL;
  },
  get CORS_ORIGINS(): string | undefined {
    return process.env.CORS_ORIGINS;
  },
  get TOSS_SECRET_KEY(): string | undefined {
    return process.env.TOSS_SECRET_KEY;
  },
  get ALLOW_PAYMENT_BYPASS(): string | undefined {
    return process.env.ALLOW_PAYMENT_BYPASS;
  },
  /**
   * Express `trust proxy` setting (`loopback`, a hop count, a subnet list, …). Unset means the
   * socket address is the client IP and `X-Forwarded-For` is ignored.
   */
  get TRUST_PROXY(): string | undefined {
    return process.env.TRUST_PROXY;
  },
  /** Rate limits are on unless this is exactly `'false'`. Read per request. */
  get RATE_LIMIT_ENABLED(): string | undefined {
    return process.env.RATE_LIMIT_ENABLED;
  },
  /** Shared secret for `POST /api/internal/jobs/run`. Unset → the endpoint 404s. */
  get INTERNAL_JOB_TOKEN(): string | undefined {
    return process.env.INTERNAL_JOB_TOKEN;
  },
  /** The development worker starts unless this is exactly `'false'`. */
  get JOB_WORKER_ENABLED(): string | undefined {
    return process.env.JOB_WORKER_ENABLED;
  },

  // --- Derived --------------------------------------------------------------
  get isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  },
};
