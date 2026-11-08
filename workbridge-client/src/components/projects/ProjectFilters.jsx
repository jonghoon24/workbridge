'use client';

import { useCallback } from 'react';
import useProjectStore from '@/store/projectStore';
import CheckboxChips from '@/components/ui/CheckboxChips';
import { normalizeSkillList, PROJECT_CATEGORIES, SKILL_OPTIONS } from '@/constants/taxonomy';

const PROJECT_STATUS_OPTIONS = [
  { value: 'OPEN', label: '모집 중' },
  { value: 'UPCOMING', label: '모집 예정' },
  { value: 'CLOSED', label: '모집마감' },
  { value: 'ALL', label: '전체' },
];

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
