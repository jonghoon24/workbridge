'use client';

// 상태 배지 팔레트. 의미별 색(tone)을 한 곳에서 정하고, 지원·프로젝트·계약·마일스톤·정산 배지가 모두 이것을 쓴다.
// green=진행 가능/완료됨, blue=진행 중, amber=대기·검토, purple=예정·검수, orange=수정 필요, red=실패·거절, gray=종료.
export const TONES = {
  gray: { pill: 'bg-gray-100 text-gray-700 ring-gray-500/15', dot: 'bg-gray-400' },
  blue: { pill: 'bg-blue-50 text-blue-700 ring-blue-600/20', dot: 'bg-blue-500' },
  green: { pill: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', dot: 'bg-emerald-500' },
  amber: { pill: 'bg-amber-50 text-amber-800 ring-amber-600/25', dot: 'bg-amber-500' },
  purple: { pill: 'bg-violet-50 text-violet-700 ring-violet-600/20', dot: 'bg-violet-500' },
  orange: { pill: 'bg-orange-50 text-orange-700 ring-orange-600/20', dot: 'bg-orange-500' },
  red: { pill: 'bg-red-50 text-red-700 ring-red-600/20', dot: 'bg-red-500' },
  primary: { pill: 'bg-primary-50 text-primary-700 ring-primary-600/20', dot: 'bg-primary-500' },
};

export function StatusPill({ tone = 'gray', dot = true, className = '', children }) {
  const t = TONES[tone] || TONES.gray;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${t.pill} ${className}`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} aria-hidden="true" />}
      {children}
    </span>
  );
}

const variantTones = {
  UPCOMING: 'purple',
  OPEN: 'green',
  IN_PROGRESS: 'blue',
  COMPLETED: 'gray',
  CANCELLED: 'red',
  CLOSED: 'gray',
  PENDING: 'amber',
  ACCEPTED: 'green',
  REJECTED: 'red',
  ACTIVE: 'blue',
  FAILED: 'red',
  REFUNDED: 'gray',
};

const statusLabels = {
  UPCOMING: '모집 예정',
  OPEN: '모집 중',
  IN_PROGRESS: '진행 중',
  COMPLETED: '완료',
  CANCELLED: '취소',
  CLOSED: '모집 마감',
  PENDING: '검토 중',
  ACCEPTED: '수락됨',
  REJECTED: '거절됨',
  ACTIVE: '진행 중',
  FAILED: '실패',
  REFUNDED: '환불됨',
};

export default function Badge({ children, variant = 'default', className = '' }) {
  const label = statusLabels[children] || children;
  return (
    <StatusPill tone={variantTones[variant] || 'gray'} className={className}>
      {label}
    </StatusPill>
  );
}
