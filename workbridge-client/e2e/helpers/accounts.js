// Seed accounts (docs/SEED_DATA.md). Every seed password is `password123`.
const PASSWORD = 'password123';

const ACCOUNTS = {
  client: { email: 'kim@example.com', name: '김서준', role: 'CLIENT' },
  freelancer: { email: 'park@example.com', name: '박지윤', role: 'FREELANCER' },
};

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3002';

// Specs create `[E2E]` projects, applications and contracts. Pointing them at a deployed client
// writes those rows into that environment's database (this is how `[E2E]` projects reached the
// production home page). Only local addresses run unless E2E_ALLOW_REMOTE=1 is set on purpose.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
function assertLocalBaseUrl(url = BASE_URL) {
  const { hostname } = new URL(url);
  if (!LOCAL_HOSTS.has(hostname) && process.env.E2E_ALLOW_REMOTE !== '1') {
    throw new Error(
      `E2E_BASE_URL=${url} is not a local address. The specs write test data into that ` +
        "environment's database. Set E2E_ALLOW_REMOTE=1 only for a disposable environment.",
    );
  }
}
assertLocalBaseUrl();

/** A title that will not collide with earlier runs against the same database. */
function uniqueTitle(label) {
  return `[E2E] ${label} ${Date.now()}`;
}

module.exports = { PASSWORD, ACCOUNTS, BASE_URL, uniqueTitle, assertLocalBaseUrl };
