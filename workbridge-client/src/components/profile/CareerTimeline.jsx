'use client';

import { employmentTypeLabel, formatPeriod } from './profileFormat';

// 경력 타임라인(순서: 최근 시작 먼저, 같은 시작이면 재직 중 먼저).
export default function CareerTimeline({ careers, editable = false, busy = false, onEdit, onDelete }) {
  if (!careers?.length) return null;

  return (
    <ol className="relative border-l border-gray-200 ml-2">
      {careers.map((career) => (
        <li key={career.id} className="mb-6 ml-5 last:mb-0">
          <span
            className={`absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-white ${career.endDate ? 'bg-gray-300' : 'bg-primary-500'}`}
          />
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs text-gray-500">
                {formatPeriod(career.startDate, career.endDate, { current: !career.endDate })}
              </p>
              <h3 className="font-semibold text-gray-900 mt-0.5">
                {career.company}
                <span className="ml-2 text-sm font-normal text-gray-600">{career.position}</span>
              </h3>
              <span className="inline-block mt-1 px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs">
                {employmentTypeLabel(career.employmentType)}
              </span>
              {career.description && (
                <p className="text-sm text-gray-700 mt-2 whitespace-pre-line">{career.description}</p>
              )}
            </div>
            {editable && (
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={() => onEdit(career)} disabled={busy} className="text-xs text-gray-600 hover:text-gray-900">
                  수정
                </button>
                <button type="button" onClick={() => onDelete(career)} disabled={busy} className="text-xs text-red-600 hover:text-red-700">
                  삭제
                </button>
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
