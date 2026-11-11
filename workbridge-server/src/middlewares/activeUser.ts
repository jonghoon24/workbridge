import type { NextFunction, Request, Response } from 'express';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';

/**
 * Re-reads the caller and rejects a soft-deleted user with 401. Mounted after `authenticate` on
 * every write route and every expansion route. The existing domains' reads do not mount it
 * (`GET /api/users/me` 404s on its own lookup), nor do `select-role` (404 from its own lookup),
 * `logout` and the always-410 `PATCH /api/contracts/:id`.
 */
export async function requireActiveUser(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findFirst({
      where: { id: req.user.id, deletedAt: null },
      select: { id: true },
    });

    if (!user) {
      throw new AppError('ACCOUNT_INACTIVE', 'Account is no longer active');
    }

    next();
  } catch (err) {
    next(err);
  }
}
