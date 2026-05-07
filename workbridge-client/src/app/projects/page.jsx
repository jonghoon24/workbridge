'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import useProjectStore from '@/store/projectStore';
import ProjectCard from '@/components/projects/ProjectCard';
import ProjectFilters from '@/components/projects/ProjectFilters';
import api from '@/lib/api';

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

  useEffect(() => {
    if (initialized) return;

    const queryPage = Number.parseInt(searchParams.get('page') || '1', 10);
    const querySort = searchParams.get('sort') || 'latest';

    setFiltersAndPage({
      search: searchParams.get('search') || '',
      category: searchParams.get('category') || '',
      minBudget: searchParams.get('minBudget') || '',
      maxBudget: searchParams.get('maxBudget') || '',
      skills: searchParams.get('skills') || '',
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

      const { data } = await api.get(`/api/projects?${params}`);
      setProjects(data.projects);
      setMeta(data.meta);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, filters.category, filters.minBudget, filters.maxBudget, filters.skills, filters.sort, initialized, page]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">프로젝트 찾기</h1>
        <p className="text-gray-600 mt-1">원하는 프로젝트를 찾아 지원해보세요</p>
      </div>

      {/* Search Bar */}
      <div className="mb-6">
        <input
          type="text"
          value={filters.search}
          onChange={(e) => setFilters({ search: e.target.value })}
          placeholder="프로젝트 검색..."
          className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500"
        />
      </div>

      <div className="flex gap-6">
        {/* Filters Sidebar */}
        <div className="hidden lg:block w-64 flex-shrink-0">
          <ProjectFilters />
        </div>

        {/* Projects Grid */}
        <div className="flex-1">
          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-48 bg-gray-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <div className="text-center py-16 text-gray-500">
              <p className="text-lg">프로젝트가 없습니다</p>
              <p className="text-sm mt-2">다른 검색어나 필터를 사용해보세요</p>
            </div>
          ) : (
            <>
              <p className="text-sm text-gray-500 mb-4">총 {meta.total}개의 프로젝트</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
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
                    className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    이전
                  </button>
                  {Array.from({ length: meta.totalPages }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      className={`px-3 py-1.5 text-sm border rounded-md ${
                        page === p
                          ? 'bg-primary-600 text-white border-primary-600'
                          : 'border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                  <button
                    onClick={() => setPage(page + 1)}
                    disabled={page === meta.totalPages}
                    className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
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
