'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';

export default function ContractPage() {
  const { id } = useParams();
  const router = useRouter();
  const { user } = useAuthStore();
  const [contract, setContract] = useState(null);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState(false);
  const [reviewForm, setReviewForm] = useState({ rating: 5, content: '', tags: [] });
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [reviewSuccess, setReviewSuccess] = useState('');

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get(`/api/contracts/${id}`)
      .then(({ data }) => setContract(data))
      .catch(() => router.push('/'))
      .finally(() => setLoading(false));
  }, [id, router]);

  async function handleSign() {
    setSigning(true);
    try {
      const { data } = await api.post(`/api/contracts/${id}/sign`);
      setContract(data);
      if (data.status === 'ACTIVE') {
        alert('계약이 체결되었습니다!');
      }
    } catch (err) {
      alert(err.response?.data?.error?.message || '서명에 실패했습니다');
    } finally {
      setSigning(false);
    }
  }

  async function handleCompleteContract() {
    try {
      const { data } = await api.patch(`/api/contracts/${id}`, { status: 'COMPLETED' });
      setContract(data);
      alert('프로젝트가 완료되었습니다!');
    } catch (err) {
      alert(err.response?.data?.error?.message || '처리에 실패했습니다');
    }
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
      const { data } = await api.get(`/api/contracts/${id}`);
      setContract(data);
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

  const currentUser = useAuthStore.getState().user;
  const isClient = currentUser?.id === contract.clientId;
  const isFreelancer = currentUser?.id === contract.freelancerId;
  const hasSigned = isClient ? contract.clientSigned : contract.freelancerSigned;
  const canSign = (isClient || isFreelancer) && !hasSigned;
  const canPay = isClient && contract.status === 'ACTIVE' && !contract.payment;
  const canComplete = isClient && contract.status === 'ACTIVE' && contract.payment?.status === 'COMPLETED';
  const ownReview = contract.reviews?.find((review) => review.reviewerId === currentUser?.id);
  const canReview = (isClient || isFreelancer) && contract.status === 'COMPLETED' && !ownReview;
  const reviewTagOptions = isClient
    ? ['책임감', '소통', '기술력', '일정 준수']
    : ['명확한 요구사항', '신속한 피드백', '합리적인 일정', '원활한 소통'];
  const platformFee = Math.floor((contract.payment?.amount || contract.amount || 0) * 0.1);
  const freelancerPayout = (contract.payment?.amount || contract.amount || 0) - platformFee;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">계약서</h1>
        <Badge variant={contract.status}>{
          contract.status === 'PENDING' ? '서명 대기' :
          contract.status === 'ACTIVE' ? '계약 진행 중' : '완료'
        }</Badge>
      </div>

      <div className="space-y-4">
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
              <dd className="font-medium mt-1">{contract.amount?.toLocaleString()}원</dd>
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
              <dd className="font-medium mt-1">{new Date(contract.startDate).toLocaleDateString('ko-KR')}</dd>
            </div>
            <div>
              <dt className="text-gray-500">종료일</dt>
              <dd className="font-medium mt-1">{new Date(contract.endDate).toLocaleDateString('ko-KR')}</dd>
            </div>
          </dl>
        </Card>

        <Card className="p-6">
          <h2 className="font-semibold text-gray-900 mb-4">서명 현황</h2>
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
        </Card>

        {contract.payment && (
          <Card className="p-6">
            <h2 className="font-semibold text-gray-900 mb-2">결제 현황</h2>
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-3">
                <Badge variant={contract.payment.status}>{contract.payment.status}</Badge>
                <span className="font-medium">{contract.payment.amount?.toLocaleString()}원</span>
              </div>
              {contract.payment.status === 'COMPLETED' && (
                <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-3 border-t border-gray-100">
                  <div>
                    <dt className="text-gray-500">플랫폼 보관금</dt>
                    <dd className="font-medium mt-1">{contract.payment.amount?.toLocaleString()}원</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">플랫폼 수수료</dt>
                    <dd className="font-medium mt-1">{platformFee.toLocaleString()}원</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">지급 예정액</dt>
                    <dd className="font-medium mt-1">{freelancerPayout.toLocaleString()}원</dd>
                  </div>
                </dl>
              )}
              {contract.payment.status === 'COMPLETED' && (
                <p className="text-xs text-gray-500">
                  실제 이체는 MVP 범위에서 처리하지 않으며, 완료 승인 후 지급 예정 상태로 관리합니다.
                </p>
              )}
            </div>
          </Card>
        )}

        <div className="flex gap-3 justify-end">
          {canSign && (
            <Button onClick={handleSign} loading={signing}>
              계약서 서명하기
            </Button>
          )}
          {canPay && (
            <Link href={`/payments/${contract.id}`}>
              <Button>결제하기</Button>
            </Link>
          )}
          {canComplete && (
            <Button onClick={handleCompleteContract} variant="secondary">
              프로젝트 완료 처리
            </Button>
          )}
        </div>

        {contract.status === 'COMPLETED' && (
          <Card className="p-6">
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
