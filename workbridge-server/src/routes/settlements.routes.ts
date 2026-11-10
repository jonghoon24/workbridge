import { Router } from 'express';

import { getMySettlements, getSettlementById, getSettlementSummary } from '../controllers/settlements.controller';
import { authenticate, requireRole } from '../middlewares/auth';
import { requireActiveUser } from '../middlewares/activeUser';
import { validate } from '../middlewares/validate';
import { settlementListQuery } from '../schemas/settlements';

/** `/api/settlements` — a freelancer's own settlements. */
const router = Router();

// Per route rather than `router.use`, so unmatched paths stay unmatched (#19).
const guard = [authenticate, requireActiveUser, requireRole('FREELANCER')];

router.get('/', ...guard, validate({ query: settlementListQuery }), getMySettlements);
// Before `/:id`, so `summary` is never taken for an id.
router.get('/summary', ...guard, getSettlementSummary);
router.get('/:id', ...guard, getSettlementById);

export default router;
