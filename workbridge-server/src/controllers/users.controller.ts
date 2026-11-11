import type { NextFunction, Request, Response } from 'express';

import {
  getMyProfile,
  getPublicProfile,
  listMyApplications,
  listMyBookmarks,
  listMyProjects,
  updateMyProfile,
} from '../services/users.service';
import type { ProfileUpdateInput } from '../schemas/users';
import type { AuthedFileRequest, AuthedRequest } from '../types/index';

/** `GET /api/users/me`. */
export async function getMe(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await getMyProfile(req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `PATCH /api/users/me`. The body was validated by the caller's role's schema; `profileImage` is optional. */
export async function updateMe(req: AuthedFileRequest, res: Response, next: NextFunction) {
  try {
    res.json(await updateMyProfile(req.user.id, req.body as ProfileUpdateInput, req.file));
  } catch (err) {
    next(err);
  }
}

/** `GET /api/users/:id`. Public route (no `authenticate`) — must not read `req.user`. */
export async function getUserById(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await getPublicProfile(req.params.id));
  } catch (err) {
    next(err);
  }
}

/** `GET /api/users/me/applications`. Runs the lazy lifecycle sweep, so it writes rows. */
export async function getMyApplications(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await listMyApplications(req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `GET /api/users/me/bookmarks`. */
export async function getMyBookmarks(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await listMyBookmarks(req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `GET /api/users/me/projects`. Runs the lazy lifecycle sweep, so it writes rows. */
export async function getMyProjects(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await listMyProjects(req.user.id));
  } catch (err) {
    next(err);
  }
}
