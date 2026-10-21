'use client';

const styles = {
  SCHEDULED: 'bg-blue-100 text-blue-800',
  PROCESSING: 'bg-purple-100 text-purple-800',
  PAID: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-100 text-red-800',
  ON_HOLD: 'bg-yellow-100 text-yellow-800',
};

export const SETTLEMENT_STATUS_LABELS = {
  SCHEDULED: '지급 예정',
  PROCESSING: '지급 처리 중',
  PAID: '지급 완료',
  FAILED: '지급 실패',
  ON_HOLD: '지급 보류',
};

// 지급 시도는 최대 3회(M22). 남은 시도가 있는 FAILED는 재시도 대기다.
const MAX_PAYOUT_ATTEMPTS = 3;

export default function SettlementStatusBadge({ status, payoutAttempts, className = '' }) {
  const label = status === 'FAILED' && payoutAttempts !== undefined && payoutAttempts < MAX_PAYOUT_ATTEMPTS
    ? '재시도 대기'
    : SETTLEMENT_STATUS_LABELS[status] || status;

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
        styles[status] || 'bg-gray-100 text-gray-700'
      } ${className}`}
    >
      {label}
    </span>
  );
}
