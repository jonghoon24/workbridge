'use client';

import { MAX_PAYOUT_ATTEMPTS, SETTLEMENT_STATUS_LABELS } from '@/constants/milestones';
import { StatusPill } from '@/components/ui/Badge';

const tones = {
  SCHEDULED: 'blue',
  PROCESSING: 'purple',
  PAID: 'green',
  FAILED: 'red',
  ON_HOLD: 'amber',
};


export default function SettlementStatusBadge({ status, payoutAttempts, className = '' }) {
  const label = status === 'FAILED' && payoutAttempts !== undefined && payoutAttempts < MAX_PAYOUT_ATTEMPTS
    ? '재시도 대기'
    : SETTLEMENT_STATUS_LABELS[status] || status;

  return (
    <StatusPill tone={tones[status] || 'gray'} className={className}>
      {label}
    </StatusPill>
  );
}
