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
    <div className="overflow-x-auto">
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
  );
}
