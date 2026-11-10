'use client';

import { useCallback } from 'react';
import useProjectStore from '@/store/projectStore';
import CheckboxChips from '@/components/ui/CheckboxChips';
import { normalizeSkillList, PROJECT_CATEGORIES, SKILL_OPTIONS } from '@/constants/taxonomy';

const PROJECT_STATUS_OPTIONS = [
  { value: 'OPEN', label: '모집 중' },
  { value: 'UPCOMING', label: '모집 예정' },
  { value: 'CLOSED', label: '모집 마감' },
  { value: 'IN_PROGRESS', label: '진행 중' },
  { value: 'ALL', label: '전체' },
];

/**
 * 예산 입력칸 값을 쿼리 값으로. 숫자 입력칸은 '1e6'·'1.5e3' 같은 지수 표기도 그대로 주는데 서버는
 * 십진수만 받으므로(`1e6` → 400) 보내기 전에 숫자로 읽어 다시 문자열로 쓴다(프로필 화면과 같은 방식).
 * 빈 값과 유한하지 않은 값은 ''(조건 없음).
 */
export function toBudgetParam(value) {
  if (value === '' || value === null || value === undefined) return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  // String()은 아주 크거나 작은 수를 다시 지수 표기로 쓰므로('1e+21', '1e-7') 십진수로 풀어 쓴다.
  return number.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

export default function ProjectFilters() {
  const { filters, setFilters, resetFilters } = useProjectStore();
  const selectedSkills = normalizeSkillList(filters.skills);

  const handleChange = useCallback(
    (key, value) => {
      setFilters({ [key]: value });
    },
    [setFilters]
  );

  return (
    <div className="bg-white rounded-xl border border-gray-200/80 shadow-card p-5 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-gray-900">필터</h3>
        <button onClick={resetFilters} className="text-sm font-medium text-primary-600 hover:text-primary-700">
          초기화
        </button>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">모집 상태</label>
        <select
          value={filters.status}
          onChange={(e) => handleChange('status', e.target.value)}
          className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
        >
          {PROJECT_STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">카테고리</label>
        <select
          value={filters.category}
          onChange={(e) => handleChange('category', e.target.value)}
          className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
        >
          <option value="">전체</option>
          {PROJECT_CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">예산 범위</label>
        <div className="flex gap-2 items-center">
          <input
            type="number"
            value={filters.minBudget}
            onChange={(e) => handleChange('minBudget', e.target.value)}
            placeholder="최소"
            className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
          />
          <span className="text-gray-500">~</span>
          <input
            type="number"
            value={filters.maxBudget}
            onChange={(e) => handleChange('maxBudget', e.target.value)}
            placeholder="최대"
            className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">기술 스택</label>
        <div className="max-h-60 overflow-y-auto pr-1 pb-3 [mask-image:linear-gradient(to_bottom,black_80%,transparent)]">
          <CheckboxChips
            options={SKILL_OPTIONS}
            value={selectedSkills}
            onChange={(nextSkills) => handleChange('skills', normalizeSkillList(nextSkills).join(','))}
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">정렬</label>
        <select
          value={filters.sort}
          onChange={(e) => handleChange('sort', e.target.value)}
          className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
        >
          <option value="latest">최신순</option>
          <option value="deadline">마감임박순</option>
          <option value="budget">예산 높은순</option>
        </select>
      </div>
    </div>
  );
}
