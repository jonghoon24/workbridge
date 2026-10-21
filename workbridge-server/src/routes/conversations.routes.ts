import { Router } from 'express';

/**
 * Conversations and messages (BEHAVIOR.md "Conversations", MG11–MG17). Mounted on
 * `/api/conversations` by P2-S as an empty router; the routes arrive with Phase 2A.
 * Register `/unread-count` before `/:id` (MG12). `GET /api/contracts/:id/conversation` (MG18)
 * lives on the contracts router instead.
 */
const router = Router();

export default router;
