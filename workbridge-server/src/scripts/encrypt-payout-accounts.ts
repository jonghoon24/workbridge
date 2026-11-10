// `dotenv/config` must stay the first import — see `src/index.ts`.
import 'dotenv/config';

import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { encryptLegacyAccountNumbers } from '../services/payoutAccount.service';

/**
 *   npm run payout:encrypt-accounts
 *
 * One-off backfill: encrypts every payout account number still stored as plain digits (rows
 * written before encryption). Safe to run more than once and while the app is serving. Needs
 * `DATABASE_URL` and the environment's `PAYOUT_ACCOUNT_ENCRYPTION_KEY` — the same key the server of
 * that environment uses, or the server cannot read what this writes. Remote environments run it
 * through `.github/workflows/payout-encrypt.yml` (docs/DEPLOYMENT.md "지급 계좌 암호화 키").
 *
 * Lives under `src/` so typecheck covers it. Prints one `info` line with the counts.
 */
async function main() {
  await encryptLegacyAccountNumbers();
  await prisma.$disconnect();
}

main().catch(async (err) => {
  logger.warn('payout account encryption backfill failed', { err });
  await prisma.$disconnect();
  process.exit(1);
});
