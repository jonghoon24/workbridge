import type { NextFunction, Response } from 'express';

import { listContracts } from '../services/contracts.service';
import type { ContractListQuery } from '../services/contracts.service';
import type { AuthedRequest } from '../types/index';

/** `GET /api/contracts`: the caller's contracts as client or freelancer, paginated. */
export async function getMyContracts(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await listContracts(req.user.id, res.locals.query as ContractListQuery));
  } catch (err) {
    next(err);
  }
}
