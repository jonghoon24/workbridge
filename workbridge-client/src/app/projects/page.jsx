'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import useProjectStore from '@/store/projectStore';
import ProjectCard from '@/components/projects/ProjectCard';
import ProjectFilters, { toBudgetParam } from '@/components/projects/ProjectFilters';
import api from '@/lib/api';
import EmptyState from '@/components/ui/EmptyState';
import { FilterIcon, SearchIcon } from '@/components/ui/Icons';
import PageLoader from '@/components/ui/PageLoader';
import { toUserMessage } from '@/lib/errorMessages';
import useDebounce from '@/lib/useDebounce';
import useBookmarkedProjectIds from '@/lib/useBookmarkedProjectIds';

// 목록 조건(쿼리)의 검증 오류. 같은 이름이 다른 화면에서는 다른 뜻이라(`status`, `skills`) 여기서 정한다.
const LIST_ERRORS = {
  fields: {
    status: '프로젝트 상태 조건이 올바르지 않습니다.',
    skills: '기술 조건이 올바르지 않습니다.',
  },
  codes: { VALIDATION_FAILED: '목록 조건이 올바르지 않습니다. 필터를 다시 선택해 주세요.' },
};

function ProjectsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { filters, page, setFilters, setPage, setFiltersAndPage } = useProjectStore();
  const debouncedSearch = useDebounce(filters.search, 300);
  // 필터나 페이지가 바뀌어도 다시 부르지 않도록 페이지에서 한 번 불러 둔다.
  const { isBookmarked, setBookmarked } = useBookmarkedProjectIds();

  const [projects, setProjects] = useState([]);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
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
      status: ['ALL', 'UPCOMING', 'OPEN', 'CLOSED', 'IN_PROGRESS'].includes(queryStatus) ? queryStatus : 'OPEN',
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

  // 예산 범위는 한 자씩 칠 때마다 요청하지 않도록 검색어처럼 디바운스한다. 입력칸 값은 그대로 두고
  // 보낼 때만 정규화한다('1e6' → '1000000').
  const debouncedMinBudget = toBudgetParam(useDebounce(filters.minBudget, 400));
  const debouncedMaxBudget = toBudgetParam(useDebounce(filters.maxBudget, 400));
  const budgetRangeInvalid = debouncedMinBudget !== ''
    && debouncedMaxBudget !== ''
    && Number(debouncedMinBudget) > Number(debouncedMaxBudget);

  // 조건이 바뀌면 이전 요청을 취소한다(AbortController). 늦게 도착한 이전 응답이 새 결과를 덮지 않는다.
  useEffect(() => {
    if (!initialized) return undefined;

    // 서버도 400으로 거절하는 조합은 보내지 않고 바로 안내한다.
    if (budgetRangeInvalid) {
      setProjects([]);
      setMeta({ total: 0, totalPages: 1 });
      setLoadError('최소 예산이 최대 예산보다 클 수 없습니다.');
      setLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    const params = new URLSearchParams({
      page: String(page),
      limit: '10',
      sort: filters.sort,
    });
    if (debouncedSearch) params.append('search', debouncedSearch);
    if (filters.category) params.append('category', filters.category);
    if (debouncedMinBudget) params.append('minBudget', debouncedMinBudget);
    if (debouncedMaxBudget) params.append('maxBudget', debouncedMaxBudget);
    if (filters.skills) params.append('skills', filters.skills);
    if (filters.status) params.append('status', filters.status);

    setLoading(true);
    api.get(`/api/projects?${params}`, { signal: controller.signal })
      .then(({ data }) => {
        setProjects(data.projects);
        setMeta(data.meta);
        setLoadError('');
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setProjects([]);
        setLoadError(toUserMessage(err, '프로젝트 목록을 불러오지 못했습니다.', LIST_ERRORS));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [
    budgetRangeInvalid,
    debouncedMaxBudget,
    debouncedMinBudget,
    debouncedSearch,
    filters.category,
    filters.skills,
    filters.sort,
    filters.status,
    initialized,
    page,
  ]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900">프로젝트 찾기</h1>
        <p className="text-gray-500 mt-1.5">원하는 프로젝트를 찾아 지원해 보세요</p>
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
          ) : loadError ? (
            <EmptyState tone="error" title={loadError} />
          ) : projects.length === 0 ? (
            <EmptyState
              icon={SearchIcon}
              title="프로젝트가 없습니다"
              description="다른 검색어나 필터를 사용해 보세요."
            />
          ) : (
            <>
              <p className="text-sm text-gray-500 mb-3">총 {meta.total}개의 프로젝트</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
                {projects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    bookmarked={isBookmarked(project.id)}
                    onBookmarkChange={(bookmarked) => setBookmarked(project.id, bookmarked)}
                  />
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
    <Suspense fallback={<PageLoader />}>
      <ProjectsContent />
    </Suspense>
  );
}
