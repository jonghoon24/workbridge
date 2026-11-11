'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/Badge';
import MilestoneStatusBadge from '@/components/milestones/MilestoneStatusBadge';
import PayoutPreview from '@/components/milestones/PayoutPreview';
import RejectModal from '@/components/milestones/RejectModal';
import SubmissionForm from '@/components/milestones/SubmissionForm';
import SubmissionHistory from '@/components/milestones/SubmissionHistory';
import { formatDate, formatDateTime, formatKRW, formatRemaining } from '@/lib/format';
import { PAYMENT_STATUS_LABELS } from '@/constants/milestones';
import PageLoader from '@/components/ui/PageLoader';
import EmptyState from '@/components/ui/EmptyState';
import { toUserMessage } from '@/lib/errorMessages';

export default function MilestoneDetailPage() {
  const { id: contractId, milestoneId } = useParams();
  const { user } = useAuthStore();
  const [milestone, setMilestone] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [approving, setApproving] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);

  const loadMilestone = useCallback(
    () => api.get(`/api/milestones/${milestoneId}`).then(({ data }) => setMilestone(data)),
    [milestoneId]
  );

  useEffect(() => {
    useAuthStore.getState().initAuth();
    loadMilestone()
      .catch((err) => {
        setLoadError(toUserMessage(err, '마일스톤을 불러오지 못했습니다.'));
      })
      .finally(() => setLoading(false));
  }, [loadMilestone]);

  // 알림·계약 카드의 `#submission-form` 링크는 폼이 데이터 로드 뒤에 그려지므로 직접 스크롤한다.
  useEffect(() => {
    if (!milestone || typeof window === 'undefined' || window.location.hash !== '#submission-form') return;
    document.getElementById('submission-form')?.scrollIntoView({ behavior: 'smooth' });
  }, [milestone]);

  async function handleApprove() {
    if (!confirm('이 마일스톤을 승인하시겠습니까?\n승인하면 대금이 프리랜서 정산 대상으로 확정되며 되돌릴 수 없습니다.')) {
      return;
    }
    setApproving(true);
    setActionError('');
    try {
      const { data } = await api.post(`/api/milestones/${milestoneId}/approve`);
      setNotice(data.contract?.status === 'COMPLETED'
        ? '마일스톤을 승인했습니다. 모든 마일스톤이 승인되어 계약이 완료되었습니다.'
        : '마일스톤을 승인했습니다.');
      await loadMilestone();
    } catch (err) {
      setActionError(toUserMessage(err, '승인에 실패했습니다.'));
    } finally {
      setApproving(false);
    }
  }

  async function handleReject(reason) {
    await api.post(`/api/milestones/${milestoneId}/reject`, { reason });
    setRejectOpen(false);
    setNotice('수정을 요청했습니다. 프리랜서가 재제출하면 다시 검수할 수 있습니다.');
    await loadMilestone().catch(() => {});
  }

  async function handleSubmitted() {
    setNotice('결과물을 제출했습니다. 의뢰인이 검수 기한까지 검수하지 않으면 자동으로 승인됩니다.');
    await loadMilestone().catch(() => {});
  }

  if (loading) return <PageLoader />;

  if (loadError || !milestone) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        <EmptyState
          tone="error"
          title={loadError || '마일스톤을 찾을 수 없습니다.'}
          action={(
            <Link href={`/contracts/${contractId}`} className="text-primary-600 hover:text-primary-700 font-semibold">
              계약서로 돌아가기 →
            </Link>
          )}
        />
      </div>
    );
  }

  const contract = milestone.contract || {};
  const currentUser = user || useAuthStore.getState().user;
  const isClient = currentUser?.id === contract.clientId;
  const isFreelancer = currentUser?.id === contract.freelancerId;
  const canSubmit = isFreelancer && ['FUNDED', 'REVISION_REQUESTED'].includes(milestone.status);
  const canReview = isClient && milestone.status === 'SUBMITTED';
  // 앞선 마일스톤이 PENDING이면 서버가 400 `Earlier milestones must be funded first`로 막는다.
  const canPay = isClient && contract.status === 'ACTIVE' && milestone.status === 'PENDING';
  const remaining = milestone.status === 'SUBMITTED' ? formatRemaining(milestone.autoApproveAt) : null;
  const submissions = milestone.submissions || [];
  const lastRejection = milestone.status === 'REVISION_REQUESTED'
    ? submissions.find((submission) => submission.decision === 'REJECTED')
    : null;
  const contractHref = `/contracts/${contract.id || contractId}`;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <nav className="text-sm text-gray-500 mb-4">
        <Link href={contractHref} className="hover:text-gray-700">
          {contract.project?.title || '계약서'}
        </Link>
        <span className="mx-2">/</span>
        <span>마일스톤 {milestone.sequence}</span>
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900">
          <span className="text-gray-400 mr-2">#{milestone.sequence}</span>
          {milestone.title}
        </h1>
        {contract.status === 'CANCELLED' ? (
          // 철회된 계약의 마일스톤은 진행하지 않는다. "결제 대기"로 보이면 결제할 수 있는 것처럼 읽힌다.
          <StatusPill tone="gray">철회된 계약</StatusPill>
        ) : (
          <MilestoneStatusBadge status={milestone.status} approvalType={milestone.approvalType} />
        )}
      </div>

      <div className="space-y-4">
        {notice && (
          <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
            {notice}
          </div>
        )}
        {actionError && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {actionError}
          </div>
        )}

        {milestone.status === 'SUBMITTED' && (
          <Card className="p-5 border-purple-200 bg-purple-50/40">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium text-gray-900">
                  {remaining ? `자동 승인까지 ${remaining} 남음` : '자동 승인 처리 대기 중'}
                </p>
                <p className="text-sm text-gray-600 mt-1">
                  {canReview
                    ? `${formatDateTime(milestone.autoApproveAt)}까지 승인하거나 수정을 요청하지 않으면 자동으로 승인됩니다.`
                    : `의뢰인이 ${formatDateTime(milestone.autoApproveAt)}까지 검수하지 않으면 자동으로 승인됩니다.`}
                </p>
              </div>
              {canReview && (
                <div className="flex gap-2">
                  <Button onClick={handleApprove} loading={approving}>승인</Button>
                  <Button variant="secondary" onClick={() => setRejectOpen(true)} disabled={approving}>
                    수정 요청
                  </Button>
                </div>
              )}
            </div>
          </Card>
        )}

        <Card className="p-6">
          <h2 className="font-semibold text-gray-900 mb-4">마일스톤 정보</h2>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-gray-500">금액</dt>
              <dd className="font-medium mt-1">{formatKRW(milestone.amount)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">기한</dt>
              <dd className="font-medium mt-1">{formatDate(milestone.dueDate)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">결제</dt>
              <dd className="font-medium mt-1">
                {milestone.payment
                  ? PAYMENT_STATUS_LABELS[milestone.payment.status] || milestone.payment.status
                  : '미결제'}
                {milestone.fundedAt && (
                  <span className="text-gray-500 font-normal"> · {formatDate(milestone.fundedAt)}</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">수정 요청</dt>
              <dd className="font-medium mt-1">{milestone.revisionCount || 0}회</dd>
            </div>
            {milestone.submittedAt && (
              <div>
                <dt className="text-gray-500">최근 제출</dt>
                <dd className="font-medium mt-1">{formatDateTime(milestone.submittedAt)}</dd>
              </div>
            )}
            {milestone.approvedAt && (
              <div>
                <dt className="text-gray-500">승인</dt>
                <dd className="font-medium mt-1">
                  {formatDateTime(milestone.approvedAt)}
                  {milestone.approvalType === 'AUTO' && <span className="text-gray-500 font-normal"> (자동)</span>}
                </dd>
              </div>
            )}
          </dl>
          {milestone.description && (
            <p className="mt-4 pt-4 border-t border-gray-100 text-sm text-gray-700 whitespace-pre-wrap">
              {milestone.description}
            </p>
          )}
          {canPay && (
            <div className="mt-4 flex justify-end">
              <Link href={`/payments/${milestone.id}`}>
                <Button>결제하기</Button>
              </Link>
            </div>
          )}
        </Card>

        {(isFreelancer || isClient) && milestone.payoutPreview && (
          <Card className="p-6">
            <h2 className="font-semibold text-gray-900 mb-1">정산 미리보기</h2>
            <p className="text-xs text-gray-500 mb-4">
              {isFreelancer
                ? '승인되면 아래 실지급액이 주간 정산에 포함됩니다.'
                : '의뢰인은 마일스톤 금액만 결제하며, 수수료와 부가세는 프리랜서 정산액에서 차감됩니다.'}
            </p>
            <PayoutPreview preview={milestone.payoutPreview} />
          </Card>
        )}

        {canSubmit && (
          <Card className="p-6">
            <h2 className="font-semibold text-gray-900 mb-4">
              {milestone.status === 'REVISION_REQUESTED' ? '결과물 다시 제출' : '결과물 제출'}
            </h2>
            {lastRejection?.decisionReason && (
              <div className="mb-4 rounded-lg border border-orange-200 bg-orange-50 p-3">
                <p className="text-xs font-medium text-orange-800">의뢰인의 수정 요청</p>
                <p className="mt-1 text-sm text-orange-900 whitespace-pre-wrap break-words">
                  {lastRejection.decisionReason}
                </p>
              </div>
            )}
            <SubmissionForm
              milestoneId={milestone.id}
              isResubmission={milestone.status === 'REVISION_REQUESTED'}
              onSubmitted={handleSubmitted}
            />
          </Card>
        )}

        <Card className="p-6">
          <h2 className="font-semibold text-gray-900 mb-4">제출 이력</h2>
          <SubmissionHistory submissions={submissions} />
        </Card>

        <div className="flex justify-start">
          <Link href={contractHref} className="text-sm text-primary-600 hover:text-primary-700 font-medium">
            ← 계약서로 돌아가기
          </Link>
        </div>
      </div>

      <RejectModal
        isOpen={rejectOpen}
        milestone={milestone}
        onClose={() => setRejectOpen(false)}
        onSubmit={handleReject}
      />
    </div>
  );
}
