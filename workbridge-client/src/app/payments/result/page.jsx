'use client';

import { useEffect, useRef, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import { toUserMessage } from '@/lib/errorMessages';

// 토스 결제창에서 사용자가 직접 닫거나 취소했을 때 failUrl에 붙는 코드.
const CANCEL_CODES = new Set(['PAY_PROCESS_CANCELED', 'USER_CANCEL']);

function PaymentResultContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const status = searchParams.get('status');
  const orderId = searchParams.get('orderId');
  const paymentKey = searchParams.get('paymentKey');
  const amount = searchParams.get('amount');
  // 결제 페이지가 successUrl/failUrl에 붙여 보낸 값. 결제는 마일스톤 단위다.
  const milestoneId = searchParams.get('milestoneId');
  const contractId = searchParams.get('contractId');
  // Toss failUrl은 code와 message를 붙여 돌려준다.
  const failCode = searchParams.get('code');
  const failMessage = searchParams.get('message');

  const [result, setResult] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [loading, setLoading] = useState(true);
  // 개발 모드의 Strict Mode가 effect를 두 번 돌려 confirm이 두 번 나가지 않게 한다.
  const confirmStarted = useRef(false);

  useEffect(() => {
    // 결제가 이미 반영됐는지는 마일스톤 상태로 판단한다(PENDING이 아니면 결제 완료).
    const isFunded = () => (milestoneId
      ? api.get(`/api/milestones/${milestoneId}`).then(({ data }) => data.status !== 'PENDING').catch(() => false)
      : Promise.resolve(false));
    // 승인이 끝나면 paymentKey가 든 주소를 바꿔 둔다. 새로고침하거나 뒤로 와도 승인을 다시 요청하지 않는다.
    const showDone = () => {
      setResult('success');
      const query = new URLSearchParams({ status: 'done' });
      if (milestoneId) query.set('milestoneId', milestoneId);
      if (contractId) query.set('contractId', contractId);
      router.replace(`/payments/result?${query}`);
    };

    if (status === 'dev-success') {
      setResult('success');
      setLoading(false);
    } else if (status === 'done') {
      isFunded()
        .then((funded) => setResult(funded ? 'success' : 'fail'))
        .finally(() => setLoading(false));
    } else if (status === 'success' && orderId && paymentKey && amount) {
      if (confirmStarted.current) return;
      confirmStarted.current = true;
      api.post('/api/payments/confirm', { orderId, paymentKey, amount: parseInt(amount, 10) })
        .then(showDone)
        .catch(async (err) => {
          // 이미 승인된 결제를 다시 확인하면 서버는 409를 준다. 마일스톤이 결제됐으면 성공으로 보여 준다.
          if (err.response?.status === 409 && (await isFunded())) {
            showDone();
            return;
          }
          setErrorMessage(toUserMessage(err, '결제 승인을 확인하지 못했습니다.'));
          setResult('fail');
        })
        .finally(() => setLoading(false));
    } else if (CANCEL_CODES.has(failCode)) {
      setResult('cancel');
      setLoading(false);
    } else {
      setErrorMessage(failMessage || '');
      setResult('fail');
      setLoading(false);
    }
  }, [status, orderId, paymentKey, amount, failCode, failMessage, milestoneId, contractId, router]);

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
        ) : result === 'cancel' ? (
          <>
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </div>
            <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900 mb-2">결제 취소</h1>
            <p className="text-gray-600 mb-6">결제를 취소했습니다. 결제된 금액은 없습니다.</p>
          </>
        ) : (
          <>
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900 mb-2">결제 실패</h1>
            <p className={`text-gray-600 ${errorMessage ? 'mb-2' : 'mb-6'}`}>결제를 완료하지 못했습니다.</p>
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
