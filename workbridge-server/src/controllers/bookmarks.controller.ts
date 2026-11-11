import type { NextFunction, Response } from 'express';

import { listBookmarkedProjectIds } from '../services/bookmarks.service';
import type { AuthedRequest } from '../types/index';

/** `GET /api/users/me/bookmarks/ids` — the caller's bookmarked project ids. */
export async function getMyBookmarkedProjectIds(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await listBookmarkedProjectIds(req.user.id));
  } catch (err) {
    next(err);
  }
}
