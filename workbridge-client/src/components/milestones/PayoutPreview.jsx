'use client';

import { formatKRW } from '@/lib/format';

// 서버가 계산한 payoutPreview {gross, fee, vat, net}를 그대로 보여준다(BEHAVIOR.md MS1).
// 화면에서 다시 계산하지 않는다. 승인 후에는 정산 항목의 저장값이다.
export default function PayoutPreview({ preview, compact = false }) {
  if (!preview) return null;

  const rows = [
    { label: '마일스톤 금액', value: preview.gross },
    { label: '플랫폼 수수료', value: -preview.fee },
    { label: '수수료 부가세', value: -preview.vat },
  ];

  if (compact) {
    return (
      <p className="text-xs text-gray-500">
        실지급 예정 {formatKRW(preview.net)} (수수료 {formatKRW(preview.fee)}, 부가세 {formatKRW(preview.vat)} 차감)
      </p>
    );
  }

  return (
    <dl className="space-y-2 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="flex justify-between">
          <dt className="text-gray-500">{row.label}</dt>
          <dd className="font-medium text-gray-900">
            {row.value < 0 ? `- ${formatKRW(-row.value)}` : formatKRW(row.value)}
          </dd>
        </div>
      ))}
      <div className="flex justify-between border-t border-gray-100 pt-2">
        <dt className="font-semibold text-gray-900">프리랜서 실지급액</dt>
        <dd className="font-bold text-primary-600">{formatKRW(preview.net)}</dd>
      </div>
    </dl>
  );
}
