'use client';

import { MILESTONE_STATUS_LABELS } from '@/constants/milestones';
import { StatusPill } from '@/components/ui/Badge';

// 기존 Badge는 PENDING을 '검토중'(지원서)으로 보여주므로 마일스톤 상태는 따로 둔다.
const tones = {
  PENDING: 'gray',
  FUNDED: 'blue',
  SUBMITTED: 'purple',
  REVISION_REQUESTED: 'orange',
  APPROVED: 'green',
};


export default function MilestoneStatusBadge({ status, approvalType, className = '' }) {
  const label = status === 'APPROVED' && approvalType === 'AUTO'
    ? '자동 승인'
    : MILESTONE_STATUS_LABELS[status] || status;

  return (
    <StatusPill tone={tones[status] || 'gray'} className={className}>
      {label}
    </StatusPill>
  );
}
