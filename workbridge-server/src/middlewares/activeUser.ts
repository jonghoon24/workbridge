import type { NextFunction, Request, Response } from 'express';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';

/**
 * Re-reads the caller and rejects a soft-deleted user with 401. **Expansion routes only**, after
 * `authenticate` (BEHAVIOR.md rule 12). Pre-existing routes do not mount it, which is why D12
 * persists there — the mix is intended.
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
