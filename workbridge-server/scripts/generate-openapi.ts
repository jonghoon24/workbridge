/**
 * Writes `openapi.json` from the zod schemas (`src/openapi/document.ts`). Run with
 * `npm run openapi`; CI fails when the committed file differs from a fresh run.
 *
 * Needs no database and no environment variables: the document modules import schemas and
 * Prisma's enums only, never the app. The output is deterministic — keys follow the order the
 * schemas and routes are registered in — so two runs on the same code are byte-identical.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildOpenApiDocument } from '../src/openapi/document';

const target = resolve(__dirname, '..', 'openapi.json');
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`wrote ${target}`);
