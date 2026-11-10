// 프로필 완성도 항목의 한국어 라벨과 채우러 갈 곳. 서버는 key만 준다.
export const COMPLETION_ITEMS = {
  skills: { label: '기술 스택', href: '/profile#profile-form' },
  activityCategory: { label: '활동 카테고리', href: '/profile#profile-form' },
  experienceYears: { label: '경력 연수', href: '/profile#profile-form' },
  hourlyRate: { label: '시간당 단가', href: '/profile#profile-form' },
  bio: { label: '자기소개', href: '/profile#profile-form' },
  profileImage: { label: '프로필 이미지', href: '/profile#profile-form' },
  portfolio: { label: '포트폴리오 1개 이상', href: '/profile/portfolio' },
  portfolioThree: { label: '포트폴리오 3개 이상', href: '/profile/portfolio' },
  career: { label: '경력 1개 이상', href: '/profile/careers' },
  payoutAccount: { label: '지급 계좌', href: '/settlements/account' },
  companyName: { label: '회사명', href: '/profile#profile-form' },
  businessField: { label: '사업 분야', href: '/profile#profile-form' },
  website: { label: '웹사이트', href: '/profile#profile-form' },
};

export function completionLabel(key) {
  return COMPLETION_ITEMS[key]?.label || key;
}
