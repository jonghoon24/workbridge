import prisma from './prisma';
import type {
  ProfileCompletion,
  ProfileCompletionCounts,
  ProfileCompletionInput,
  ProfileScoreInput,
} from '../types/index';

export function isProfileComplete(user: ProfileCompletionInput | null): boolean {
  if (!user) return false;

  if (user.role === 'CLIENT') {
    return Boolean(user.companyName?.trim() && user.businessField?.trim());
  }

  if (user.role === 'FREELANCER') {
    // The `typeof` guards are redundant at runtime — `Number.isInteger` and
    // `Number.isFinite` already imply a number, and neither coerces — but they give
    // TypeScript the narrowing it needs for the comparisons that follow.
    return Boolean(
      Array.isArray(user.skills)
      && user.skills.length > 0
      && user.activityCategory?.trim()
      && typeof user.experienceYears === 'number'
      && Number.isInteger(user.experienceYears)
      && user.experienceYears >= 0
      && typeof user.hourlyRate === 'number'
      && Number.isFinite(user.hourlyRate)
      && user.hourlyRate > 0
    );
  }

  return false;
}

// ---------------------------------------------------------------------------------------------
// Completion score (docs/domain/accounts.md). Display only: `isProfileComplete` above stays the gate.
// ---------------------------------------------------------------------------------------------

/** Not null and not empty after trimming. */
function isNonBlank(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

type ScoreRule = {
  key: string;
  weight: number;
  done(user: ProfileScoreInput, counts: ProfileCompletionCounts): boolean;
};

/** The completion checklists, in response order. Each role's weights sum to 100. */
export const PROFILE_SCORE_RULES: Record<'CLIENT' | 'FREELANCER', readonly ScoreRule[]> = {
  FREELANCER: [
    { key: 'skills', weight: 15, done: (u) => Array.isArray(u.skills) && u.skills.length > 0 },
    { key: 'activityCategory', weight: 10, done: (u) => isNonBlank(u.activityCategory) },
    {
      key: 'experienceYears',
      weight: 10,
      done: (u) => typeof u.experienceYears === 'number' && Number.isInteger(u.experienceYears) && u.experienceYears >= 0,
    },
    {
      key: 'hourlyRate',
      weight: 10,
      done: (u) => typeof u.hourlyRate === 'number' && Number.isFinite(u.hourlyRate) && u.hourlyRate > 0,
    },
    { key: 'bio', weight: 10, done: (u) => isNonBlank(u.bio) },
    { key: 'profileImage', weight: 10, done: (u) => isNonBlank(u.profileImage) },
    { key: 'portfolio', weight: 15, done: (_u, c) => c.portfolioItems >= 1 },
    { key: 'portfolioThree', weight: 5, done: (_u, c) => c.portfolioItems >= 3 },
    { key: 'career', weight: 10, done: (_u, c) => c.careers >= 1 },
    { key: 'payoutAccount', weight: 5, done: (_u, c) => c.hasPayoutAccount },
  ],
  CLIENT: [
    { key: 'companyName', weight: 25, done: (u) => isNonBlank(u.companyName) },
    { key: 'businessField', weight: 25, done: (u) => isNonBlank(u.businessField) },
    { key: 'bio', weight: 15, done: (u) => isNonBlank(u.bio) },
    { key: 'profileImage', weight: 15, done: (u) => isNonBlank(u.profileImage) },
    { key: 'website', weight: 20, done: (u) => isNonBlank(u.website) },
  ],
};

/**
 * `{ isComplete, percent, items }` for the user's **stored** role. `isComplete` is exactly
 * `isProfileComplete` (the gate); `percent` is the weight of the done items. The two are independent.
 */
export function getProfileCompletion(user: ProfileScoreInput, counts: ProfileCompletionCounts): ProfileCompletion {
  const rules = PROFILE_SCORE_RULES[user.role as 'CLIENT' | 'FREELANCER'] ?? [];
  const items = rules.map((rule) => ({ key: rule.key, weight: rule.weight, done: rule.done(user, counts) }));

  return {
    isComplete: isProfileComplete(user),
    percent: items.reduce((sum, item) => sum + (item.done ? item.weight : 0), 0),
    items,
  };
}

/** Loads what the completion score needs for `userId` and scores it. `null` when the user is gone. */
export async function loadProfileCompletion(userId: string): Promise<ProfileCompletion | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      role: true,
      companyName: true,
      businessField: true,
      skills: true,
      activityCategory: true,
      experienceYears: true,
      hourlyRate: true,
      bio: true,
      profileImage: true,
      website: true,
      _count: { select: { portfolioItems: true, careers: true } },
      payoutAccount: { select: { userId: true } },
    },
  });
  if (!user) return null;

  const { _count, payoutAccount, ...profile } = user;
  return getProfileCompletion(profile, {
    portfolioItems: _count.portfolioItems,
    careers: _count.careers,
    hasPayoutAccount: payoutAccount !== null,
  });
}
