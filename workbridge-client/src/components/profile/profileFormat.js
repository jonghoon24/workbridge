// 포트폴리오·경력 화면의 표시 헬퍼와 서버 오류 번역.
import { kstToday } from '@/lib/format';
import { toUserMessage } from '@/lib/errorMessages';

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

// 포트폴리오·경력 화면에서만 다르게 안내할 서버 오류. 나머지(PF1–PF15, 업로드)는 공용 변환표가 맡는다.
const SERVER_ERROR_MESSAGES = {
  'File too large (max 5MB)': '이미지는 5MB 이하만 올릴 수 있습니다.',
  'File upload failed': '이미지 업로드에 실패했습니다. 잠시 후 다시 시도해 주세요.',
  'Insufficient permissions': '프리랜서 회원만 이용할 수 있습니다.',
};

export function describeProfileError(err, fallback) {
  return toUserMessage(err, fallback, {
    messages: SERVER_ERROR_MESSAGES,
    patterns: [[/^Unsupported file type/, '이미지 파일만 올릴 수 있습니다.']],
  });
}
