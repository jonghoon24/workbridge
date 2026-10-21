'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import MilestoneCard from '@/components/milestones/MilestoneCard';
import MilestonePlanEditor from '@/components/milestones/MilestonePlanEditor';
import RejectModal from '@/components/milestones/RejectModal';
import UnreadBadge from '@/components/messages/UnreadBadge';
import { formatDate, formatKRW } from '@/lib/format';
import { CONTRACT_STATUS_LABELS } from '@/constants/milestones';

export default function ContractPage() {
  const { id } = useParams();
  const router = useRouter();
  const { user } = useAuthStore();
  const [contract, setContract] = useState(null);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState(false);
  const [editingPlan, setEditingPlan] = useState(false);
  const [planNotice, setPlanNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyMilestoneId, setBusyMilestoneId] = useState('');
  const [rejectTarget, setRejectTarget] = useState(null);
  const [reviewForm, setReviewForm] = useState({ rating: 5, content: '', tags: [] });
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [reviewSuccess, setReviewSuccess] = useState('');
  const [conversation, setConversation] = useState(null);

  const loadContract = useCallback(
    () => api.get(`/api/contracts/${id}`).then(({ data }) => setContract(data)),
    [id]
  );

  useEffect(() => {
    useAuthStore.getState().initAuth();
    loadContract()
      .catch(() => router.push('/'))
      .finally(() => setLoading(false));
  }, [loadContract, router]);

  // 계약의 대화방과 안 읽은 메시지 수(BEHAVIOR.md MG18). 대화방이 없으면(데이터 복구 상황) 버튼을 숨긴다.
  useEffect(() => {
    let ignored = false;
    api.get(`/api/contracts/${id}/conversation`)
      .then(({ data }) => {
        if (!ignored) setConversation(data);
      })
      .catch(() => {
        if (!ignored) setConversation(null);
      });
    return () => {
      ignored = true;
    };
  }, [id]);

  // CONTRACT_COMPLETED 알림의 href는 `/contracts/<id>#review`다. 리뷰 영역은 데이터가 온 뒤에
  // 그려지므로 브라우저의 기본 앵커 스크롤이 닿지 않아 직접 옮긴다.
  useEffect(() => {
    if (!contract || typeof window === 'undefined' || window.location.hash !== '#review') return;
    document.getElementById('review')?.scrollIntoView({ behavior: 'smooth' });
  }, [contract]);

  async function handleSign() {
    setSigning(true);
    setActionError('');
    try {
      const { data } = await api.post(`/api/contracts/${id}/sign`);
      setContract(data);
      if (data.status === 'ACTIVE') {
        alert('계약이 체결되었습니다! 첫 마일스톤을 결제하면 작업이 시작됩니다.');
      }
    } catch (err) {
      setActionError(err.response?.data?.error?.message || '서명에 실패했습니다');
    } finally {
      setSigning(false);
    }
  }

  async function handlePlanSaved(_data, { signaturesReset }) {
    setEditingPlan(false);
    setPlanNotice(signaturesReset
      ? '마일스톤 계획이 저장되었습니다. 양측 서명이 초기화되었으니 다시 서명해주세요.'
      : '마일스톤 계획이 저장되었습니다.');
    await loadContract().catch(() => {});
  }

  async function handleApprove(milestone) {
    if (!confirm(`"${milestone.title}" 마일스톤을 승인할까요?\n승인하면 대금이 프리랜서 정산 대상으로 확정되며 되돌릴 수 없습니다.`)) {
      return;
    }
    setBusyMilestoneId(milestone.id);
    setActionError('');
    try {
      const { data } = await api.post(`/api/milestones/${milestone.id}/approve`);
      if (data.contract?.status === 'COMPLETED') {
        alert('모든 마일스톤이 승인되어 계약이 완료되었습니다. 리뷰를 남겨주세요!');
      }
      await loadContract();
    } catch (err) {
      setActionError(err.response?.data?.error?.message || '승인에 실패했습니다');
    } finally {
      setBusyMilestoneId('');
    }
  }

  async function handleReject(reason) {
    // RejectModal이 오류를 보여주도록 실패는 그대로 던진다.
    await api.post(`/api/milestones/${rejectTarget.id}/reject`, { reason });
    setRejectTarget(null);
    await loadContract().catch(() => {});
  }

  function toggleReviewTag(tag) {
    setReviewForm((prev) => ({
      ...prev,
      tags: prev.tags.includes(tag)
        ? prev.tags.filter((item) => item !== tag)
        : [...prev.tags, tag],
    }));
  }

  async function handleReviewSubmit(e) {
    e.preventDefault();
    setReviewError('');
    setReviewSuccess('');

    const currentUser = useAuthStore.getState().user;
    const isClient = currentUser?.id === contract.clientId;
    const revieweeId = isClient ? contract.freelancerId : contract.clientId;

    if (!reviewForm.content.trim()) {
      setReviewError('리뷰 내용을 입력해주세요.');
      return;
    }

    setReviewLoading(true);
    try {
      await api.post('/api/reviews', {
        contractId: contract.id,
        revieweeId,
        rating: reviewForm.rating,
        content: reviewForm.content,
        tags: reviewForm.tags,
      });
      await loadContract();
      setReviewForm({ rating: 5, content: '', tags: [] });
      setReviewSuccess('리뷰가 등록되었습니다.');
    } catch (err) {
      setReviewError(err.response?.data?.error?.message || '리뷰 등록에 실패했습니다');
    } finally {
      setReviewLoading(false);
    }
  }

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-8 text-center">로딩 중...</div>;
  if (!contract) return null;

  const currentUser = user || useAuthStore.getState().user;
  const isClient = currentUser?.id === contract.clientId;
  const isFreelancer = currentUser?.id === contract.freelancerId;
  const hasSigned = isClient ? contract.clientSigned : contract.freelancerSigned;
  const canSign = (isClient || isFreelancer) && contract.status === 'PENDING' && !hasSigned;
  const canEditPlan = isClient && contract.status === 'PENDING';
  const milestones = contract.milestones || [];
  const summary = contract.milestoneSummary || {};
  const contractAmount = summary.contractAmount ?? Math.round(contract.amount || 0);
  // 결제는 sequence 순서대로만 할 수 있으므로(M13) 결제 버튼은 첫 PENDING 마일스톤에만 둔다.
  const nextFundable = contract.status === 'ACTIVE'
    ? milestones.find((milestone) => milestone.status === 'PENDING')
    : null;
  const approvedPercent = contractAmount > 0
    ? Math.min(100, Math.round(((summary.approvedAmount || 0) / contractAmount) * 100))
    : 0;
  const fundedPercent = contractAmount > 0
    ? Math.min(100, Math.round(((summary.fundedAmount || 0) / contractAmount) * 100))
    : 0;
  const ownReview = contract.reviews?.find((review) => review.reviewerId === currentUser?.id);
  const canReview = (isClient || isFreelancer) && contract.status === 'COMPLETED' && !ownReview;
  const reviewTagOptions = isClient
    ? ['책임감', '소통', '기술력', '일정 준수']
    : ['명확한 요구사항', '신속한 피드백', '합리적인 일정', '원활한 소통'];

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-bold text-gray-900">계약서</h1>
        <div className="flex items-center gap-3">
          {conversation && (isClient || isFreelancer) && (
            <Link
              href={`/messages/${conversation.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              대화 열기
              <UnreadBadge count={conversation.unreadCount} />
            </Link>
          )}
          <Badge variant={contract.status}>{CONTRACT_STATUS_LABELS[contract.status] || contract.status}</Badge>
        </div>
      </div>

      <div className="space-y-4">
        {actionError && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {actionError}
          </div>
        )}

        <Card className="p-6">
          <h2 className="font-semibold text-gray-900 mb-4">계약 정보</h2>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-gray-500">프로젝트</dt>
              <dd className="font-medium mt-1">
                <Link href={`/projects/${contract.projectId}`} className="text-primary-600 hover:text-primary-700">
                  {contract.project?.title}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">계약 금액</dt>
              <dd className="font-medium mt-1">{formatKRW(contractAmount)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">의뢰인</dt>
              <dd className="font-medium mt-1">{contract.client?.name}</dd>
            </div>
            <div>
              <dt className="text-gray-500">프리랜서</dt>
              <dd className="font-medium mt-1">{contract.freelancer?.name}</dd>
            </div>
            <div>
              <dt className="text-gray-500">시작일</dt>
              <dd className="font-medium mt-1">{formatDate(contract.startDate)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">종료일 (마지막 마일스톤 기한)</dt>
              <dd className="font-medium mt-1">{formatDate(contract.endDate)}</dd>
            </div>
            {contract.completedAt && (
              <div>
                <dt className="text-gray-500">완료일</dt>
                <dd className="font-medium mt-1">{formatDate(contract.completedAt)}</dd>
              </div>
            )}
          </dl>
        </Card>

        <Card className="p-6">
          <h2 className="font-semibold text-gray-900 mb-4">서명 현황</h2>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-6">
              <div className={`flex items-center gap-2 ${contract.clientSigned ? 'text-green-600' : 'text-gray-400'}`}>
                <span>{contract.clientSigned ? '✓' : '○'}</span>
                <span className="text-sm font-medium">의뢰인 서명 {contract.clientSigned ? '완료' : '대기'}</span>
              </div>
              <div className={`flex items-center gap-2 ${contract.freelancerSigned ? 'text-green-600' : 'text-gray-400'}`}>
                <span>{contract.freelancerSigned ? '✓' : '○'}</span>
                <span className="text-sm font-medium">프리랜서 서명 {contract.freelancerSigned ? '완료' : '대기'}</span>
              </div>
            </div>
            {canSign && (
              <Button onClick={handleSign} loading={signing}>
                계약서 서명하기
              </Button>
            )}
          </div>
          {contract.status === 'PENDING' && (
            <p className="mt-4 text-xs text-gray-500">
              서명은 아래 마일스톤 계획에 대한 동의입니다. 의뢰인이 계획을 바꾸면 양측 서명이 초기화됩니다.
            </p>
          )}
        </Card>

        <Card id="milestones" className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-900">마일스톤</h2>
            {canEditPlan && !editingPlan && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => { setPlanNotice(''); setEditingPlan(true); }}
              >
                계획 수정
              </Button>
            )}
          </div>

          {planNotice && (
            <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm mb-4">
              {planNotice}
            </div>
          )}

          {editingPlan ? (
            <MilestonePlanEditor
              contract={contract}
              onSaved={handlePlanSaved}
              onCancel={() => setEditingPlan(false)}
            />
          ) : (
            <>
              <div className="mb-5">
                <div className="flex flex-wrap justify-between gap-2 text-sm text-gray-600 mb-2">
                  <span>
                    승인 {summary.approvedCount || 0}/{summary.count ?? milestones.length}개 · {formatKRW(summary.approvedAmount || 0)}
                  </span>
                  <span>결제 완료 {formatKRW(summary.fundedAmount || 0)} / {formatKRW(contractAmount)}</span>
                </div>
                <div className="relative h-2 rounded-full bg-gray-100 overflow-hidden">
                  <div className="absolute inset-y-0 left-0 bg-primary-100" style={{ width: `${fundedPercent}%` }} />
                  <div className="absolute inset-y-0 left-0 bg-primary-600" style={{ width: `${approvedPercent}%` }} />
                </div>
              </div>

              {milestones.length === 0 ? (
                <p className="text-sm text-gray-500">마일스톤이 없습니다.</p>
              ) : (
                <div className="space-y-3">
                  {milestones.map((milestone) => (
                    <MilestoneCard
                      key={milestone.id}
                      milestone={milestone}
                      contractId={contract.id}
                      isClient={isClient}
                      isFreelancer={isFreelancer}
                      canFund={nextFundable?.id === milestone.id}
                      busy={busyMilestoneId === milestone.id}
                      onApprove={handleApprove}
                      onReject={setRejectTarget}
                    />
                  ))}
                </div>
              )}

              {contract.status === 'PENDING' && (
                <p className="mt-4 text-xs text-gray-500">
                  양측 서명이 끝나면 의뢰인이 마일스톤을 순서대로 결제하고, 결제된 마일스톤부터 작업이 시작됩니다.
                </p>
              )}
              {contract.status === 'ACTIVE' && isFreelancer && (
                <p className="mt-4 text-xs text-gray-500">
                  승인된 마일스톤 금액에서 플랫폼 수수료와 수수료 부가세를 뺀 금액이 매주 정산됩니다.{' '}
                  <Link href="/settlements" className="text-primary-600 hover:text-primary-700">정산 내역 보기</Link>
                </p>
              )}
            </>
          )}
        </Card>

        <RejectModal
          isOpen={Boolean(rejectTarget)}
          milestone={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onSubmit={handleReject}
        />

        {contract.status === 'COMPLETED' && (
          <Card id="review" className="p-6 scroll-mt-20">
            <h2 className="font-semibold text-gray-900 mb-4">리뷰</h2>

            {contract.reviews?.length > 0 ? (
              <div className="space-y-4 mb-6">
                {contract.reviews.map((review) => (
                  <div key={review.id} className="border-b border-gray-100 last:border-0 pb-4 last:pb-0">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          {review.reviewer?.name} → {review.reviewee?.name}
                        </p>
                        <div className="text-yellow-400 text-sm">
                          {'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}
                        </div>
                      </div>
                      <span className="text-xs text-gray-400">
                        {new Date(review.createdAt).toLocaleDateString('ko-KR')}
                      </span>
                    </div>
                    <p className="text-sm text-gray-700 mt-2">{review.content}</p>
                    {review.tags?.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {review.tags.map((tag) => (
                          <span key={tag} className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500 mb-6">아직 작성된 리뷰가 없습니다.</p>
            )}

            {reviewSuccess && (
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm mb-4">
                {reviewSuccess}
              </div>
            )}

            {canReview && (
              <form onSubmit={handleReviewSubmit} className="space-y-4">
                {reviewError && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                    {reviewError}
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">별점</label>
                  <select
                    value={reviewForm.rating}
                    onChange={(e) => setReviewForm({ ...reviewForm, rating: parseInt(e.target.value) })}
                    className="block w-32 rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
                  >
                    {[5, 4, 3, 2, 1].map((rating) => (
                      <option key={rating} value={rating}>{rating}점</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">태그</label>
                  <div className="flex flex-wrap gap-2">
                    {reviewTagOptions.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => toggleReviewTag(tag)}
                        className={`px-3 py-1 rounded-full text-sm border transition-colors ${
                          reviewForm.tags.includes(tag)
                            ? 'bg-primary-50 border-primary-500 text-primary-700'
                            : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">리뷰 내용</label>
                  <textarea
                    value={reviewForm.content}
                    onChange={(e) => setReviewForm({ ...reviewForm, content: e.target.value })}
                    rows={4}
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
                    placeholder="프로젝트 경험을 구체적으로 작성해주세요"
                  />
                </div>

                <div className="flex justify-end">
                  <Button type="submit" loading={reviewLoading}>리뷰 등록</Button>
                </div>
              </form>
            )}

            {ownReview && (
              <p className="text-sm text-gray-500">이미 이 계약에 대한 리뷰를 작성했습니다.</p>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
