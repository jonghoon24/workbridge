import type { NextFunction, Request, Response } from 'express';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';

/**
 * Re-reads the caller and rejects a soft-deleted user with 401. Mounted after `authenticate`.
 * Not every authenticated route mounts it yet — the project (except recommendations),
 * application, payment, review and notification (except preferences) routes, `GET`/`PATCH
 * /api/users/me` and its application, bookmark and project lists, the contract detail, sign and
 * complete routes, and `logout`/`select-role` — so a deleted user's unexpired token still works
 * there (#7).
 */
export async function requireActiveUser(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findFirst({
      where: { id: req.user.id, deletedAt: null },
      select: { id: true },
    });

    if (!user) {
      throw new AppError('Account is no longer active', 401);
    }

    next();
  } catch (err) {
    next(err);
  }
}
