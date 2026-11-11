import type { Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { ACCOUNT_INACTIVE } from '../lib/locks';
import { enqueueJob } from '../jobs/queue';
import {
  closeExpiredOpenProjects,
  rejectPendingApplicationsForClosedProjects,
} from '../lib/projectLifecycle';
import { uploadToSupabase } from '../middlewares/upload';
import { listCareers } from './careers.service';
import { listPortfolioItems } from './portfolio.service';
import type { ProfileUpdateInput } from '../schemas/users';

/**
 * Profiles and the caller's own lists on `/api/users` (`/me`, `/:id`, `/me/applications`,
 * `/me/bookmarks`, `/me/projects`). The payout account, portfolio/careers and bookmark ids have
 * their own services.
 */

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

/** `GET /me`. Writes nothing. */
export async function getMyProfile(userId: string) {
  // `findFirst`, not `findUnique`: a soft-deleted user holding a still-valid access token
  // must not be able to read their profile. `deletedAt` is not part of a unique constraint.
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: myProfileSelect,
  });

  if (!user) {
    throw new AppError('User not found', 404);
  }

  return toMyProfile(user);
}

/**
 * `PATCH /me`. `fields` was parsed by the caller's role's schema (`profileUpdateBodyByRole`): only
 * that role's fields are present, already typed, and absent fields stay absent. `image` is the
 * optional `profileImage` upload.
 */
export async function updateMyProfile(
  userId: string,
  fields: ProfileUpdateInput,
  image: Express.Multer.File | undefined,
) {
  let profileImage: string | undefined;
  if (image) {
    const filename = `${userId}-${uuidv4()}.${image.mimetype.split('/')[1]}`;
    profileImage = await uploadToSupabase(image.buffer, image.mimetype, filename);
  }

  const updateData: Prisma.UserUpdateManyMutationInput = { ...fields };
  if (profileImage) updateData.profileImage = profileImage;

  // Only while the account is active: a withdrawal that committed after `requireActiveUser` (while
  // the image uploaded) must not get its profile written back. Its just-uploaded image goes to the
  // withdrawal's file cleanup, which finds profile images by the user id in their names.
  // An empty patch (every field stripped as the other role's) writes nothing: Prisma skips an
  // `updateMany` without data and reports 0 rows, so check the account instead.
  const active = { id: userId, deletedAt: null };
  const refuseInactive = async () => {
    if (profileImage) {
      await enqueueJob(prisma, { type: 'account.deletePublicFiles', payload: { userId, paths: [] } });
    }
    return new AppError(ACCOUNT_INACTIVE, 401);
  };

  const count = Object.keys(updateData).length
    ? (await prisma.user.updateMany({ where: active, data: updateData })).count
    : await prisma.user.count({ where: active });
  if (count === 0) {
    throw await refuseInactive();
  }

  // Read back under the same condition: a withdrawal that commits between the write and this read
  // has scrubbed the profile, and the caller gets the same 401 rather than the scrubbed row.
  const user = await prisma.user.findFirst({ where: active, select: myProfileSelect });
  if (!user) {
    throw await refuseInactive();
  }

  return toMyProfile(user);
}

/**
 * `GET /:id`, the public profile: the user with received reviews, rating average, portfolio and
 * careers. Soft-deleted users must not remain publicly visible. Writes nothing.
 */
export async function getPublicProfile(userId: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
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

  return {
    ...user,
    avgRating,
    reviewCount: user.receivedReviews.length,
    portfolioItems,
    careers,
    careerSummary,
  };
}

/**
 * `GET /me/applications`, newest first. **Writes rows** before reading: the lazy lifecycle sweep
 * closes expired open projects and rejects this freelancer's pending applications to closed ones.
 *
 * An application to a soft-deleted project is left out, as the project and its contract are gone
 * (docs/domain/README.md "소프트 삭제"). One to a project whose client is soft-deleted is left out
 * like that project is everywhere else — unless it became a contract: a relationship already made
 * stays visible to its party, as in the contract list.
 */
export async function listMyApplications(freelancerId: string) {
  await closeExpiredOpenProjects();
  await rejectPendingApplicationsForClosedProjects({ freelancerId });

  return prisma.application.findMany({
    where: {
      freelancerId,
      project: { deletedAt: null },
      OR: [{ project: { client: { deletedAt: null } } }, { contract: { isNot: null } }],
    },
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
}

/** `GET /me/bookmarks`: the bookmarked projects, newest bookmark first. Writes nothing. */
export async function listMyBookmarks(userId: string) {
  // A project whose client is soft-deleted is gone like a deleted project (docs/domain/README.md
  // "소프트 삭제": the joined owner too), as in the public list and detail.
  const bookmarks = await prisma.projectBookmark.findMany({
    where: {
      userId,
      project: { deletedAt: null, client: { deletedAt: null } },
    },
    include: {
      project: {
        include: {
          client: { select: { id: true, name: true, companyName: true, profileImage: true } },
          _count: { select: { applications: true } },
        },
      },
    },
    // The same order as `listBookmarkedProjectIds`, so the two never disagree on equal timestamps.
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });

  return bookmarks.map((bookmark) => ({
    ...bookmark.project,
    isBookmarked: true,
    bookmarkedAt: bookmark.createdAt,
  }));
}

/**
 * `GET /me/projects`, newest first. **Writes rows** before reading: the lazy lifecycle sweep
 * closes expired open projects.
 */
export async function listMyProjects(clientId: string) {
  await closeExpiredOpenProjects();

  return prisma.project.findMany({
    where: { clientId, deletedAt: null },
    include: {
      _count: { select: { applications: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}
