'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import Tag from '@/components/ui/Tag';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import ProjectCardGrid from '@/components/projects/ProjectCardGrid';
import ProjectBookmarkButton from '@/components/projects/ProjectBookmarkButton';
import { getProfileCompletionMessage, isProfileComplete } from '@/lib/profileCompletion';
import { errorCode, toUserMessage } from '@/lib/errorMessages';
import { formatDate, kstToday, toKstDateInput } from '@/lib/format';
import { BookmarkIcon } from '@/components/ui/Icons';

const RECOMMENDATION_LIMIT = 3;

// 다시 모집하기(상태 변경)의 검증 오류 — `deadline`이 이 화면에서는 새 마감일이다.
const REOPEN_FIELDS = {
  deadline: { REQUIRED: '새 마감일을 선택해 주세요.' },
  status: '바꿀 프로젝트 상태가 올바르지 않습니다.',
};

export default function ProjectDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { user } = useAuthStore();

  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [applyModal, setApplyModal] = useState(false);
  const [applyForm, setApplyForm] = useState({ coverLetter: '', expectedRate: '', expectedDuration: '' });
  const [applyLoading, setApplyLoading] = useState(false);
  const [profileChecking, setProfileChecking] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [recommendations, setRecommendations] = useState([]);
  const [recommendationsLoading, setRecommendationsLoading] = useState(false);
  // 프리랜서가 이 프로젝트에 이미 지원했는지. 지원했으면 '지원하기' 대신 '지원 완료'를 보여 준다.
  // status: 'loading' | 'done' | 'error'. 확인하기 전이나 확인하지 못했을 때는 '지원하기'를 보여 주지
  // 않는다 — 이미 지원한 프리랜서에게 폼을 다시 열어 주게 된다(서버는 409로 막는다). 결과는 조회한
  // 프로젝트 id와 묶어 두어 다른 프로젝트로 옮겨 갈 때 이전 결과를 쓰지 않는다.
  const [applicationLookup, setApplicationLookup] = useState({ projectId: null, status: 'loading', application: null });
  const [applicationRetry, setApplicationRetry] = useState(0);
  // 의뢰인: 이 프로젝트의 계약 현황(지원자 목록의 계약 상태로 판단). 계약이 하나라도 있으면 상대방의 기록이라
  // 삭제할 수 없고(서버 409), 철회되지 않은 계약(서명 대기 등)이 있으면 다시 모집할 수 없다(서버 409).
  // null은 아직 모름 — 그동안은 두 버튼을 보여 주지 않는다.
  const [contractState, setContractState] = useState(null);
  const [reopenModal, setReopenModal] = useState(false);
  const [reopenDeadline, setReopenDeadline] = useState('');
  const [reopenError, setReopenError] = useState('');
  const [reopening, setReopening] = useState(false);
  const applicationCheck = applicationLookup.projectId === id ? applicationLookup.status : 'loading';
  const myApplication = applicationLookup.projectId === id ? applicationLookup.application : null;

  useEffect(() => {
    const store = useAuthStore.getState();
    store.initAuth();
  }, []);

  useEffect(() => {
    setLoading(true);
    setError('');

    api.get(`/api/projects/${id}`)
      .then(({ data }) => setProject(data))
      .catch((err) => {
        setProject(null);
        setError(toUserMessage(err, '프로젝트를 불러오지 못했습니다.'));
      })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (user?.role !== 'FREELANCER') return undefined;
    let ignore = false;
    setApplicationLookup({ projectId: id, status: 'loading', application: null });
    api.get('/api/users/me/applications')
      .then(({ data }) => {
        if (ignore) return;
        const application = data.find((item) => item.project?.id === id) || null;
        setApplicationLookup({ projectId: id, status: 'done', application });
      })
      .catch(() => {
        if (!ignore) setApplicationLookup({ projectId: id, status: 'error', application: null });
      });
    return () => {
      ignore = true;
    };
  }, [id, user?.role, applicationRetry]);

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
            status: 'OPEN',
            limit: String(RECOMMENDATION_LIMIT + 1),
            sort: 'latest',
          });
          const { data } = await api.get(`/api/projects?${categoryParams}`);
          appendProjects(data.projects);
        }

        if (nextRecommendations.length < RECOMMENDATION_LIMIT) {
          const fallbackParams = new URLSearchParams({
            status: 'OPEN',
            limit: String(RECOMMENDATION_LIMIT + 4),
            sort: 'latest',
          });
          const { data } = await api.get(`/api/projects?${fallbackParams}`);
          appendProjects(data.projects);
        }

        if (!cancelled) {
          setRecommendations(nextRecommendations);
        }
      } catch {
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

  const ownsProject = Boolean(project && user?.id === project.clientId);
  // 다시 모집할 마감일의 하한: 오늘과 모집 시작일 중 늦은 날(서버도 같은 규칙으로 400).
  const reopenStartDate = project?.recruitmentStartDate ? toKstDateInput(project.recruitmentStartDate) : '';
  const reopenMinDate = reopenStartDate > kstToday() ? reopenStartDate : kstToday();

  useEffect(() => {
    if (!ownsProject) {
      setContractState(null);
      return undefined;
    }
    let ignore = false;
    api.get(`/api/projects/${id}/applications`)
      .then(({ data }) => {
        if (ignore) return;
        const contracts = data.filter((app) => app.contract).map((app) => app.contract);
        setContractState({
          hasAny: contracts.length > 0,
          hasLive: contracts.some((contract) => contract.status !== 'CANCELLED'),
        });
      })
      .catch(() => {
        if (!ignore) setContractState(null);
      });
    return () => {
      ignore = true;
    };
  }, [id, ownsProject, project?.status]);

  function openReopen() {
    setReopenDeadline('');
    setReopenError('');
    setReopenModal(true);
  }

  async function handleReopen(e) {
    e.preventDefault();
    if (!reopenDeadline) {
      setReopenError('새 마감일을 선택해 주세요.');
      return;
    }
    if (reopenDeadline < kstToday()) {
      setReopenError('마감일은 오늘 이후로 선택해 주세요.');
      return;
    }
    if (reopenStartDate && reopenDeadline < reopenStartDate) {
      setReopenError(`마감일은 모집 시작일(${formatDate(project.recruitmentStartDate)}) 이후로 선택해 주세요.`);
      return;
    }
    setReopening(true);
    setReopenError('');
    try {
      const { data } = await api.patch(`/api/projects/${id}/status`, { status: 'OPEN', deadline: reopenDeadline });
      setProject((prev) => ({ ...prev, status: data.status, deadline: data.deadline }));
      setReopenModal(false);
    } catch (err) {
      setReopenError(toUserMessage(err, '다시 모집하지 못했습니다.', { fields: REOPEN_FIELDS }));
    } finally {
      setReopening(false);
    }
  }

  async function handleApply(e) {
    e.preventDefault();
    setApplyError('');
    if (!applyForm.coverLetter.trim()) {
      setApplyError('지원서를 입력해 주세요.');
      return;
    }
    // 희망 금액은 원 단위 정수다(서버도 소수를 400으로 거절한다). 숫자 입력칸은 '1.5'·'-1'·'1e6'을
    // 그대로 주고, 숫자가 아닌 입력은 ''을 준다 — 모두 여기서 걸린다.
    const rate = String(applyForm.expectedRate).trim();
    if (!/^\d+$/.test(rate) || Number(rate) < 1) {
      setApplyError('희망 금액은 1원 이상의 원 단위 정수로 입력해 주세요.');
      return;
    }
    if (!applyForm.expectedDuration.trim()) {
      setApplyError('예상 기간을 입력해 주세요.');
      return;
    }
    setApplyLoading(true);
    try {
      await api.post(`/api/projects/${id}/applications`, applyForm);
      setApplyModal(false);
      router.push('/my/applications');
    } catch (err) {
      if (errorCode(err) === 'PROFILE_INCOMPLETE') {
        alert(getProfileCompletionMessage('FREELANCER'));
        setApplyModal(false);
        router.push('/profile');
        return;
      }
      setApplyError(toUserMessage(err, '지원에 실패했습니다.'));
    } finally {
      setApplyLoading(false);
    }
  }

  async function handleOpenApply() {
    // 다시 지원하면 이전 지원서 내용을 채워 둔다(고쳐서 보낸다).
    if (myApplication?.canReapply) {
      setApplyForm({
        coverLetter: myApplication.coverLetter || '',
        expectedRate: myApplication.expectedRate ? String(myApplication.expectedRate) : '',
        expectedDuration: myApplication.expectedDuration || '',
      });
    }
    setApplyError('');
    setProfileChecking(true);
    try {
      const { data } = await api.get('/api/users/me');
      if (!isProfileComplete(data)) {
        alert(getProfileCompletionMessage(data.role));
        router.push('/profile');
        return;
      }

      setApplyModal(true);
    } catch (err) {
      alert(toUserMessage(err, '프로필을 확인하지 못했습니다.'));
    } finally {
      setProfileChecking(false);
    }
  }

  async function handleDelete() {
    if (!confirm('프로젝트를 삭제하시겠습니까? 삭제하면 되돌릴 수 없습니다.')) return;
    try {
      await api.delete(`/api/projects/${id}`);
      router.push('/projects');
    } catch (err) {
      alert(toUserMessage(err, '프로젝트를 삭제하지 못했습니다.'));
    }
  }

  async function handleCloseProject() {
    if (!confirm('프로젝트 모집을 마감하시겠습니까?')) return;
    try {
      const { data } = await api.patch(`/api/projects/${id}/status`, { status: 'CLOSED' });
      setProject((prev) => ({ ...prev, status: data.status }));
    } catch (err) {
      alert(toUserMessage(err, '모집을 마감하지 못했습니다.'));
    }
  }

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-5 bg-gray-200 rounded-full w-16" />
          <div className="h-8 bg-gray-200 rounded-lg w-3/4" />
          <div className="h-4 bg-gray-200 rounded w-1/4" />
          <div className="h-48 bg-gray-200/70 rounded-xl" />
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Card className="p-6">
          <h1 className="text-xl font-bold text-gray-900">프로젝트를 찾을 수 없습니다</h1>
          <p className="text-sm text-gray-600 mt-2">
            {error || '요청한 프로젝트가 삭제되었거나 일시적으로 불러올 수 없습니다.'}
          </p>
          <div className="mt-5">
            <Link href="/projects">
              <Button variant="secondary">프로젝트 찾기로 이동</Button>
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  const isOwner = user?.id === project.clientId;
  const isFreelancer = user?.role === 'FREELANCER';
  const isGuest = !user;
  // 철회된 계약으로 끝난 이전 모집에서 거절된 지원자는 다시 열린 모집에 다시 지원할 수 있다(서버가 canReapply로 알려 준다).
  const canReapply = Boolean(myApplication?.canReapply);
  const canApply = isFreelancer && project.status === 'OPEN' && applicationCheck === 'done' && (!myApplication || canReapply);
  const canReopen = isOwner && project.status === 'CLOSED' && contractState?.hasLive === false;
  // 계약이 하나라도 있으면 삭제할 수 없다(상대방의 기록). 확인 전에는 버튼을 막아 둔다.
  const canDelete = contractState?.hasAny === false;
  const deleteBlocked = contractState?.hasAny === true;
  // 철회된 계약의 당사자였던 프리랜서는 같은 프로젝트에 다시 지원할 수 없다. 이유를 알려 준다.
  const wasCancelledParty = myApplication?.contract?.status === 'CANCELLED';
  const loginHref = `/login?redirect=${encodeURIComponent(`/projects/${id}`)}`;
  const canClose = isOwner && project.status === 'OPEN';
  const ownerActionCount = 2 + (canClose ? 1 : 0) + (canReopen ? 1 : 0) + (canDelete ? 1 : 0);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-6">
        <div className="min-w-0">
          <div className="mb-2">
            <Badge variant={project.status}>{project.status}</Badge>
          </div>
          <h1 className="text-2xl sm:text-[28px] font-bold leading-tight text-gray-900">{project.title}</h1>
          <p className="text-gray-500 text-sm mt-2">
            {project.category} · 지원자 {project._count?.applications || 0}명
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
          {isFreelancer && (
            <ProjectBookmarkButton projectId={id} />
          )}
          {isGuest && project.status === 'OPEN' && (
            <>
              <Link
                href={loginHref}
                className="inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-500 transition-colors hover:border-primary-200 hover:text-primary-700"
              >
                <BookmarkIcon className="h-3.5 w-3.5" />
                북마크
              </Link>
              <Link href={loginHref}>
                <Button>로그인하고 지원하기</Button>
              </Link>
            </>
          )}
          {isFreelancer && myApplication && !canReapply && (
            <Link href="/my/applications">
              <Button variant="secondary">지원 완료 · 내 지원 현황</Button>
            </Link>
          )}
          {isFreelancer && wasCancelledParty && project.status === 'OPEN' && (
            <p className="w-full text-sm text-gray-500 sm:text-right">
              철회된 계약의 당사자는 같은 프로젝트에 다시 지원할 수 없습니다.
            </p>
          )}
          {isFreelancer && applicationCheck === 'error' && (
            <>
              <span className="text-sm text-red-600" role="alert">지원 여부를 확인하지 못했습니다.</span>
              <Button variant="secondary" size="sm" onClick={() => setApplicationRetry((count) => count + 1)}>
                다시 시도
              </Button>
            </>
          )}
          {isOwner && (
            // 모바일에서는 버튼 수에 맞춘 격자(3개면 3열, 그 밖에는 2열)로 둬서 버튼 하나만 다음 줄로 떨어지지 않게 한다.
            <div className={`grid w-full ${ownerActionCount === 3 ? 'grid-cols-3' : 'grid-cols-2'} gap-2 sm:flex sm:w-auto sm:flex-wrap sm:justify-end`}>
              <Link href={`/projects/${id}/edit`} className="contents sm:block">
                <Button variant="secondary" size="sm" className="w-full">수정</Button>
              </Link>
              <Link href={`/projects/${id}/applications`} className="contents sm:block">
                <Button variant="secondary" size="sm" className="w-full">지원자 관리</Button>
              </Link>
              {canClose && (
                <Button variant="secondary" size="sm" onClick={handleCloseProject}>모집 마감</Button>
              )}
              {canReopen && (
                <Button variant="secondary" size="sm" onClick={openReopen}>다시 모집하기</Button>
              )}
              {canDelete && (
                <Button variant="dangerText" size="sm" onClick={handleDelete}>삭제</Button>
              )}
            </div>
          )}
          {isOwner && deleteBlocked && (
            <p className="w-full text-xs text-gray-500 sm:text-right">
              계약 기록이 있는 프로젝트는 상대방의 기록이라 삭제할 수 없습니다.
            </p>
          )}
          {canApply && (
            <Button onClick={handleOpenApply} loading={profileChecking}>{canReapply ? '다시 지원하기' : '지원하기'}</Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card className="p-6">
            <h2 className="font-semibold text-gray-900 mb-3">프로젝트 설명</h2>
            <p className="text-[15px] leading-7 text-gray-700 whitespace-pre-wrap break-words">{project.description}</p>
          </Card>

          {project.requiredSkills?.length > 0 && (
            <Card className="p-6">
              <h2 className="font-semibold text-gray-900 mb-3">필요 기술</h2>
              <div className="flex flex-wrap gap-2">
                {project.requiredSkills.map((skill) => (
                  <Tag key={skill} size="md">
                    {skill}
                  </Tag>
                ))}
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card className="p-5">
            <h2 className="font-semibold text-gray-900 mb-3">프로젝트 정보</h2>
            <dl className="space-y-2.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-500">예산</dt>
                <dd className="font-bold text-gray-900">{project.budget?.toLocaleString()}원</dd>
              </div>
              {project.recruitmentStartDate && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">모집 시작일</dt>
                  <dd className="font-medium">{formatDate(project.recruitmentStartDate)}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-gray-500">마감일</dt>
                <dd className="font-medium">{formatDate(project.deadline)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">등록일</dt>
                <dd className="font-medium">{formatDate(project.createdAt)}</dd>
              </div>
            </dl>
          </Card>

          <Card className="p-5">
            <h2 className="font-semibold text-gray-900 mb-3">의뢰인</h2>
            <Link href={`/users/${project.client?.id}`} className="flex items-center gap-3 hover:opacity-80">
              <div className="w-10 h-10 shrink-0 bg-primary-100 rounded-full flex items-center justify-center">
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
              <p className="text-sm text-gray-500 mt-1">같은 분야에서 지금 모집 중인 프로젝트입니다</p>
            </div>
            {project.category && (
              <Link
                href={`/projects?category=${encodeURIComponent(project.category)}`}
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
            <ProjectCardGrid
              projects={recommendations}
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
            />
          )}
        </section>
      )}

      {/* Apply Modal */}
      <Modal isOpen={reopenModal} onClose={() => setReopenModal(false)} title="다시 모집하기">
        <form noValidate onSubmit={handleReopen} className="space-y-4">
          <p className="text-sm text-gray-600">
            새 마감일까지 다시 지원을 받습니다. 이전 모집에서 거절된 지원자도 다시 지원할 수 있고, 따로 알림은 보내지 않습니다.
          </p>
          {reopenError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {reopenError}
            </div>
          )}
          {reopenStartDate > kstToday() && !reopenError && (
            <p className="text-sm text-gray-600">모집 시작일({formatDate(project.recruitmentStartDate)}) 이후로 선택해 주세요.</p>
          )}
          <Input
            label="새 마감일"
            type="date"
            required
            min={reopenMinDate}
            value={reopenDeadline}
            onChange={(e) => setReopenDeadline(e.target.value)}
          />
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="secondary" onClick={() => setReopenModal(false)}>취소</Button>
            <Button type="submit" loading={reopening}>다시 모집하기</Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={applyModal} onClose={() => setApplyModal(false)} title={canReapply ? '다시 지원하기' : '프로젝트 지원'}>
        {/* noValidate: 브라우저 기본 검증 말풍선 대신 handleApply의 한국어 안내를 보여 준다. */}
        <form noValidate onSubmit={handleApply} className="space-y-4">
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
              className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
              placeholder="지원 동기와 경험을 자세히 작성해 주세요"
            />
          </div>
          <Input
            label="희망 금액 (원)"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
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
            <Button type="submit" loading={applyLoading}>{canReapply ? '다시 지원하기' : '지원하기'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
