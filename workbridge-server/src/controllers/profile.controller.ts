import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../lib/errors';
import { loadProfileCompletion } from '../lib/profileCompletion';
import {
  createCareer,
  deleteCareer,
  getPublicCareers,
  updateCareer,
} from '../services/careers.service';
import {
  createPortfolioItem,
  deletePortfolioItem,
  getPublicPortfolio,
  reorderPortfolio,
  updatePortfolioItem,
} from '../services/portfolio.service';
import type {
  CareerCreateInput,
  CareerPatchInput,
  PortfolioCreateInput,
  PortfolioPatchInput,
} from '../schemas/profile';
import type { AuthedFileRequest, AuthedRequest } from '../types/index';

/** Portfolio and career routes and `GET /me/profile-completion` (docs/domain/accounts.md). */

// ---------------------------------------------------------------------------------------------
// Public reads — no `authenticate`, so these must never read `req.user`.
// ---------------------------------------------------------------------------------------------

/** `GET /api/users/:id/portfolio`. */
export async function getUserPortfolio(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await getPublicPortfolio(req.params.id));
  } catch (err) {
    next(err);
  }
}

/** `GET /api/users/:id/careers`. */
export async function getUserCareers(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await getPublicCareers(req.params.id));
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------------------------
// Portfolio writes (FREELANCER)
// ---------------------------------------------------------------------------------------------

/** `POST /api/users/me/portfolio`. */
export async function postPortfolioItem(req: AuthedFileRequest, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await createPortfolioItem(req.user.id, req.body as PortfolioCreateInput, req.file));
  } catch (err) {
    next(err);
  }
}

/** `PATCH /api/users/me/portfolio/:itemId`. */
export async function patchPortfolioItem(req: AuthedFileRequest, res: Response, next: NextFunction) {
  try {
    const input = req.body as PortfolioPatchInput;
    // Still validation, so before the existence check — the schema cannot see the file.
    if (req.file && input.removeImage) {
      throw new AppError('removeImage: Cannot upload and remove an image at once', 400);
    }
    res.json(await updatePortfolioItem(req.user.id, req.params.itemId, input, req.file));
  } catch (err) {
    next(err);
  }
}

/** `DELETE /api/users/me/portfolio/:itemId`. */
export async function removePortfolioItem(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await deletePortfolioItem(req.user.id, req.params.itemId));
  } catch (err) {
    next(err);
  }
}

/** `PUT /api/users/me/portfolio/order`. */
export async function putPortfolioOrder(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await reorderPortfolio(req.user.id, (req.body as { ids: string[] }).ids));
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------------------------
// Career writes (FREELANCER)
// ---------------------------------------------------------------------------------------------

/** `POST /api/users/me/careers`. */
export async function postCareer(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await createCareer(req.user.id, req.body as CareerCreateInput));
  } catch (err) {
    next(err);
  }
}

/** `PATCH /api/users/me/careers/:careerId`. */
export async function patchCareer(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await updateCareer(req.user.id, req.params.careerId, req.body as CareerPatchInput));
  } catch (err) {
    next(err);
  }
}

/** `DELETE /api/users/me/careers/:careerId`. */
export async function removeCareer(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await deleteCareer(req.user.id, req.params.careerId));
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------------------------
// Profile completion (either role)
// ---------------------------------------------------------------------------------------------

/** `GET /api/users/me/profile-completion`. Scored on the stored role, not the token's. */
export async function getMyProfileCompletion(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const completion = await loadProfileCompletion(req.user.id);
    // `requireActiveUser` has just read the row, so this is only a delete in between.
    if (!completion) throw new AppError('User not found', 404);
    res.json(completion);
  } catch (err) {
    next(err);
  }
}
