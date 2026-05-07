'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import ProjectCard from '@/components/projects/ProjectCard';

const RECOMMENDATION_LIMIT = 3;

export default function ProjectDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { user } = useAuthStore();

  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [applyModal, setApplyModal] = useState(false);
  const [applyForm, setApplyForm] = useState({ coverLetter: '', expectedRate: '', expectedDuration: '' });
  const [applyLoading, setApplyLoading] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [recommendations, setRecommendations] = useState([]);
  const [recommendationsLoading, setRecommendationsLoading] = useState(false);

  useEffect(() => {
    const store = useAuthStore.getState();
    store.initAuth();
  }, []);

  useEffect(() => {
    api.get(`/api/projects/${id}`)
      .then(({ data }) => setProject(data))
      .catch(() => router.push('/projects'))
      .finally(() => setLoading(false));
  }, [id, router]);

  useEffect(() => {
    if (!project?.id) {
      setRecommendations([]);
      return undefined;
    }

    let cancelled = false;

    async function fetchRecommendations() {
      setRecommendationsLoading(true);

      const nextRecommendations = [];
      const seenIds = new Set([project.id]);
      const appendProjects = (projects = []) => {
        for (const item of projects) {
          if (!item?.id || seenIds.has(item.id)) continue;
          seenIds.add(item.id);
          nextRecommendations.push(item);
          if (nextRecommendations.length >= RECOMMENDATION_LIMIT) return;
        }
      };

      try {
        if (project.category) {
          const categoryParams = new URLSearchParams({
            category: project.category,
            status: 'ALL',
            limit: String(RECOMMENDATION_LIMIT + 1),
            sort: 'latest',
          });
          const { data } = await api.get(`/api/projects?${categoryParams}`);
          appendProjects(data.projects);
        }

        if (nextRecommendations.length < RECOMMENDATION_LIMIT) {
          const fallbackParams = new URLSearchParams({
            status: 'ALL',
            limit: String(RECOMMENDATION_LIMIT + 4),
            sort: 'latest',
          });
          const { data } = await api.get(`/api/projects?${fallbackParams}`);
          appendProjects(data.projects);
        }

        if (!cancelled) {
          setRecommendations(nextRecommendations);
        }
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setRecommendations([]);
        }
      } finally {
        if (!cancelled) {
          setRecommendationsLoading(false);
        }
      }
    }

    fetchRecommendations();

    return () => {
      cancelled = true;
    };
  }, [project?.id, project?.category]);

  async function handleApply(e) {
    e.preventDefault();
    setApplyError('');
    setApplyLoading(true);
    try {
      await api.post(`/api/projects/${id}/applications`, applyForm);
      setApplyModal(false);
      router.push('/my/applications');
    } catch (err) {
      setApplyError(err.response?.data?.error?.message || '지원에 실패했습니다');
    } finally {
      setApplyLoading(false);
    }
  }

  async function handleDelete() {
    if (!confirm('프로젝트를 삭제하시겠습니까?')) return;
    try {
      await api.delete(`/api/projects/${id}`);
      router.push('/projects');
    } catch (err) {
      alert(err.response?.data?.error?.message || '삭제에 실패했습니다');
    }
  }

  async function handleCloseProject() {
    if (!confirm('프로젝트 모집을 마감하시겠습니까?')) return;
    try {
      const { data } = await api.patch(`/api/projects/${id}/status`, { status: 'CLOSED' });
      setProject((prev) => ({ ...prev, status: data.status }));
    } catch (err) {
      alert(err.response?.data?.error?.message || '모집 마감에 실패했습니다');
    }
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-3/4" />
          <div className="h-4 bg-gray-200 rounded w-1/4" />
          <div className="h-48 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  if (!project) return null;

  const isOwner = user?.id === project.clientId;
  const isFreelancer = user?.role === 'FREELANCER';
  const canApply = isFreelancer && project.status === 'OPEN';
  const canClose = isOwner && project.status === 'OPEN';

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold text-gray-900">{project.title}</h1>
            <Badge variant={project.status}>{project.status}</Badge>
          </div>
          <p className="text-gray-500 text-sm">
            {project.category} · 지원자 {project._count?.applications || 0}명
          </p>
        </div>

        <div className="flex gap-2">
          {isOwner && (
            <>
              <Link href={`/projects/${id}/edit`}>
                <Button variant="secondary" size="sm">수정</Button>
              </Link>
              <Link href={`/projects/${id}/applications`}>
                <Button variant="secondary" size="sm">지원자 관리</Button>
              </Link>
              <Link href={`/projects/${id}/analysis`}>
                <Button variant="secondary" size="sm">AI 분석</Button>
              </Link>
              {canClose && (
                <Button variant="secondary" size="sm" onClick={handleCloseProject}>모집 마감</Button>
              )}
              <Button variant="danger" size="sm" onClick={handleDelete}>삭제</Button>
            </>
          )}
          {canApply && (
            <Button onClick={() => setApplyModal(true)}>지원하기</Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card className="p-6">
            <h2 className="font-semibold text-gray-900 mb-3">프로젝트 설명</h2>
            <p className="text-gray-700 whitespace-pre-wrap">{project.description}</p>
          </Card>

          {project.requiredSkills?.length > 0 && (
            <Card className="p-6">
              <h2 className="font-semibold text-gray-900 mb-3">필요 기술</h2>
              <div className="flex flex-wrap gap-2">
                {project.requiredSkills.map((skill) => (
                  <span key={skill} className="px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-sm">
                    {skill}
                  </span>
                ))}
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card className="p-5">
            <h2 className="font-semibold text-gray-900 mb-3">프로젝트 정보</h2>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-500">예산</dt>
                <dd className="font-medium">{project.budget?.toLocaleString()}원</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">마감일</dt>
                <dd className="font-medium">{new Date(project.deadline).toLocaleDateString('ko-KR')}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">등록일</dt>
                <dd className="font-medium">{new Date(project.createdAt).toLocaleDateString('ko-KR')}</dd>
              </div>
            </dl>
          </Card>

          <Card className="p-5">
            <h2 className="font-semibold text-gray-900 mb-3">의뢰인</h2>
            <Link href={`/users/${project.client?.id}`} className="flex items-center gap-3 hover:opacity-80">
              <div className="w-10 h-10 bg-primary-100 rounded-full flex items-center justify-center">
                <span className="text-primary-700 font-semibold">
                  {project.client?.name?.[0]?.toUpperCase()}
                </span>
              </div>
              <div>
                <p className="font-medium text-gray-900">{project.client?.name}</p>
                <p className="text-sm text-gray-500">{project.client?.companyName || project.client?.businessField}</p>
              </div>
            </Link>
          </Card>
        </div>
      </div>

      {(recommendationsLoading || recommendations.length > 0) && (
        <section className="mt-10">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between mb-4">
            <div>
              <h2 className="text-xl font-bold text-gray-900">추천 프로젝트</h2>
              <p className="text-sm text-gray-500 mt-1">비슷한 분야의 다른 프로젝트를 확인해보세요</p>
            </div>
            {project.category && (
              <Link
                href={`/projects?category=${encodeURIComponent(project.category)}&status=ALL`}
                className="text-sm font-medium text-primary-700 hover:text-primary-800"
              >
                같은 분야 더 보기
              </Link>
            )}
          </div>

          {recommendationsLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: RECOMMENDATION_LIMIT }).map((_, index) => (
                <div key={index} className="h-48 bg-gray-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {recommendations.map((recommendedProject) => (
                <ProjectCard key={recommendedProject.id} project={recommendedProject} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* Apply Modal */}
      <Modal isOpen={applyModal} onClose={() => setApplyModal(false)} title="프로젝트 지원">
        <form onSubmit={handleApply} className="space-y-4">
          {applyError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {applyError}
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">지원서 <span className="text-red-500">*</span></label>
            <textarea
              value={applyForm.coverLetter}
              onChange={(e) => setApplyForm({ ...applyForm, coverLetter: e.target.value })}
              rows={4}
              required
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
              placeholder="지원 동기와 경험을 자세히 작성해주세요"
            />
          </div>
          <Input
            label="예상 단가 (원)"
            type="number"
            required
            value={applyForm.expectedRate}
            onChange={(e) => setApplyForm({ ...applyForm, expectedRate: e.target.value })}
            placeholder="예: 1500000"
          />
          <Input
            label="예상 기간"
            required
            value={applyForm.expectedDuration}
            onChange={(e) => setApplyForm({ ...applyForm, expectedDuration: e.target.value })}
            placeholder="예: 2주, 1개월"
          />
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="secondary" onClick={() => setApplyModal(false)}>취소</Button>
            <Button type="submit" loading={applyLoading}>지원하기</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
