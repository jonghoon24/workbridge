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
  /**
   * AES-256 key (32 bytes, base64) for payout account numbers at rest (`lib/payoutAccountCrypto.ts`).
   * Read at every encrypt/decrypt, so only the payout-account and payout paths fail without it.
   */
  get PAYOUT_ACCOUNT_ENCRYPTION_KEY(): string {
    return required('PAYOUT_ACCOUNT_ENCRYPTION_KEY');
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
  /**
   * Days a submitted milestone waits for review before it is approved automatically.
   * Raw string; `autoApproveDays()` in `services/milestones.service.ts` interprets it.
   */
  get MILESTONE_AUTO_APPROVE_DAYS(): string {
    return withDefault('MILESTONE_AUTO_APPROVE_DAYS', '7');
  },
  /** Poll interval of the development job worker, in milliseconds. */
  get JOB_POLL_INTERVAL_MS(): string {
    return withDefault('JOB_POLL_INTERVAL_MS', '5000');
  },
  /**
   * The **private** Supabase Storage bucket of message and milestone-submission attachments
   * (`lib/attachmentStorage.ts`). Profile and portfolio images stay in the public `workbridge` bucket.
   */
  get SUPABASE_ATTACHMENT_BUCKET(): string {
    return withDefault('SUPABASE_ATTACHMENT_BUCKET', 'workbridge-attachments');
  },
  /** The `From` of every email. */
  get MAIL_FROM(): string {
    return withDefault('MAIL_FROM', 'WorkBridge <no-reply@workbridge.local>');
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
  /**
   * Shared with the Next.js proxy (`workbridge-client`'s `PROXY_SHARED_SECRET`). A request whose
   * `X-Proxy-Secret` matches it may name the browser's address in `X-Client-IP`
   * (`lib/clientIp.ts`). Unset → that header is never trusted. Read per request.
   */
  get PROXY_SHARED_SECRET(): string | undefined {
    return process.env.PROXY_SHARED_SECRET;
  },
  /** Set to `1` by Vercel at build and run time. Its edge rewrites `X-Vercel-Forwarded-For`. */
  get VERCEL(): string | undefined {
    return process.env.VERCEL;
  },
  /** Rate limits are on unless this is exactly `'false'`. Read per request. */
  get RATE_LIMIT_ENABLED(): string | undefined {
    return process.env.RATE_LIMIT_ENABLED;
  },
  /** Shared secret for `POST /api/internal/jobs/run`. Unset → the endpoint 404s. */
  get INTERNAL_JOB_TOKEN(): string | undefined {
    return process.env.INTERNAL_JOB_TOKEN;
  },
  /**
   * Which mail provider sends email. Unset, empty or `log` → the log provider; any other
   * value is unsupported and fails the sends that need it. Read at every send.
   */
  get MAIL_PROVIDER(): string | undefined {
    return process.env.MAIL_PROVIDER;
  },
  /**
   * `settlement.payout` jobs run only when this is exactly `'true'`; otherwise the runner leaves
   * them `PENDING` (`jobs/gates.ts`). Off by default: the only payout provider marks a settlement
   * paid without moving money. Read at every runner pass.
   */
  get JOB_PAYOUT_ENABLED(): string | undefined {
    return process.env.JOB_PAYOUT_ENABLED;
  },
  /**
   * `notification.email` jobs send only when this is exactly `'true'`; otherwise each delivery is
   * marked `SKIPPED` (`jobs/gates.ts`). Off by default: the only mail provider writes the address
   * and the whole body to the log (#26). Read at every send.
   */
  get JOB_EMAIL_ENABLED(): string | undefined {
    return process.env.JOB_EMAIL_ENABLED;
  },
  /**
   * Google re-authentication (`services/reauth.service.ts`) refuses a Google sign-in without
   * `auth_time` only when this is exactly `'true'`. Off by default: Google returns `auth_time` only
   * to a published, verified app with "Session age claims" turned on (docs/ENV.md). Read per callback.
   */
  get GOOGLE_REAUTH_REQUIRE_AUTH_TIME(): string | undefined {
    return process.env.GOOGLE_REAUTH_REQUIRE_AUTH_TIME;
  },
  /** The development worker starts unless this is exactly `'false'`. */
  get JOB_WORKER_ENABLED(): string | undefined {
    return process.env.JOB_WORKER_ENABLED;
  },
  /** Sentry DSN. Unset → error reporting is off and `@sentry/node` is never loaded. Read per call. */
  get SENTRY_DSN(): string | undefined {
    return process.env.SENTRY_DSN;
  },
  /** Sentry `environment`. Unset → `VERCEL_ENV`, then `NODE_ENV`, then `development` (`lib/sentry.ts`). */
  get SENTRY_ENVIRONMENT(): string | undefined {
    return process.env.SENTRY_ENVIRONMENT;
  },
  /** Set by Vercel (`production` / `preview` / `development`). */
  get VERCEL_ENV(): string | undefined {
    return process.env.VERCEL_ENV;
  },
  /** Set by Vercel for Git deployments; the Sentry `release`. */
  get VERCEL_GIT_COMMIT_SHA(): string | undefined {
    return process.env.VERCEL_GIT_COMMIT_SHA;
  },

  // --- Derived --------------------------------------------------------------
  get isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  },
};
