'use client';

import { useEffect, useRef, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';

function PaymentResultContent() {
  const searchParams = useSearchParams();
  const status = searchParams.get('status');
  const orderId = searchParams.get('orderId');
  const paymentKey = searchParams.get('paymentKey');
  const amount = searchParams.get('amount');
  // 결제 페이지가 successUrl/failUrl에 붙여 보낸 값. 결제는 마일스톤 단위다.
  const milestoneId = searchParams.get('milestoneId');
  const contractId = searchParams.get('contractId');
  // Toss failUrl은 code와 message를 붙여 돌려준다.
  const failMessage = searchParams.get('message');

  const [result, setResult] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [loading, setLoading] = useState(true);
  // 개발 모드의 Strict Mode가 effect를 두 번 돌려 confirm이 두 번 나가지 않게 한다(D18).
  const confirmStarted = useRef(false);

  useEffect(() => {
    if (status === 'dev-success') {
      setResult('success');
      setLoading(false);
    } else if (status === 'success' && orderId && paymentKey && amount) {
      if (confirmStarted.current) return;
      confirmStarted.current = true;
      api.post('/api/payments/confirm', { orderId, paymentKey, amount: parseInt(amount) })
        .then(() => setResult('success'))
        .catch((err) => {
          setErrorMessage(err.response?.data?.error?.message || '');
          setResult('fail');
        })
        .finally(() => setLoading(false));
    } else {
      setErrorMessage(failMessage || '');
      setResult('fail');
      setLoading(false);
    }
  }, [status, orderId, paymentKey, amount, failMessage]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto mb-4" />
          <p className="text-gray-600">결제 처리 중...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        {result === 'success' ? (
          <>
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900 mb-2">결제 완료</h1>
            <p className="text-gray-600 mb-6">
              결제가 완료되었습니다. 프리랜서가 이 마일스톤 작업을 시작할 수 있습니다.
            </p>
          </>
        ) : (
          <>
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900 mb-2">결제 실패</h1>
            <p className={`text-gray-600 ${errorMessage ? 'mb-2' : 'mb-6'}`}>결제 처리 중 오류가 발생했습니다.</p>
            {errorMessage && <p className="text-sm text-gray-500 mb-6">{errorMessage}</p>}
          </>
        )}
        <div className="flex flex-wrap gap-3 justify-center">
          {result === 'success' && contractId && milestoneId && (
            <Link href={`/contracts/${contractId}/milestones/${milestoneId}`}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium">
              마일스톤 보기
            </Link>
          )}
          {result === 'success' && contractId && (
            <Link href={`/contracts/${contractId}`}
              className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 font-medium">
              계약서 보기
            </Link>
          )}
          {result !== 'success' && milestoneId && (
            <Link href={`/payments/${milestoneId}`}
              className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 font-medium">
              다시 결제하기
            </Link>
          )}
          <Link href="/my/payments"
            className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 font-medium">
            결제 내역 보기
          </Link>
          <Link href="/"
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium">
            홈으로
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function PaymentResultPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
      </div>
    }>
      <PaymentResultContent />
    </Suspense>
  );
}
