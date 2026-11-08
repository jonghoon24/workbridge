'use client';

import Link from 'next/link';
import Button from '@/components/ui/Button';
import MilestoneStatusBadge from '@/components/milestones/MilestoneStatusBadge';
import PayoutPreview from '@/components/milestones/PayoutPreview';
import { formatDate, formatDateTime, formatKRW, formatRemaining } from '@/lib/format';
import { PAYMENT_STATUS_LABELS } from '@/constants/milestones';

// 계약 페이지의 마일스톤 한 줄. 행동 버튼은 상태와 역할로 정한다.
// - 의뢰인: 결제(순서상 다음 PENDING만, M13), 검수 대기면 승인/수정 요청
// - 프리랜서: FUNDED/REVISION_REQUESTED면 제출(상세 페이지의 제출 폼으로 이동)
export default function MilestoneCard({
  milestone,
  contractId,
  isClient,
  isFreelancer,
  canFund,
  busy,
  onApprove,
  onReject,
}) {
  const detailHref = `/contracts/${contractId}/milestones/${milestone.id}`;
  const canSubmit = isFreelancer && ['FUNDED', 'REVISION_REQUESTED'].includes(milestone.status);
  const canReview = isClient && milestone.status === 'SUBMITTED';
  const remaining = milestone.status === 'SUBMITTED' ? formatRemaining(milestone.autoApproveAt) : null;
  const overdue = ['FUNDED', 'REVISION_REQUESTED'].includes(milestone.status)
    && new Date(milestone.dueDate).getTime() < Date.now();

  return (
    <div data-testid="milestone-card" className="rounded-lg border border-gray-200 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-gray-400">#{milestone.sequence}</span>
            <Link href={detailHref} className="font-medium text-gray-900 hover:text-primary-600">
              {milestone.title}
            </Link>
            <MilestoneStatusBadge status={milestone.status} approvalType={milestone.approvalType} />
            {milestone.revisionCount > 0 && (
              <span className="text-xs text-gray-500">수정 요청 {milestone.revisionCount}회</span>
            )}
          </div>
          {milestone.description && (
            <p className="mt-1 text-sm text-gray-600 line-clamp-2">{milestone.description}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-500">
            <span className="font-medium text-gray-900">{formatKRW(milestone.amount)}</span>
            <span className={overdue ? 'text-red-600 font-medium' : ''}>
              기한 {formatDate(milestone.dueDate)}{overdue ? ' (지남)' : ''}
            </span>
            {milestone.payment && (
              <span>{PAYMENT_STATUS_LABELS[milestone.payment.status] || milestone.payment.status}</span>
            )}
            {milestone.approvedAt && <span>승인 {formatDate(milestone.approvedAt)}</span>}
          </div>
          {milestone.status === 'SUBMITTED' && (
            <p className="mt-2 text-xs text-purple-700">
              {milestone.submittedAt && `${formatDateTime(milestone.submittedAt)} 제출 · `}
              {remaining ? `자동 승인까지 ${remaining}` : '자동 승인 처리 대기 중'}
            </p>
          )}
          {milestone.status === 'REVISION_REQUESTED' && milestone.latestSubmission?.decisionReason && (
            <p className="mt-2 text-xs text-orange-700 line-clamp-2">
              수정 요청 사항: {milestone.latestSubmission.decisionReason}
            </p>
          )}
          {isFreelancer && milestone.payoutPreview && (
            <div className="mt-2">
              <PayoutPreview preview={milestone.payoutPreview} compact />
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2 sm:justify-end sm:flex-nowrap">
          {isClient && canFund && (
            <Link href={`/payments/${milestone.id}`}>
              <Button size="sm">결제하기</Button>
            </Link>
          )}
          {canSubmit && (
            <Link href={`${detailHref}#submission-form`}>
              <Button size="sm">
                {milestone.status === 'REVISION_REQUESTED' ? '재제출하기' : '제출하기'}
              </Button>
            </Link>
          )}
          {canReview && (
            <>
              <Button size="sm" onClick={() => onApprove?.(milestone)} loading={busy}>승인</Button>
              <Button size="sm" variant="secondary" onClick={() => onReject?.(milestone)} disabled={busy}>
                수정 요청
              </Button>
            </>
          )}
          <Link href={detailHref}>
            <Button size="sm" variant="ghost">상세</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
