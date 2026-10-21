import type { NextFunction, Response } from 'express';

import { listContracts } from '../services/contracts.service';
import type { ContractListQuery } from '../services/contracts.service';
import type { AuthedRequest } from '../types/index';

/** `GET /api/contracts` — expansion route (CT1–CT3). */
export async function getMyContracts(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await listContracts(req.user.id, res.locals.query as ContractListQuery));
  } catch (err) {
    next(err);
  }
}
