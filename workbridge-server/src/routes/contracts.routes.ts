import { Router } from 'express';
import { completeContract, getContract, signContract } from '../controllers/contracts.controller';
import { getMyContracts } from '../controllers/contractList.controller';
import { getConversationOfContract } from '../controllers/conversations.controller';
import { getContractMilestones, putContractMilestones } from '../controllers/milestones.controller';
import { authenticate, requireRole } from '../middlewares/auth';
import { requireActiveUser } from '../middlewares/activeUser';
import { validate } from '../middlewares/validate';
import { contractListQuery } from '../schemas/contracts';
import { milestonePlanBody } from '../schemas/milestones';

const router = Router();

// `/` must stay before `/:id`.
router.get('/', authenticate, requireActiveUser, validate({ query: contractListQuery }), getMyContracts);
router.get('/:id/milestones', authenticate, requireActiveUser, getContractMilestones);
router.put(
  '/:id/milestones',
  authenticate,
  requireActiveUser,
  requireRole('CLIENT'),
  validate({ body: milestonePlanBody }),
  putContractMilestones,
);
router.get('/:id/conversation', authenticate, requireActiveUser, getConversationOfContract);

// `authenticate` only: no `requireActiveUser` yet (#7).
router.get('/:id', authenticate, getContract);
router.patch('/:id', authenticate, completeContract);
router.post('/:id/sign', authenticate, signContract);

export default router;
