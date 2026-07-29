import type { ProfileCompletionInput } from '../types/index.js';

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
