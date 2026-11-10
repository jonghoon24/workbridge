/**
 * Moves message and milestone-submission attachments stored before the private bucket (#22) out of
 * the public `workbridge` bucket: each file is copied to the same key in `SUPABASE_ATTACHMENT_BUCKET`
 * and its row gets `storageKey` (its public `url` is cleared). Safe to rerun.
 *
 *   npx tsx scripts/migrate-legacy-attachments.ts           # dry run: counts only
 *   npx tsx scripts/migrate-legacy-attachments.ts --apply   # copies and updates the rows
 *
 * Reads `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `SUPABASE_ATTACHMENT_BUCKET` from
 * the environment (or `.env`). The public copies stay; delete `messages/` and `milestones/` from the
 * public bucket once the run is verified (docs/DEPLOYMENT.md "첨부 파일 저장소").
 */
import 'dotenv/config';

import prisma from '../src/lib/prisma';
import { migrateLegacyAttachments } from '../src/services/attachments.service';

async function main() {
  const apply = process.argv.includes('--apply');
  const result = await migrateLegacyAttachments({ apply });
  console.log(JSON.stringify({ apply, ...result }, null, 2));
  if (result.failed.length > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
