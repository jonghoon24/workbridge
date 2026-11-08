// `dotenv/config` must stay the first import — see `src/index.ts`.
import 'dotenv/config';
import { initSentry } from '../lib/sentry';

import prisma from '../lib/prisma';
import { warnIfUnsupportedMailProvider } from '../lib/mail/provider';
import { ensureRecurringJobs } from './recurring';
import { recoverStaleJobs, runDueJobs } from './runner';
import { startJobWorker } from './worker';

/**
 *   npm run jobs:run     # tsx src/jobs/cli.ts --once — one pass, prints the result
 *   npm run jobs:worker  # tsx src/jobs/cli.ts        — standalone polling worker
 *
 * Lives under `src/` so typecheck covers it.
 */
async function main() {
  initSentry();
  // NC14: once per process, for both `jobs:run` and `jobs:worker`.
  warnIfUnsupportedMailProvider();

  if (process.argv.includes('--once')) {
    const now = new Date();
    const enqueued = await ensureRecurringJobs(now);
    const recovered = await recoverStaleJobs(now);
    const result = await runDueJobs({ now });
    console.log(JSON.stringify({ ...result, recurringEnqueued: enqueued, recovered }));
    await prisma.$disconnect();
    return;
  }

  startJobWorker();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
