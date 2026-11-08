'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PROJECT_CATEGORIES } from '@/constants/taxonomy';
import { SearchIcon } from '@/components/ui/Icons';

const visibleCategories = PROJECT_CATEGORIES.filter((category) => category !== '기타');

export default function ProjectDiscovery() {
  const router = useRouter();
  const [keyword, setKeyword] = useState('');

  function handleSubmit(e) {
    e.preventDefault();

    const search = keyword.trim();
    if (!search) {
      router.push('/projects');
      return;
    }

    const params = new URLSearchParams({ search });
    router.push(`/projects?${params.toString()}`);
  }

  return (
    <section className="py-10 sm:py-14 bg-white border-b border-gray-100">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-5">
          <h2 className="text-xl sm:text-2xl font-bold text-gray-900">프로젝트 빠른 탐색</h2>
          <p className="text-gray-600 mt-1">키워드나 카테고리로 바로 프로젝트를 찾아보세요</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400" />
            <input
              type="search"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="예: React, 디자인, 챗봇"
              className="block h-12 w-full rounded-xl border-gray-300 pl-11 shadow-sm focus:border-primary-500 focus:ring-primary-500"
            />
          </div>
          <button
            type="submit"
            className="inline-flex h-12 shrink-0 items-center justify-center whitespace-nowrap rounded-xl bg-primary-600 px-7 text-[15px] font-semibold text-white shadow-sm transition-colors hover:bg-primary-700"
          >
            검색
          </button>
        </form>

        <div className="mt-5 flex flex-wrap gap-2">
          {visibleCategories.map((category) => (
            <Link
              key={category}
              href={`/projects?category=${encodeURIComponent(category)}`}
              className="whitespace-nowrap rounded-full border border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700"
            >
              {category}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
