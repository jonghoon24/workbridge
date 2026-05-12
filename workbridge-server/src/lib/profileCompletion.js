export function isProfileComplete(user) {
  if (!user) return false;

  if (user.role === 'CLIENT') {
    return Boolean(user.companyName?.trim() && user.businessField?.trim());
  }

  if (user.role === 'FREELANCER') {
    return Boolean(
      Array.isArray(user.skills)
      && user.skills.length > 0
      && user.activityCategory?.trim()
      && Number.isInteger(user.experienceYears)
      && user.experienceYears >= 0
      && Number.isFinite(user.hourlyRate)
      && user.hourlyRate > 0
    );
  }

  return false;
}
