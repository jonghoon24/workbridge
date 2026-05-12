export function isProfileComplete(user) {
  if (!user) return false;

  if (user.role === 'CLIENT') {
    return Boolean(user.companyName?.trim() && user.businessField?.trim());
  }

  if (user.role === 'FREELANCER') {
    const hasExperienceYears = user.experienceYears !== null
      && user.experienceYears !== undefined
      && user.experienceYears !== '';
    const hasHourlyRate = user.hourlyRate !== null
      && user.hourlyRate !== undefined
      && user.hourlyRate !== '';

    return Boolean(
      Array.isArray(user.skills)
      && user.skills.length > 0
      && user.activityCategory?.trim()
      && hasExperienceYears
      && Number.isInteger(Number(user.experienceYears))
      && Number(user.experienceYears) >= 0
      && hasHourlyRate
      && Number.isFinite(Number(user.hourlyRate))
      && Number(user.hourlyRate) > 0
    );
  }

  return false;
}

export function getProfileCompletionMessage(role) {
  if (role === 'CLIENT') {
    return '프로젝트를 등록하려면 회사명과 사업 분야를 먼저 입력해주세요.';
  }

  if (role === 'FREELANCER') {
    return '프로젝트에 지원하려면 기술 스택, 활동 카테고리, 경력, 시간당 단가를 먼저 입력해주세요.';
  }

  return '프로필을 먼저 완성해주세요.';
}
