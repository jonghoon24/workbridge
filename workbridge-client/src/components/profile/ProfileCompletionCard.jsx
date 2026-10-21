'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import Card from '@/components/ui/Card';
import { COMPLETION_ITEMS, completionLabel } from './completionLabels';

// 프로필 완성도(BEHAVIOR.md PF21). percent는 표시용 점수이고, isComplete는 지원·등록 게이트
// (규칙 4)라서 둘은 따로 움직인다. refreshKey가 바뀌면 다시 불러온다(프로필 저장 직후 등).
export default function ProfileCompletionCard({ refreshKey = 0 }) {
  const [completion, setCompletion] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/users/me/profile-completion')
      .then(({ data }) => {
        setCompletion(data);
        setError('');
      })
      .catch(() => setError('프로필 완성도를 불러오지 못했습니다'));
  }, [refreshKey]);

  if (error) {
    return <Card className="p-4 text-sm text-gray-500">{error}</Card>;
  }
  if (!completion) {
    return <Card className="p-4 text-sm text-gray-400">프로필 완성도 확인 중...</Card>;
  }

  const missing = completion.items.filter((item) => !item.done);
  const barColor = completion.percent >= 80 ? 'bg-green-500' : completion.percent >= 50 ? 'bg-primary-500' : 'bg-yellow-500';

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-900">프로필 완성도</h2>
        <span className="text-lg font-bold text-gray-900">{completion.percent}%</span>
      </div>
      <div
        className="h-2 w-full rounded-full bg-gray-100 overflow-hidden"
        role="progressbar"
        aria-valuenow={completion.percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={`h-full ${barColor} transition-all`} style={{ width: `${completion.percent}%` }} />
      </div>
      <p className={`mt-2 text-xs ${completion.isComplete ? 'text-green-700' : 'text-yellow-700'}`}>
        {completion.isComplete
          ? '필수 항목을 모두 채웠습니다.'
          : '필수 항목이 비어 있어 아직 지원하거나 프로젝트를 등록할 수 없습니다.'}
      </p>

      {missing.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium text-gray-500 mb-2">채우면 좋은 항목</p>
          <ul className="flex flex-wrap gap-2">
            {missing.map((item) => (
              <li key={item.key}>
                <Link
                  href={COMPLETION_ITEMS[item.key]?.href || '/profile'}
                  className="inline-flex items-center gap-1 rounded-full border border-gray-200 px-3 py-1 text-xs text-gray-700 hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700"
                >
                  {completionLabel(item.key)}
                  <span className="text-gray-400">+{item.weight}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
