import { afterAll, beforeAll, beforeEach } from 'vitest';

// Deliberately does NOT import `./helpers/api`. That module imports the Express app, and setup
// files run *before* test files — so pulling the app in here would load and cache `axios` and
// `@supabase/supabase-js` before any test file's `vi.mock` could register, leaving
// the app holding the real implementations. Every mocked test in the suite fails that way.
import { assertTestDatabase, prisma, resetDb } from './helpers/db';

beforeAll(() => {
  assertTestDatabase();
});

// Each test starts from an empty database. Fixtures are built per test by the factories in
// `test/helpers/factories.ts` rather than shared, so no test depends on another's state or
// on execution order.
beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});
