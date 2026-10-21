import type { NextFunction, Response } from 'express';

import { getSettlement, listSettlements, settlementSummary } from '../services/settlements.service';
import type { SettlementListQuery } from '../services/settlements.service';
import type { AuthedRequest } from '../types/index';

/** `GET /api/settlements` (S14). */
export async function getMySettlements(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await listSettlements(req.user.id, res.locals.query as SettlementListQuery));
  } catch (err) {
    next(err);
  }
}

/** `GET /api/settlements/summary` (S15). */
export async function getSettlementSummary(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await settlementSummary(req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `GET /api/settlements/:id` (S16). */
export async function getSettlementById(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await getSettlement(req.params.id, req.user.id));
  } catch (err) {
    next(err);
  }
}
