// 포트폴리오·경력 화면의 표시 헬퍼와 서버 오류 번역.
import { kstToday } from '@/lib/format';
import { describeServerError } from '@/lib/serverErrors';

// 서버가 "이번 달"을 KST로 판정하므로(BEHAVIOR.md PF2) 월 입력의 max도 KST 기준이다.
export function currentKstMonth() {
  return kstToday().slice(0, 7);
}

// '2025-03' → '2025.03'
export function formatMonth(month) {
  return month ? month.replace('-', '.') : '';
}

// 포트폴리오: 시작만 있으면 '2025.03 ~', 둘 다 없으면 ''.
// 경력: endDate가 null이면 재직 중.
export function formatPeriod(start, end, { current = false } = {}) {
  if (!start) return '';
  if (current) return `${formatMonth(start)} ~ 재직 중`;
  if (!end) return `${formatMonth(start)} ~`;
  return start === end ? formatMonth(start) : `${formatMonth(start)} ~ ${formatMonth(end)}`;
}

export function formatCareerSummary(summary) {
  if (!summary || summary.totalMonths === 0) return '경력 없음';
  const parts = [];
  if (summary.years > 0) parts.push(`${summary.years}년`);
  if (summary.months > 0) parts.push(`${summary.months}개월`);
  return `총 경력 ${parts.join(' ')}`;
}

export const EMPLOYMENT_TYPES = [
  { value: 'FULL_TIME', label: '정규직' },
  { value: 'CONTRACT', label: '계약직' },
  { value: 'FREELANCE', label: '프리랜서' },
  { value: 'INTERN', label: '인턴' },
];

export function employmentTypeLabel(value) {
  return EMPLOYMENT_TYPES.find((type) => type.value === value)?.label || value;
}

// BEHAVIOR.md PF1–PF15, RC6, 업로드 정책(규칙 12)의 예측 가능한 오류. 서버 메시지는
// `<필드>: <메시지>` 형식이라 접두어를 떼고 비교한다. 나머지는 서버 문구를 그대로 보여준다.
const SERVER_ERROR_MESSAGES = {
  'Portfolio is limited to 20 items': '포트폴리오는 최대 20개까지 등록할 수 있습니다.',
  'Careers are limited to 30 entries': '경력은 최대 30개까지 등록할 수 있습니다.',
  'Must list each of your portfolio items exactly once': '다른 곳에서 포트폴리오가 바뀌었습니다. 새로고침한 뒤 다시 시도해주세요.',
  'Portfolio item not found': '이미 삭제된 포트폴리오입니다.',
  'Career not found': '이미 삭제된 경력입니다.',
  'Title is required': '제목을 입력해주세요.',
  'Title must be at most 100 characters': '제목은 100자 이하로 입력해주세요.',
  'Description must be at most 2000 characters': '설명은 2,000자 이하로 입력해주세요.',
  'URL must be an http or https URL': '링크는 http:// 또는 https://로 시작하는 주소여야 합니다.',
  'Role must be at most 100 characters': '역할은 100자 이하로 입력해주세요.',
  'At most 10 skills are allowed': '기술은 최대 10개까지 선택할 수 있습니다.',
  'Each skill must be at most 50 characters': '기술 이름은 50자 이하여야 합니다.',
  'Month must be a YYYY-MM month': '연월 형식이 올바르지 않습니다.',
  'Month cannot be in the future': '이번 달 이후는 선택할 수 없습니다.',
  'End month must not be before start month': '종료 월은 시작 월보다 빠를 수 없습니다.',
  'Start month is required with an end month': '종료 월을 입력하려면 시작 월도 입력해주세요.',
  'Company is required': '회사명을 입력해주세요.',
  'Company must be at most 100 characters': '회사명은 100자 이하로 입력해주세요.',
  'Position is required': '직책을 입력해주세요.',
  'Position must be at most 100 characters': '직책은 100자 이하로 입력해주세요.',
  'Cannot upload and remove an image at once': '이미지 교체와 삭제를 동시에 할 수 없습니다.',
  'File too large (max 5MB)': '이미지는 5MB 이하만 올릴 수 있습니다.',
  'File upload failed': '이미지 업로드에 실패했습니다. 잠시 후 다시 시도해주세요.',
  'Insufficient permissions': '프리랜서 회원만 이용할 수 있습니다.',
};

export function describeProfileError(err, fallback) {
  return describeServerError(err, fallback, {
    messages: SERVER_ERROR_MESSAGES,
    patterns: [[/^Unsupported file type/, '이미지 파일만 올릴 수 있습니다.']],
  });
}
