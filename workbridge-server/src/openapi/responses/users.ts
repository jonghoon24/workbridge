import { z } from '../../lib/zod';
import { count, dateTime, id, roleEnum, won } from './common';
import { career, careerSummary, portfolioItem } from './profile';

/** Profile fields both `GET /me` and the public profile select (`users.controller.ts`). */
const profileFields = {
  id,
  name: z.string(),
  role: roleEnum,
  profileImage: z.string().nullable(),
  bio: z.string().nullable(),
  companyName: z.string().nullable(),
  businessField: z.string().nullable(),
  website: z.string().nullable(),
  skills: z.array(z.string()),
  activityCategory: z.string().nullable(),
  experienceYears: z.number().int().nullable(),
  hourlyRate: won.nullable(),
  portfolioUrl: z.string().nullable(),
  createdAt: dateTime,
};

/** `GET`/`PATCH /api/users/me`. */
export const myProfile = z.object({ ...profileFields, email: z.string() }).openapi('MyProfile');

/** `GET /api/users/:id` — no email; received reviews, rating, portfolio and careers. */
export const publicProfile = z
  .object({
    ...profileFields,
    receivedReviews: z.array(
      z.object({
        id,
        rating: z.number().int().min(1).max(5),
        content: z.string(),
        tags: z.array(z.string()),
        createdAt: dateTime,
        reviewer: z.object({ id, name: z.string(), profileImage: z.string().nullable() }),
      }),
    ),
    avgRating: z.number().nullable().openapi({ description: '받은 리뷰 평점의 평균. 리뷰가 없으면 `null`' }),
    reviewCount: count,
    portfolioItems: z.array(portfolioItem),
    careers: z.array(career),
    careerSummary,
  })
  .openapi('PublicProfile');

/** Never the full account number. */
export const payoutAccount = z
  .object({
    bankCode: z.string().openapi({ example: '088' }),
    bankName: z.string().openapi({ example: '신한' }),
    accountNumberMasked: z.string().openapi({ example: '********6789' }),
    holderName: z.string(),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .openapi('PayoutAccount');

export const payoutAccountBody = z.object({ payoutAccount: payoutAccount.nullable() });
export const payoutAccountPutBody = z.object({
  payoutAccount,
  rescheduledCount: count.openapi({ description: '다시 예약된 보류(`ON_HOLD`) 정산 수' }),
});
export const payoutAccountDeletedBody = z.object({ payoutAccount: z.null() });
