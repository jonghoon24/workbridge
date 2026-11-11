'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Script from 'next/script';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import MilestoneStatusBadge from '@/components/milestones/MilestoneStatusBadge';
import { formatDate, formatKRW } from '@/lib/format';
import PageLoader from '@/components/ui/PageLoader';
import EmptyState from '@/components/ui/EmptyState';
import { toUserMessage } from '@/lib/errorMessages';

const paymentBypassEnabled =
  process.env.NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS === 'true';

// Toss orderName은 100자까지 받는다.
function buildOrderName(projectTitle, milestoneTitle) {
  const name = [projectTitle, milestoneTitle].filter(Boolean).join(' - ') || '프로젝트 대금';
  return name.length > 100 ? `${name.slice(0, 99)}…` : name;
}

export default function PaymentPage() {
  const { id } = useParams(); // milestone id (결제는 마일스톤 단위다)
  const router = useRouter();
  const [milestone, setMilestone] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [sdkReady, setSdkReady] = useState(false);

  // 다른 화면에서 이미 SDK를 불러온 경우(뒤로 갔다 다시 들어올 때) Script의 onReady가 다시 불리지만,
  // 전역 객체가 이미 있으면 바로 준비 상태로 둔다.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.TossPayments) setSdkReady(true);
  }, []);

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get(`/api/milestones/${id}`)
      .then(({ data }) => setMilestone(data))
      .catch((err) => {
        setLoadError(toUserMessage(err, '결제할 마일스톤을 불러오지 못했습니다.'));
      })
      .finally(() => setLoading(false));
  }, [id]);

  const contractId = milestone?.contract?.id;
  const resultQuery = `milestoneId=${id}${contractId ? `&contractId=${contractId}` : ''}`;

  async function handlePayment() {
    if (!sdkReady || !window.TossPayments) {
      setError('결제 모듈을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
      return;
    }

    setPaymentLoading(true);
    setError('');
    setNotice('');
    try {
      const { data } = await api.post('/api/payments', { milestoneId: id });
      const { orderId, amount } = data;

      const tossPayments = window.TossPayments(process.env.NEXT_PUBLIC_TOSS_CLIENT_KEY);

      await tossPayments.requestPayment('카드', {
        amount,
        orderId,
        orderName: buildOrderName(milestone.contract?.project?.title, milestone.title),
        customerName: useAuthStore.getState().user?.name,
        successUrl: `${window.location.origin}/payments/result?status=success&${resultQuery}`,
        failUrl: `${window.location.origin}/payments/result?status=fail&${resultQuery}`,
      });
    } catch (err) {
      if (err.code === 'USER_CANCEL' || err.code === 'PAY_PROCESS_CANCELED') {
        setNotice('결제를 취소했습니다. 결제하려면 다시 버튼을 눌러 주세요.');
      } else if (err.response || err.request) {
        setError(toUserMessage(err, '결제를 시작하지 못했습니다.'));
      } else {
        // 토스페이먼츠 SDK 오류는 한국어 message를 준다.
        setError(err.message || '결제를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      }
    } finally {
      setPaymentLoading(false);
    }
  }

  async function handleDevPaymentComplete() {
    setPaymentLoading(true);
    setError('');
    try {
      await api.post('/api/payments/dev-complete', { milestoneId: id });
      router.push(`/payments/result?status=dev-success&${resultQuery}`);
    } catch (err) {
      setError(toUserMessage(err, '개발용 결제 완료 처리에 실패했습니다.'));
    } finally {
      setPaymentLoading(false);
    }
  }

  if (loading) return <PageLoader />;

  if (loadError || !milestone) {
    return (
      <div className="max-w-lg mx-auto px-4 sm:px-6 py-12">
        <EmptyState
          tone="error"
          title={loadError || '마일스톤을 찾을 수 없습니다.'}
          action={(
            <Link href="/my/contracts" className="text-primary-600 hover:text-primary-700 font-semibold">
              내 계약으로 →
            </Link>
          )}
        />
      </div>
    );
  }

  const contract = milestone.contract || {};
  const currentUser = useAuthStore.getState().user;
  const isClient = currentUser?.id === contract.clientId;
  const payable = isClient && contract.status === 'ACTIVE' && milestone.status === 'PENDING';
  let blockedReason = '';
  if (!isClient) blockedReason = '계약의 의뢰인만 결제할 수 있습니다.';
  else if (contract.status === 'CANCELLED') blockedReason = '서명 전에 철회된 계약이라 결제할 수 없습니다.';
  else if (contract.status !== 'ACTIVE') blockedReason = '양측 서명으로 계약이 체결된 뒤에 결제할 수 있습니다.';
  else if (milestone.status !== 'PENDING') blockedReason = '이미 결제된 마일스톤입니다.';

  return (
    <>
      <Script
        src="https://js.tosspayments.com/v1/payment"
        strategy="lazyOnload"
        onReady={() => setSdkReady(true)}
      />
      <div className="max-w-lg mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900 mb-6">마일스톤 결제</h1>

        <Card className="p-6 mb-6">
          <h2 className="font-semibold text-gray-900 mb-4">결제 정보</h2>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500">프로젝트</dt>
              <dd className="font-medium text-right">{contract.project?.title}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500">마일스톤</dt>
              <dd className="font-medium text-right">
                #{milestone.sequence} {milestone.title}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500">상태</dt>
              <dd><MilestoneStatusBadge status={milestone.status} approvalType={milestone.approvalType} /></dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500">기한</dt>
              <dd className="font-medium">{formatDate(milestone.dueDate)}</dd>
            </div>
            <div className="flex justify-between border-t border-gray-100 pt-3">
              <dt className="font-semibold text-gray-900">결제 금액</dt>
              <dd className="font-bold text-xl text-primary-600">{formatKRW(milestone.amount)}</dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-gray-500">
            안전결제: 결제한 금액은 WorkBridge가 보관하다가 의뢰인이 결과물을 승인하면(검수 기한이 지나 자동 승인되는 경우 포함)
            프리랜서에게 정산됩니다. 마일스톤은 순서대로만 결제할 수 있습니다.
          </p>
        </Card>

        {notice && (
          <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg text-gray-700 text-sm mb-4">
            {notice}
          </div>
        )}

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm mb-4">
            {error}
          </div>
        )}

        {payable ? (
          <>
            <Button
              onClick={handlePayment}
              loading={paymentLoading}
              disabled={!sdkReady}
              className="w-full"
              size="lg"
            >
              {sdkReady ? `${formatKRW(milestone.amount)} 결제하기` : '결제 준비 중...'}
            </Button>

            {paymentBypassEnabled && (
              <Button
                onClick={handleDevPaymentComplete}
                loading={paymentLoading}
                variant="secondary"
                className="w-full mt-3"
                size="lg"
              >
                개발용 결제 완료 처리
              </Button>
            )}
          </>
        ) : (
          <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg text-gray-700 text-sm">
            {blockedReason}
          </div>
        )}

        {contract.id && (
          <div className="mt-6 text-center">
            <Link href={`/contracts/${contract.id}`} className="text-sm text-primary-600 hover:text-primary-700 font-medium">
              ← 계약서로 돌아가기
            </Link>
          </div>
        )}
      </div>
    </>
  );
}
