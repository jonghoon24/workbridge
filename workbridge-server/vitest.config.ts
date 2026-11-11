import { defineConfig } from 'vitest/config';

/**
 * Tests run against a **real Postgres database**, not mocks. The bugs this suite is meant to
 * catch are database behaviours — foreign keys, unique constraints, transaction rollback — and
 * a mocked Prisma client would make every one of them invisible.
 *
 * Point at a different database with `TEST_DATABASE_URL`. Create and migrate it first:
 *   bash scripts/test-db.sh workbridge_test
 */
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL
  ?? `postgresql://${process.env.USER ?? 'postgres'}@localhost:5432/workbridge_test`;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],

    // Every test file shares one database, so they must not run concurrently.
    fileParallelism: false,

    // Explicit env wins over the `.env` file that both dotenv and Prisma load, so this
    // redirects the suite away from the development database.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl,
      DIRECT_URL: testDatabaseUrl,

      // `lib/openai.ts` and `middlewares/upload.ts` construct clients at module-evaluation
      // time and throw when these are absent, so importing the app requires them. Dummy
      // values are fine — no test may call a real external service.
      JWT_ACCESS_SECRET: 'test_access_secret',
      JWT_REFRESH_SECRET: 'test_refresh_secret',
      JWT_ACCESS_EXPIRES_IN: '15m',
      JWT_REFRESH_EXPIRES_IN: '7d',
      OPENAI_API_KEY: 'test_openai_key',
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_SECRET_KEY: 'test_supabase_key',
      GOOGLE_CLIENT_ID: 'test_google_client_id',
      GOOGLE_CLIENT_SECRET: 'test_google_client_secret',
      GOOGLE_CALLBACK_URL: 'http://localhost:3000/api/auth/google/callback',
      CLIENT_URL: 'http://localhost:3000',
      TOSS_SECRET_KEY: 'test_sk_dummy',
      ALLOW_PAYMENT_BYPASS: 'false',
      // A fixed test-only key (base64 of the 32 ASCII bytes `test-payout-account-key-32bytes!`),
      // never used outside the suite.
      PAYOUT_ACCOUNT_ENCRYPTION_KEY: 'dGVzdC1wYXlvdXQtYWNjb3VudC1rZXktMzJieXRlcyE=',

      // Infrastructure. Only error-level lines (500s) reach the console, rate limits are
      // enforced (counters live in a truncated table, so every test starts at zero), and no
      // worker ever starts — tests drive the queue with `runDueJobs({ now })`.
      LOG_LEVEL: 'error',
      RATE_LIMIT_ENABLED: 'true',
      JOB_WORKER_ENABLED: 'false',
      TRUST_PROXY: '',
      PROXY_SHARED_SECRET: '',
      VERCEL: '',
      INTERNAL_JOB_TOKEN: '',
      // Both gated job types run here, as in local development; the gate tests turn them off.
      JOB_PAYOUT_ENABLED: 'true',
      JOB_EMAIL_ENABLED: 'true',
      // Lax Google re-authentication, as in local development; the strict-mode tests turn it on.
      GOOGLE_REAUTH_REQUIRE_AUTH_TIME: 'false',
    },
  },
});
