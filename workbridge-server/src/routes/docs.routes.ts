import { Router } from 'express';

import { getDocsPage, getOpenApiDocument, requireDocsEnabled } from '../controllers/docs.controller';

/**
 * The API reference, mounted on `/api`. Public; off in production (`requireDocsEnabled`). Not part
 * of the OpenAPI document itself — `test/openapi.test.ts` lists these two as its only exceptions.
 */
const router = Router();

router.get('/openapi.json', requireDocsEnabled, getOpenApiDocument);
router.get('/docs', requireDocsEnabled, getDocsPage);

export default router;
