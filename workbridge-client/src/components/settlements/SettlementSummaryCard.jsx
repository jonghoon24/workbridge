'use client';

import Card from '@/components/ui/Card';
import { formatDate, formatDateTime, formatKRW } from '@/lib/format';

function Stat({ label, value, sub, tone = 'text-gray-900' }) {
  return (
    <div>
      <p className="text-sm text-gray-500">{label}</p>
      <p className={`mt-1 text-xl font-bold ${tone}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

// GET /api/settlements/summary. 모든 정산은 scheduled/onHold/failed/paidTotal 중
// 정확히 하나에 들어간다. 보류와 최종 실패는 있을 때만 보여준다.
export default function SettlementSummaryCard({ summary }) {
  if (!summary) return null;

  const { unsettled = {}, scheduled = {}, onHold = {}, failed = {} } = summary;

  return (
    <Card className="p-6">
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
        <Stat
          label="미정산 (다음 정산 대기)"
          value={formatKRW(unsettled.net || 0)}
          sub={unsettled.count
            ? `승인 ${unsettled.count}건 · 총액 ${formatKRW(unsettled.gross || 0)}에서 수수료·부가세 ${formatKRW(
              (unsettled.fee || 0) + (unsettled.vat || 0)
            )} 차감`
            : '대기 중인 승인 건이 없습니다'}
        />
        <Stat
          label="지급 예정"
          value={formatKRW(scheduled.net || 0)}
          tone="text-primary-600"
          sub={summary.nextPayoutAt
            ? `${scheduled.count || 0}건 · 다음 지급 ${formatDateTime(summary.nextPayoutAt)}`
            : `${scheduled.count || 0}건`}
        />
        <Stat label="누적 지급" value={formatKRW(summary.paidTotal || 0)} tone="text-green-700" />
      </div>

      {(onHold.count > 0 || failed.count > 0) && (
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {onHold.count > 0 && (
            <div className="rounded-lg bg-yellow-50 p-3 text-sm text-yellow-800">
              지급 보류 {onHold.count}건 · {formatKRW(onHold.net)} (지급 계좌 필요)
            </div>
          )}
          {failed.count > 0 && (
            <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
              지급 실패 {failed.count}건 · {formatKRW(failed.net)} (운영팀 확인 중)
            </div>
          )}
        </div>
      )}

      {summary.nextBatchAt && (
        <p className="mt-6 text-xs text-gray-500">
          정산은 매주 월요일 지난주 승인분을 모아 만들고 수요일 10시에 지급합니다. 다음 정산 집계: {formatDate(summary.nextBatchAt)}
        </p>
      )}
    </Card>
  );
}
