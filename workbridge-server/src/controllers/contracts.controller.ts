import type { NextFunction, Response } from 'express';

import {
  cancelContract,
  getContractDetail,
  recordSignature,
  refuseManualCompletion,
} from '../services/contracts.service';
import type { AuthedRequest } from '../types/index';

/** `GET /api/contracts/:id`. */
export async function getContract(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await getContractDetail(req.params.id, req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `POST /api/contracts/:id/sign`. */
export async function signContract(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await recordSignature(req.params.id, req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `PATCH /api/contracts/:id` — always a 410: completion is automatic. */
export async function completeContract(_req: AuthedRequest, _res: Response, next: NextFunction) {
  try {
    refuseManualCompletion();
  } catch (err) {
    next(err);
  }
}

/** `POST /api/contracts/:id/cancel` — either party withdraws a contract before both have signed. */
export async function postCancelContract(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await cancelContract(req.params.id, req.user.id, new Date()));
  } catch (err) {
    next(err);
  }
}
