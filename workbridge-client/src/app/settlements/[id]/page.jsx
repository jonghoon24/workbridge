'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import SettlementStatusBadge from '@/components/settlements/SettlementStatusBadge';
import { formatPeriod } from '@/components/settlements/SettlementTable';
import { formatDate, formatDateTime, formatKRW } from '@/lib/format';
import { MAX_PAYOUT_ATTEMPTS } from '@/constants/milestones';
import PageLoader from '@/components/ui/PageLoader';
import EmptyState from '@/components/ui/EmptyState';


export default function SettlementDetailPage() {
  const { id } = useParams();
  const [settlement, setSettlement] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    useAuthStore.getState().initAuth();
    const currentUser = useAuthStore.getState().user;
    if (currentUser && currentUser.role !== 'FREELANCER') {
      setError('정산은 프리랜서 회원만 이용할 수 있습니다.');
      setLoading(false);
      return;
    }
    api.get(`/api/settlements/${id}`)
      .then(({ data }) => setSettlement(data))
      .catch((err) => {
        setError(err.response?.data?.error?.message || '정산 내역을 불러오지 못했습니다');
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <PageLoader />;

  if (error || !settlement) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12">
        <EmptyState
          tone="error"
          title={error || '정산을 찾을 수 없습니다'}
          action={(
            <Link href="/settlements" className="text-primary-600 hover:text-primary-700 font-semibold">
              정산 목록으로 →
            </Link>
          )}
        />
      </div>
    );
  }

  const items = settlement.items || [];
  const retrying = settlement.status === 'FAILED' && settlement.payoutAttempts < MAX_PAYOUT_ATTEMPTS;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <nav className="text-sm text-gray-500 mb-4">
        <Link href="/settlements" className="hover:text-gray-700">정산</Link>
        <span className="mx-2">/</span>
        <span>{formatPeriod(settlement)}</span>
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-bold text-gray-900">정산 상세</h1>
        <SettlementStatusBadge status={settlement.status} payoutAttempts={settlement.payoutAttempts} />
      </div>

      <div className="space-y-4">
        {settlement.status === 'ON_HOLD' && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <p className="text-sm text-yellow-800">
              지급 계좌가 없어 지급이 보류되었습니다. 계좌를 등록하면 다음 지급일(수요일 10시)에 다시 지급합니다.
            </p>
            <Link href="/settlements/account" className="text-sm font-medium text-yellow-900 hover:underline whitespace-nowrap">
              계좌 등록하기 →
            </Link>
          </div>
        )}
        {settlement.status === 'FAILED' && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {retrying
              ? `지급에 실패했습니다. ${formatDateTime(settlement.scheduledPayoutAt)}에 다시 시도합니다 (${settlement.payoutAttempts}/${MAX_PAYOUT_ATTEMPTS}회 시도).`
              : `지급에 ${MAX_PAYOUT_ATTEMPTS}회 실패했습니다. 운영팀이 확인 후 처리합니다.`}
            {settlement.failureReason && <span className="block mt-1 text-red-600">사유: {settlement.failureReason}</span>}
          </div>
        )}

        <Card className="p-6">
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-gray-500">정산 기간</dt>
              <dd className="font-medium mt-1">{formatPeriod(settlement)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">{settlement.paidAt ? '지급일' : '지급 예정일'}</dt>
              <dd className="font-medium mt-1">{formatDateTime(settlement.paidAt || settlement.scheduledPayoutAt)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">항목</dt>
              <dd className="font-medium mt-1">{settlement.itemCount}건</dd>
            </div>
            <div>
              <dt className="text-gray-500">총액</dt>
              <dd className="font-medium mt-1">{formatKRW(settlement.grossAmount)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">수수료 + 부가세</dt>
              <dd className="font-medium mt-1">- {formatKRW(settlement.feeAmount + settlement.feeVatAmount)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">실지급액</dt>
              <dd className="font-bold text-primary-600 mt-1">{formatKRW(settlement.netAmount)}</dd>
            </div>
            {settlement.bankName && (
              <div className="col-span-2 sm:col-span-3">
                <dt className="text-gray-500">지급 계좌</dt>
                <dd className="font-medium mt-1">
                  {settlement.bankName} {settlement.accountNumberMasked} ({settlement.accountHolder})
                </dd>
              </div>
            )}
          </dl>
        </Card>

        <Card className="p-6">
          <h2 className="font-semibold text-gray-900 mb-4">정산 항목</h2>
          {/* 좁은 화면(sm 미만)에서는 표 대신 항목마다 카드로 보여준다. */}
          <ul className="sm:hidden divide-y divide-gray-100">
            {items.map((item) => (
              <li key={item.id} className="py-3">
                {item.projectDeleted ? (
                  <span className="text-sm font-medium text-gray-900">
                    #{item.milestoneSequence} {item.milestoneTitle}
                  </span>
                ) : (
                  <Link
                    href={`/contracts/${item.contractId}/milestones/${item.milestoneId}`}
                    className="text-sm font-medium text-gray-900 hover:text-primary-600"
                  >
                    #{item.milestoneSequence} {item.milestoneTitle}
                  </Link>
                )}
                <p className="text-xs text-gray-500 mt-0.5">
                  {item.projectTitle}
                  {item.projectDeleted && <span className="ml-1 text-gray-400">(삭제된 프로젝트)</span>}
                  <span className="ml-1">· {formatDate(item.approvedAt)} 승인</span>
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <dt className="text-gray-500">총액</dt>
                  <dd className="text-right text-gray-700">{formatKRW(item.grossAmount)}</dd>
                  <dt className="text-gray-500">수수료 ({item.feeRateBps / 100}%)</dt>
                  <dd className="text-right text-gray-700">{formatKRW(item.feeAmount)}</dd>
                  <dt className="text-gray-500">VAT</dt>
                  <dd className="text-right text-gray-700">{formatKRW(item.feeVatAmount)}</dd>
                  <dt className="text-gray-500">실지급</dt>
                  <dd className="text-right font-medium text-gray-900">{formatKRW(item.netAmount)}</dd>
                </dl>
              </li>
            ))}
            <li className="py-3">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm font-semibold text-gray-900">
                <dt>합계 총액</dt>
                <dd className="text-right">{formatKRW(settlement.grossAmount)}</dd>
                <dt>수수료 · VAT</dt>
                <dd className="text-right">{formatKRW(settlement.feeAmount)} · {formatKRW(settlement.feeVatAmount)}</dd>
                <dt>실지급</dt>
                <dd className="text-right text-primary-600">{formatKRW(settlement.netAmount)}</dd>
              </dl>
            </li>
          </ul>
          <div className="hidden sm:block overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead>
                <tr className="text-left text-xs font-medium text-gray-500">
                  <th className="py-3 pr-4">마일스톤</th>
                  <th className="py-3 pr-4">승인일</th>
                  <th className="py-3 pr-4 text-right">총액</th>
                  <th className="py-3 pr-4 text-right">수수료</th>
                  <th className="py-3 pr-4 text-right">VAT</th>
                  <th className="py-3 text-right">실지급</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="py-3 pr-4">
                      {item.projectDeleted ? (
                        <span className="font-medium text-gray-900">
                          #{item.milestoneSequence} {item.milestoneTitle}
                        </span>
                      ) : (
                        <Link
                          href={`/contracts/${item.contractId}/milestones/${item.milestoneId}`}
                          className="font-medium text-gray-900 hover:text-primary-600"
                        >
                          #{item.milestoneSequence} {item.milestoneTitle}
                        </Link>
                      )}
                      <p className="text-xs text-gray-500 mt-0.5">
                        {item.projectTitle}
                        {item.projectDeleted && <span className="ml-1 text-gray-400">(삭제된 프로젝트)</span>}
                      </p>
                    </td>
                    <td className="py-3 pr-4 whitespace-nowrap text-gray-600">{formatDate(item.approvedAt)}</td>
                    <td className="py-3 pr-4 text-right whitespace-nowrap">{formatKRW(item.grossAmount)}</td>
                    <td className="py-3 pr-4 text-right whitespace-nowrap text-gray-600">
                      {formatKRW(item.feeAmount)}
                      <span className="block text-xs text-gray-400">{item.feeRateBps / 100}%</span>
                    </td>
                    <td className="py-3 pr-4 text-right whitespace-nowrap text-gray-600">{formatKRW(item.feeVatAmount)}</td>
                    <td className="py-3 text-right whitespace-nowrap font-medium text-gray-900">{formatKRW(item.netAmount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-gray-200 font-semibold text-gray-900">
                  <td className="py-3 pr-4" colSpan={2}>합계</td>
                  <td className="py-3 pr-4 text-right whitespace-nowrap">{formatKRW(settlement.grossAmount)}</td>
                  <td className="py-3 pr-4 text-right whitespace-nowrap">{formatKRW(settlement.feeAmount)}</td>
                  <td className="py-3 pr-4 text-right whitespace-nowrap">{formatKRW(settlement.feeVatAmount)}</td>
                  <td className="py-3 text-right whitespace-nowrap text-primary-600">{formatKRW(settlement.netAmount)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-4 text-xs text-gray-500">
            수수료와 부가세는 항목마다 원 단위 미만을 버려 계산하며, 합계는 항목 값의 합입니다.
          </p>
        </Card>
      </div>
    </div>
  );
}
