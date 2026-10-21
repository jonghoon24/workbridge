'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { formatDate, formatKRW } from '@/lib/format';
import { PAYMENT_STATUS_LABELS } from '@/constants/milestones';

export default function MyPaymentsPage() {
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get('/api/payments')
      .then(({ data }) => setPayments(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="max-w-4xl mx-auto px-4 py-8 text-center">로딩 중...</div>;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">결제 내역</h1>

      {payments.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <p>아직 결제 내역이 없습니다</p>
        </div>
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
                        마일스톤 {payment.milestone.sequence}회차 · {payment.milestone.title}
                      </Link>
                    </p>
                  )}
                  <p className="text-sm text-gray-500 mt-1">
                    프리랜서: {payment.contract?.freelancer?.name}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    주문번호: {payment.orderId}
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
