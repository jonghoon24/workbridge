import { Router } from 'express';

/**
 * Conversations and messages (BEHAVIOR.md "Conversations", MG11–MG17). Mounted on
 * `/api/conversations` by P2-S as an empty router; the routes arrive with Phase 2A.
 * Register `/unread-count` before `/:id` (MG12). `GET /api/contracts/:id/conversation` (MG18)
 * lives on the contracts router instead.
 *
 * Attach guards per route, never with `router.use` — Q10 vectors and public GETs live here
 * (an unmatched path must still fall through to the HTML 404, and PF16/PF17 need no token).
 */
const router = Router();

export default router;
