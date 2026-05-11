'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Script from 'next/script';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';

const paymentBypassEnabled =
  process.env.NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS === 'true';

export default function PaymentPage() {
  const { id } = useParams(); // contract id
  const router = useRouter();
  const [contract, setContract] = useState(null);
  const [loading, setLoading] = useState(true);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [sdkReady, setSdkReady] = useState(false);

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get(`/api/contracts/${id}`)
      .then(({ data }) => setContract(data))
      .catch(() => router.push('/'))
      .finally(() => setLoading(false));
  }, [id, router]);

  async function handlePayment() {
    if (!sdkReady || !window.TossPayments) {
      alert('결제 SDK가 로드되지 않았습니다. 잠시 후 다시 시도해주세요.');
      return;
    }

    setPaymentLoading(true);
    try {
      const { data } = await api.post('/api/payments', { contractId: id });
      const { orderId, amount } = data;

      const tossPayments = window.TossPayments(process.env.NEXT_PUBLIC_TOSS_CLIENT_KEY);

      await tossPayments.requestPayment('카드', {
        amount,
        orderId,
        orderName: contract.project?.title || '프로젝트 대금',
        customerName: useAuthStore.getState().user?.name,
        successUrl: `${window.location.origin}/payments/result?status=success&orderId=${orderId}&contractId=${id}`,
        failUrl: `${window.location.origin}/payments/result?status=fail&contractId=${id}`,
      });
    } catch (err) {
      if (err.code !== 'USER_CANCEL') {
        alert(err.response?.data?.error?.message || '결제에 실패했습니다');
      }
    } finally {
      setPaymentLoading(false);
    }
  }

  async function handleDevPaymentComplete() {
    setPaymentLoading(true);
    try {
      await api.post('/api/payments/dev-complete', { contractId: id });
      router.push(`/payments/result?status=dev-success&contractId=${id}`);
    } catch (err) {
      alert(err.response?.data?.error?.message || '개발용 결제 완료 처리에 실패했습니다');
    } finally {
      setPaymentLoading(false);
    }
  }

  if (loading) return <div className="max-w-lg mx-auto px-4 py-8 text-center">로딩 중...</div>;
  if (!contract) return null;

  return (
    <>
      <Script
        src="https://js.tosspayments.com/v1/payment"
        strategy="lazyOnload"
        onLoad={() => setSdkReady(true)}
      />
      <div className="max-w-lg mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">결제</h1>

        <Card className="p-6 mb-6">
          <h2 className="font-semibold text-gray-900 mb-4">결제 정보</h2>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">프로젝트</dt>
              <dd className="font-medium">{contract.project?.title}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">프리랜서</dt>
              <dd className="font-medium">{contract.freelancer?.name}</dd>
            </div>
            <div className="flex justify-between border-t border-gray-100 pt-3">
              <dt className="font-semibold text-gray-900">결제 금액</dt>
              <dd className="font-bold text-xl text-primary-600">{contract.amount?.toLocaleString()}원</dd>
            </div>
          </dl>
        </Card>

        <Button
          onClick={handlePayment}
          loading={paymentLoading}
          disabled={!sdkReady}
          className="w-full"
          size="lg"
        >
          {sdkReady ? `${contract.amount?.toLocaleString()}원 결제하기` : '결제 준비 중...'}
        </Button>

        {paymentBypassEnabled && contract.payment?.status !== 'COMPLETED' && (
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
      </div>
    </>
  );
}
