'use client';

import { useCallback } from 'react';
import useProjectStore from '@/store/projectStore';

const CATEGORIES = ['웹 개발', '모바일 앱', '디자인', 'AI/ML', '데이터 분석', '마케팅', '기타'];

export default function ProjectFilters() {
  const { filters, setFilters, resetFilters } = useProjectStore();

  const handleChange = useCallback(
    (key, value) => {
      setFilters({ [key]: value });
    },
    [setFilters]
  );

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-gray-900">필터</h3>
        <button onClick={resetFilters} className="text-sm text-primary-600 hover:text-primary-700">
          초기화
        </button>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">카테고리</label>
        <select
          value={filters.category}
          onChange={(e) => handleChange('category', e.target.value)}
          className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
        >
          <option value="">전체</option>
          {CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">예산 범위</label>
        <div className="flex gap-2 items-center">
          <input
            type="number"
            value={filters.minBudget}
            onChange={(e) => handleChange('minBudget', e.target.value)}
            placeholder="최소"
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
          />
          <span className="text-gray-500">~</span>
          <input
            type="number"
            value={filters.maxBudget}
            onChange={(e) => handleChange('maxBudget', e.target.value)}
            placeholder="최대"
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">기술 스택</label>
        <input
          type="text"
          value={filters.skills}
          onChange={(e) => handleChange('skills', e.target.value)}
          placeholder="React, Python (쉼표 구분)"
          className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">정렬</label>
        <select
          value={filters.sort}
          onChange={(e) => handleChange('sort', e.target.value)}
          className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
        >
          <option value="latest">최신순</option>
          <option value="deadline">마감임박순</option>
          <option value="budget">예산 높은순</option>
        </select>
      </div>
    </div>
  );
}
