'use client';

// 목록 페이지의 상태 필터 탭. tabs는 [{ value, label }]이고 value ''가 "전체"다.
// counts를 주면 탭마다 { [value]: 개수 }의 개수를 붙인다.
export default function StatusTabs({ tabs, value, onChange, counts }) {
  return (
    <div className="flex gap-1 border-b border-gray-200 mb-6 overflow-x-auto">
      {tabs.map((tab) => (
        <button
          key={tab.value || 'all'}
          type="button"
          aria-pressed={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap ${
            value === tab.value
              ? 'border-primary-600 text-primary-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          {tab.label}
          {/* The space keeps the accessible name "전체 3" rather than "전체3". */}
          {counts && <>{' '}<span className="ml-1 text-xs text-gray-400">{counts[tab.value] || 0}</span></>}
        </button>
      ))}
    </div>
  );
}
