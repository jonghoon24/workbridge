'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { formatDate, formatKRW } from '@/lib/format';
import { PAYMENT_STATUS_LABELS } from '@/constants/milestones';
import PageLoader from '@/components/ui/PageLoader';
import EmptyState from '@/components/ui/EmptyState';
import { CreditCardIcon } from '@/components/ui/Icons';
import { toUserMessage } from '@/lib/errorMessages';

// 결제창을 열기만 하고 끝내지 않은 시도(PENDING)는 결제 내역이 아니므로 보여 주지 않는다.
const HIDDEN_STATUSES = new Set(['PENDING']);

// 주문번호(UUID)는 앞 8자리만 대문자로 보여 준다. 고객 문의나 토스페이먼츠 내역과 맞춰 볼 때 쓴다.
function shortOrderId(orderId) {
  return orderId ? `#${orderId.replace(/-/g, '').slice(0, 8).toUpperCase()}` : '-';
}

export default function MyPaymentsPage() {
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get('/api/payments')
      .then(({ data }) => setPayments(data.filter((payment) => !HIDDEN_STATUSES.has(payment.status))))
      .catch((err) => setError(toUserMessage(err, '결제 내역을 불러오지 못했습니다.')))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <PageLoader />;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900 mb-6">결제 내역</h1>

      {error ? (
        <EmptyState tone="error" title={error} />
      ) : payments.length === 0 ? (
        <EmptyState icon={CreditCardIcon} title="아직 결제 내역이 없습니다" />
      ) : (
        <div className="space-y-4">
          {payments.map((payment) => (
            <Card key={payment.id} className="p-5">
              <div className="flex items-start justify-between">
                <div>
                  <Link href={`/contracts/${payment.contractId}`} className="font-medium text-gray-900 hover:text-primary-600">
                    {payment.contract?.project?.title}
                  </Link>
                  {payment.milestone && (
                    <p className="text-sm text-gray-700 mt-1">
                      <Link
                        href={`/contracts/${payment.contractId}/milestones/${payment.milestone.id}`}
                        className="hover:text-primary-600"
                      >
                        #{payment.milestone.sequence} {payment.milestone.title}
                      </Link>
                    </p>
                  )}
                  <p className="text-sm text-gray-500 mt-1">
                    프리랜서: {payment.contract?.freelancer?.name}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    주문번호 {shortOrderId(payment.orderId)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-gray-900">{formatKRW(payment.amount)}</p>
                  <Badge variant={payment.status} className="mt-1">
                    {PAYMENT_STATUS_LABELS[payment.status] || payment.status}
                  </Badge>
                  <p className="text-xs text-gray-400 mt-1">
                    {formatDate(payment.createdAt)}
                  </p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
