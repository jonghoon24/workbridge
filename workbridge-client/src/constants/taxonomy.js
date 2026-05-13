export const PROJECT_CATEGORIES = ['웹 개발', '모바일 앱', '디자인', 'AI/ML', '데이터 분석', '마케팅', '기타'];

export const SKILL_OPTIONS = [
  'React',
  'Next.js',
  'Node.js',
  'Express',
  'TypeScript',
  'JavaScript',
  'Python',
  'FastAPI',
  'Java',
  'Spring Boot',
  'React Native',
  'Flutter',
  'Swift',
  'Dart',
  'Firebase',
  'SQL',
  'Prisma',
  'AWS',
  'Docker',
  'Kubernetes',
  'Redis',
  'OpenAI API',
  'TensorFlow',
  'PyTorch',
  'Pandas',
  'Chart.js',
  'FFmpeg',
  'HealthKit',
  'Figma',
  'Illustrator',
  'Photoshop',
  'Branding',
  'GA4',
  'Meta Ads',
  'Google Ads',
  'Mailchimp',
  'Tailwind CSS',
  'Framer Motion',
];

const SKILL_ALIASES = {
  PostgreSQL: 'SQL',
  MySQL: 'SQL',
  'AWS S3': 'AWS',
};

export const FREELANCER_ACTIVITY_CATEGORIES = [
  '웹 개발',
  '모바일 앱',
  '디자인',
  'AI/ML',
  '데이터 분석',
  '마케팅',
  '콘텐츠 제작',
  '기타',
];

export const BUSINESS_FIELD_OPTIONS = [
  'IT/소프트웨어',
  '마케팅/광고',
  '교육/에듀테크',
  '이커머스',
  '헬스케어',
  '금융/핀테크',
  '문화/콘텐츠',
  '제조/하드웨어',
  '기타',
];

export function splitOptionList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function normalizeSkill(skill) {
  return SKILL_ALIASES[skill] || skill;
}

export function normalizeSkillList(value) {
  const normalized = splitOptionList(value).map(normalizeSkill);
  return [...new Set(normalized)];
}

export function resolvePreset(value, options) {
  if (!value) return '';
  return options.includes(value) ? value : '기타';
}

export function resolveOtherValue(value, options) {
  if (!value || options.includes(value)) return '';
  return value;
}
