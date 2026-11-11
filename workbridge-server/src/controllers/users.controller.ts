import type { NextFunction, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import type { AuthedFileRequest, AuthedRequest } from '../types/index';
import type { ProfileUpdateInput } from '../schemas/users';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import {
  closeExpiredOpenProjects,
  rejectPendingApplicationsForClosedProjects,
} from '../lib/projectLifecycle';
import { uploadToSupabase } from '../middlewares/upload';
import { listCareers } from '../services/careers.service';
import { listPortfolioItems } from '../services/portfolio.service';
import { v4 as uuidv4 } from 'uuid';

/**
 * The caller's own profile (`GET`/`PATCH /me`). `password` is read only to tell the client whether
 * the account has one ({@link toMyProfile}); the hash itself never leaves this module.
 */
const myProfileSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  profileImage: true,
  bio: true,
  companyName: true,
  businessField: true,
  website: true,
  skills: true,
  activityCategory: true,
  experienceYears: true,
  hourlyRate: true,
  portfolioUrl: true,
  createdAt: true,
  password: true,
} satisfies Prisma.UserSelect;

/** Drops the hash and adds `hasPassword` — false for an account that signs in with Google only. */
function toMyProfile({ password, ...profile }: Prisma.UserGetPayload<{ select: typeof myProfileSelect }>) {
  return { ...profile, hasPassword: password !== null };
}

export async function getMe(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    // `findFirst`, not `findUnique`: a soft-deleted user holding a still-valid access token
    // must not be able to read their profile. `deletedAt` is not part of a unique constraint.
    const user = await prisma.user.findFirst({
      where: { id: req.user.id, deletedAt: null },
      select: myProfileSelect,
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    res.json(toMyProfile(user));
  } catch (err) {
    next(err);
  }
}

export async function updateMe(req: AuthedFileRequest, res: Response, next: NextFunction) {
  try {
    // Parsed by the caller's role's schema (`profileUpdateBodyByRole`): only that role's fields
    // are present, already typed, and absent fields stay absent.
    const fields = req.body as ProfileUpdateInput;

    let profileImage: string | undefined;
    if (req.file) {
      const filename = `${req.user.id}-${uuidv4()}.${req.file.mimetype.split('/')[1]}`;
      profileImage = await uploadToSupabase(req.file.buffer, req.file.mimetype, filename);
    }

    const updateData: Prisma.UserUpdateInput = { ...fields };
    if (profileImage) updateData.profileImage = profileImage;

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: updateData,
      select: myProfileSelect,
    });

    res.json(toMyProfile(user));
  } catch (err) {
    next(err);
  }
}

// Public route (no `authenticate`) — must not read `req.user`.
export async function getUserById(req: Request, res: Response, next: NextFunction) {
  try {
    // Soft-deleted users must not remain publicly visible.
    const user = await prisma.user.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: {
        id: true,
        name: true,
        role: true,
        profileImage: true,
        bio: true,
        companyName: true,
        businessField: true,
        website: true,
        skills: true,
        activityCategory: true,
        experienceYears: true,
        hourlyRate: true,
        portfolioUrl: true,
        createdAt: true,
        receivedReviews: {
          select: {
            id: true,
            rating: true,
            content: true,
            tags: true,
            createdAt: true,
            reviewer: {
              select: { id: true, name: true, profileImage: true },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    const avgRating = user.receivedReviews.length > 0
      ? user.receivedReviews.reduce((sum, r) => sum + r.rating, 0) / user.receivedReviews.length
      : null;

    // The public portfolio and career lists, exactly as `GET /:id/portfolio` and `GET /:id/careers`
    // return them.
    const [portfolioItems, { careers, careerSummary }] = await Promise.all([
      listPortfolioItems(user.id),
      listCareers(user.id),
    ]);

    res.json({
      ...user,
      avgRating,
      reviewCount: user.receivedReviews.length,
      portfolioItems,
      careers,
      careerSummary,
    });
  } catch (err) {
    next(err);
  }
}

export async function getMyApplications(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (req.user.role !== 'FREELANCER') {
      throw new AppError('Only freelancers can view their applications', 403);
    }

    await closeExpiredOpenProjects();
    await rejectPendingApplicationsForClosedProjects({ freelancerId: req.user.id });

    const applications = await prisma.application.findMany({
      where: { freelancerId: req.user.id },
      include: {
        contract: { select: { id: true, status: true } },
        project: {
          select: {
            id: true,
            title: true,
            category: true,
            budget: true,
            status: true,
            deadline: true,
            client: { select: { id: true, name: true, companyName: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(applications);
  } catch (err) {
    next(err);
  }
}

export async function getMyBookmarks(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (req.user.role !== 'FREELANCER') {
      throw new AppError('Only freelancers can view their bookmarks', 403);
    }

    const bookmarks = await prisma.projectBookmark.findMany({
      where: {
        userId: req.user.id,
        project: { deletedAt: null },
      },
      include: {
        project: {
          include: {
            client: { select: { id: true, name: true, companyName: true, profileImage: true } },
            _count: { select: { applications: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(bookmarks.map((bookmark) => ({
      ...bookmark.project,
      isBookmarked: true,
      bookmarkedAt: bookmark.createdAt,
    })));
  } catch (err) {
    next(err);
  }
}

export async function getMyProjects(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (req.user.role !== 'CLIENT') {
      throw new AppError('Only clients can view their projects', 403);
    }

    await closeExpiredOpenProjects();

    const projects = await prisma.project.findMany({
      where: { clientId: req.user.id, deletedAt: null },
      include: {
        _count: { select: { applications: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(projects);
  } catch (err) {
    next(err);
  }
}
