'use client';

import Link from 'next/link';
import SettlementStatusBadge from '@/components/settlements/SettlementStatusBadge';
import { formatDate, formatKRW } from '@/lib/format';

// 정산 기간은 월 00:00 ~ 다음 월 00:00(미포함, M19)이라 끝 날짜는 하루 전(일요일)으로 보여준다.
export function formatPeriod(settlement) {
  const lastDay = new Date(new Date(settlement.periodEnd).getTime() - 1);
  return `${formatDate(settlement.periodStart)} ~ ${formatDate(lastDay)}`;
}

export default function SettlementTable({ settlements = [] }) {
  if (settlements.length === 0) {
    return <p className="py-12 text-center text-sm text-gray-500">아직 정산 내역이 없습니다</p>;
  }

  return (
    <>
      {/* 좁은 화면(sm 미만)에서는 표 대신 카드로 보여준다. */}
      <ul className="sm:hidden divide-y divide-gray-100">
        {settlements.map((settlement) => (
          <li key={settlement.id}>
            <Link href={`/settlements/${settlement.id}`} className="block py-3 hover:bg-gray-50">
              <div className="flex items-start justify-between gap-3">
                <span className="text-sm font-medium text-gray-900">{formatPeriod(settlement)}</span>
                <SettlementStatusBadge status={settlement.status} payoutAttempts={settlement.payoutAttempts} />
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <dt className="text-gray-500">지급일</dt>
                <dd className="text-right text-gray-700">{formatDate(settlement.paidAt || settlement.scheduledPayoutAt)}</dd>
                <dt className="text-gray-500">건수</dt>
                <dd className="text-right text-gray-700">{settlement.itemCount}</dd>
                <dt className="text-gray-500">총액</dt>
                <dd className="text-right text-gray-700">{formatKRW(settlement.grossAmount)}</dd>
                <dt className="text-gray-500">실지급액</dt>
                <dd className="text-right font-medium text-gray-900">{formatKRW(settlement.netAmount)}</dd>
              </dl>
            </Link>
          </li>
        ))}
      </ul>

      <div className="hidden sm:block overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead>
          <tr className="text-left text-xs font-medium text-gray-500">
            <th className="py-3 pr-4">정산 기간</th>
            <th className="py-3 pr-4">지급일</th>
            <th className="py-3 pr-4 text-right">건수</th>
            <th className="py-3 pr-4 text-right">총액</th>
            <th className="py-3 pr-4 text-right">실지급액</th>
            <th className="py-3">상태</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {settlements.map((settlement) => (
            <tr key={settlement.id} className="hover:bg-gray-50">
              <td className="py-3 pr-4 whitespace-nowrap">
                <Link href={`/settlements/${settlement.id}`} className="font-medium text-gray-900 hover:text-primary-600">
                  {formatPeriod(settlement)}
                </Link>
              </td>
              <td className="py-3 pr-4 whitespace-nowrap text-gray-600">
                {formatDate(settlement.paidAt || settlement.scheduledPayoutAt)}
              </td>
              <td className="py-3 pr-4 text-right text-gray-600">{settlement.itemCount}</td>
              <td className="py-3 pr-4 text-right whitespace-nowrap text-gray-600">{formatKRW(settlement.grossAmount)}</td>
              <td className="py-3 pr-4 text-right whitespace-nowrap font-medium text-gray-900">
                {formatKRW(settlement.netAmount)}
              </td>
              <td className="py-3 whitespace-nowrap">
                <SettlementStatusBadge status={settlement.status} payoutAttempts={settlement.payoutAttempts} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </>
  );
}
