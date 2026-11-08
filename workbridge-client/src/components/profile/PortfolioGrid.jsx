'use client';

import ProfileImage from './ProfileImage';
import { formatPeriod } from './profileFormat';
import Tag from '@/components/ui/Tag';

// 포트폴리오 카드 그리드(BEHAVIOR.md PF3, PF5 순서). editable이면 위/아래 이동, 수정, 삭제 버튼을 붙인다.
export default function PortfolioGrid({ items, editable = false, busy = false, onMove, onEdit, onDelete }) {
  if (!items?.length) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {items.map((item, index) => (
        <div key={item.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden flex flex-col">
          <ProfileImage src={item.imageUrl} alt={item.title} className="w-full h-40" />
          <div className="p-4 flex-1 flex flex-col">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-semibold text-gray-900 break-words">{item.title}</h3>
              {item.url && (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-xs text-primary-600 hover:text-primary-700"
                >
                  링크 →
                </a>
              )}
            </div>
            {(item.role || item.startedAt) && (
              <p className="text-xs text-gray-500 mt-1">
                {[item.role, formatPeriod(item.startedAt, item.endedAt)].filter(Boolean).join(' · ')}
              </p>
            )}
            {item.description && (
              <p className="text-sm text-gray-700 mt-2 whitespace-pre-line line-clamp-4">{item.description}</p>
            )}
            {item.skills?.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-3">
                {item.skills.map((skill) => (
                  <Tag key={skill}>{skill}</Tag>
                ))}
              </div>
            )}

            {editable && (
              <div className="mt-auto pt-4 flex items-center justify-between">
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => onMove(index, -1)}
                    disabled={busy || index === 0}
                    className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                    aria-label={`${item.title} 위로 이동`}
                  >
                    ▲ 위로
                  </button>
                  <button
                    type="button"
                    onClick={() => onMove(index, 1)}
                    disabled={busy || index === items.length - 1}
                    className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                    aria-label={`${item.title} 아래로 이동`}
                  >
                    ▼ 아래로
                  </button>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => onEdit(item)} disabled={busy} className="text-xs text-gray-600 hover:text-gray-900">
                    수정
                  </button>
                  <button type="button" onClick={() => onDelete(item)} disabled={busy} className="text-xs text-red-600 hover:text-red-700">
                    삭제
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
