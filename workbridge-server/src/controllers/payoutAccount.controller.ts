import type { NextFunction, Response } from 'express';

import { deletePayoutAccount, getPayoutAccount, putPayoutAccount } from '../services/payoutAccount.service';
import type { PayoutAccountInput } from '../services/payoutAccount.service';
import type { AuthedRequest } from '../types/index';

/** `GET /api/users/me/payout-account`. */
export async function getMyPayoutAccount(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await getPayoutAccount(req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `PUT /api/users/me/payout-account`. */
export async function putMyPayoutAccount(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await putPayoutAccount(req.user.id, req.body as PayoutAccountInput));
  } catch (err) {
    next(err);
  }
}

/** `DELETE /api/users/me/payout-account`. */
export async function deleteMyPayoutAccount(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await deletePayoutAccount(req.user.id));
  } catch (err) {
    next(err);
  }
}
