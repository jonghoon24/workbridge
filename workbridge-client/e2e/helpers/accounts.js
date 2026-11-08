// Seed accounts (docs/SEED_DATA.md). Every seed password is `password123`.
const PASSWORD = 'password123';

const ACCOUNTS = {
  client: { email: 'kim@example.com', name: '김서준', role: 'CLIENT' },
  freelancer: { email: 'park@example.com', name: '박지윤', role: 'FREELANCER' },
};

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3002';

/** A title that will not collide with earlier runs against the same database. */
function uniqueTitle(label) {
  return `[E2E] ${label} ${Date.now()}`;
}

module.exports = { PASSWORD, ACCOUNTS, BASE_URL, uniqueTitle };
