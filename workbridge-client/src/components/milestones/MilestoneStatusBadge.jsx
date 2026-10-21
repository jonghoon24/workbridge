'use client';

import { MILESTONE_STATUS_LABELS } from '@/constants/milestones';

// 기존 Badge는 PENDING을 '검토중'(지원서)으로 보여주므로 마일스톤 상태는 따로 둔다.
const styles = {
  PENDING: 'bg-gray-100 text-gray-700',
  FUNDED: 'bg-blue-100 text-blue-800',
  SUBMITTED: 'bg-purple-100 text-purple-800',
  REVISION_REQUESTED: 'bg-orange-100 text-orange-800',
  APPROVED: 'bg-green-100 text-green-800',
};


export default function MilestoneStatusBadge({ status, approvalType, className = '' }) {
  const label = status === 'APPROVED' && approvalType === 'AUTO'
    ? '자동 승인'
    : MILESTONE_STATUS_LABELS[status] || status;

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
