import { Router } from 'express';

/**
 * Portfolio, careers, profile completion and project recommendations (BEHAVIOR.md
 * "Portfolio and careers", "Profile completion and recommendations"). Mounted on `/api/users`
 * **after** `userRoutes` by P2-S as an empty router; the routes arrive with Phase 2B.
 * Register `PUT /me/portfolio/order` before `/me/portfolio/:itemId` (PF12). The public
 * `GET /:id/portfolio` and `GET /:id/careers` must not read `req.user`.
 * `GET /api/projects/:id/recommended-freelancers` (RC3) lives on the projects router instead.
 */
const router = Router();

export default router;
