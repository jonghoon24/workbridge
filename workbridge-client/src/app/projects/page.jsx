'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import useProjectStore from '@/store/projectStore';
import ProjectCard from '@/components/projects/ProjectCard';
import ProjectFilters from '@/components/projects/ProjectFilters';
import api from '@/lib/api';
import EmptyState from '@/components/ui/EmptyState';
import { FilterIcon, SearchIcon } from '@/components/ui/Icons';

function useDebounce(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debounced;
}

function ProjectsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { filters, page, setFilters, setPage, setFiltersAndPage } = useProjectStore();
  const debouncedSearch = useDebounce(filters.search, 300);

  const [projects, setProjects] = useState([]);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    if (initialized) return;

    const queryPage = Number.parseInt(searchParams.get('page') || '1', 10);
    const querySort = searchParams.get('sort') || 'latest';
    const queryStatus = searchParams.get('status') || 'OPEN';

    setFiltersAndPage({
      search: searchParams.get('search') || '',
      category: searchParams.get('category') || '',
      minBudget: searchParams.get('minBudget') || '',
      maxBudget: searchParams.get('maxBudget') || '',
      skills: searchParams.get('skills') || '',
      status: ['ALL', 'UPCOMING', 'OPEN', 'CLOSED'].includes(queryStatus) ? queryStatus : 'OPEN',
      sort: ['latest', 'deadline', 'budget'].includes(querySort) ? querySort : 'latest',
    }, Number.isInteger(queryPage) && queryPage > 0 ? queryPage : 1);
    setInitialized(true);
  }, [initialized, searchParams, setFiltersAndPage]);

  useEffect(() => {
    if (!initialized) return;

    const params = new URLSearchParams();
    if (filters.search) params.set('search', filters.search);
    if (filters.category) params.set('category', filters.category);
    if (filters.minBudget) params.set('minBudget', filters.minBudget);
    if (filters.maxBudget) params.set('maxBudget', filters.maxBudget);
    if (filters.skills) params.set('skills', filters.skills);
    if (filters.status !== 'OPEN') params.set('status', filters.status);
    if (filters.sort !== 'latest') params.set('sort', filters.sort);
    if (page > 1) params.set('page', String(page));

    const query = params.toString();
    router.replace(query ? `/projects?${query}` : '/projects', { scroll: false });
  }, [filters, initialized, page, router]);

  const fetchProjects = useCallback(async () => {
    if (!initialized) return;

    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: '10',
        sort: filters.sort,
      });
      if (debouncedSearch) params.append('search', debouncedSearch);
      if (filters.category) params.append('category', filters.category);
      if (filters.minBudget) params.append('minBudget', filters.minBudget);
      if (filters.maxBudget) params.append('maxBudget', filters.maxBudget);
      if (filters.skills) params.append('skills', filters.skills);
      if (filters.status) params.append('status', filters.status);

      const { data } = await api.get(`/api/projects?${params}`);
      setProjects(data.projects);
      setMeta(data.meta);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, filters.category, filters.minBudget, filters.maxBudget, filters.skills, filters.sort, filters.status, initialized, page]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900">프로젝트 찾기</h1>
        <p className="text-gray-500 mt-1.5">원하는 프로젝트를 찾아 지원해보세요</p>
      </div>

      {/* Search Bar */}
      <div className="mb-6 flex gap-2">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={filters.search}
            onChange={(e) => setFilters({ search: e.target.value })}
            placeholder="프로젝트 검색..."
            className="block h-11 w-full rounded-xl border-gray-300 bg-white pl-11 shadow-sm focus:border-primary-500 focus:ring-primary-500"
          />
        </div>
        <button
          type="button"
          onClick={() => setFiltersOpen((open) => !open)}
          aria-expanded={filtersOpen}
          className={`inline-flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border px-4 text-sm font-medium shadow-sm lg:hidden ${
            filtersOpen ? 'border-primary-300 bg-primary-50 text-primary-700' : 'border-gray-300 bg-white text-gray-700'
          }`}
        >
          <FilterIcon className="h-4 w-4" />
          필터
        </button>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Filters Sidebar: 넓은 화면은 왼쪽 고정, 좁은 화면은 '필터' 버튼으로 펼친다. */}
        <div className={`${filtersOpen ? 'block' : 'hidden'} lg:block lg:w-64 lg:flex-shrink-0`}>
          <div className="lg:sticky lg:top-24">
            <ProjectFilters />
          </div>
        </div>

        {/* Projects Grid */}
        <div className="min-w-0 flex-1">
          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-52 rounded-xl border border-gray-200/80 bg-white p-5">
                  <div className="h-4 w-20 rounded bg-gray-100 animate-pulse" />
                  <div className="mt-4 h-5 w-3/4 rounded bg-gray-100 animate-pulse" />
                  <div className="mt-3 h-4 w-full rounded bg-gray-100 animate-pulse" />
                  <div className="mt-2 h-4 w-2/3 rounded bg-gray-100 animate-pulse" />
                </div>
              ))}
            </div>
          ) : projects.length === 0 ? (
            <EmptyState
              icon={SearchIcon}
              title="프로젝트가 없습니다"
              description="다른 검색어나 필터를 사용해보세요"
            />
          ) : (
            <>
              <p className="text-sm text-gray-500 mb-3">총 {meta.total}개의 프로젝트</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
                {projects.map((project) => (
                  <ProjectCard key={project.id} project={project} />
                ))}
              </div>

              {/* Pagination */}
              {meta.totalPages > 1 && (
                <div className="flex justify-center gap-2">
                  <button
                    onClick={() => setPage(page - 1)}
                    disabled={page === 1}
                    className="h-9 px-3 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    이전
                  </button>
                  {Array.from({ length: meta.totalPages }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      className={`h-9 min-w-[2.25rem] px-3 text-sm border rounded-lg ${
                        page === p
                          ? 'bg-primary-600 text-white border-primary-600'
                          : 'bg-white border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                  <button
                    onClick={() => setPage(page + 1)}
                    disabled={page === meta.totalPages}
                    className="h-9 px-3 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    다음
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={<div className="max-w-7xl mx-auto px-4 py-8 text-center">로딩 중...</div>}>
      <ProjectsContent />
    </Suspense>
  );
}
