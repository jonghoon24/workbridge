'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import RecommendedFreelancers from '@/components/profile/RecommendedFreelancers';
import PageLoader from '@/components/ui/PageLoader';
import EmptyState from '@/components/ui/EmptyState';
import { UserIcon } from '@/components/ui/Icons';
import { toUserMessage } from '@/lib/errorMessages';

function formatWon(value) {
  return `${Number(value || 0).toLocaleString()}원`;
}

export default function ApplicationsPage() {
  const { id } = useParams();
  const router = useRouter();
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get(`/api/projects/${id}/applications`)
      .then(({ data }) => setApplications(data))
      .catch((err) => setError(toUserMessage(err, '지원자 목록을 불러오지 못했습니다.')))
      .finally(() => setLoading(false));
  }, [id]);

  async function handleUpdate(application, status) {
    if (status === 'ACCEPTED') {
      const proposedAmount = Number(application.expectedRate);
      const projectBudget = Number(application.project?.budget);

      if (
        Number.isFinite(proposedAmount)
        && Number.isFinite(projectBudget)
        && proposedAmount !== projectBudget
      ) {
        const confirmed = confirm(
          `프로젝트 예산은 ${formatWon(projectBudget)}이고, ${application.freelancer?.name || '지원자'}님의 희망 금액은 ${formatWon(proposedAmount)}입니다.\n계약 금액은 희망 금액으로 생성됩니다. 수락하시겠습니까?`
        );
        if (!confirmed) return;
      }
    }

    const appId = application.id;
    setUpdating(appId);
    try {
      const { data: result } = await api.patch(`/api/projects/${id}/applications/${appId}`, { status });
      const { data } = await api.get(`/api/projects/${id}/applications`);
      setApplications(data);
      if (status === 'ACCEPTED' && result.contract?.id) {
        router.push(`/contracts/${result.contract.id}`);
      }
    } catch (err) {
      alert(toUserMessage(err, '지원을 처리하지 못했습니다.'));
    } finally {
      setUpdating(null);
    }
  }

  if (loading) return <PageLoader />;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900 mb-6">지원자 관리</h1>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2">
          {error ? (
            <EmptyState tone="error" title={error} />
          ) : applications.length === 0 ? (
            <EmptyState icon={UserIcon} title="아직 지원자가 없습니다" />
          ) : (
            <div className="space-y-4">
              {applications.map((app) => (
                <Card key={app.id} className="p-5">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-start gap-4 flex-1 min-w-0">
                      <div className="w-10 h-10 bg-primary-100 rounded-full flex items-center justify-center flex-shrink-0">
                        <span className="text-primary-700 font-semibold text-sm">
                          {app.freelancer?.name?.[0]?.toUpperCase()}
                        </span>
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <Link href={`/users/${app.freelancer?.id}`} className="font-medium text-gray-900 hover:text-primary-600">
                            {app.freelancer?.name}
                          </Link>
                          <Badge variant={app.status}>{app.status}</Badge>
                        </div>
                        <p className="text-sm text-gray-500 mb-2">
                          경력 {app.freelancer?.experienceYears}년 · 시간당 {app.freelancer?.hourlyRate?.toLocaleString()}원
                        </p>
                        <p className="text-sm text-gray-700 line-clamp-3">{app.coverLetter}</p>
                        <p className="text-sm text-gray-500 mt-2">
                          희망 금액: {app.expectedRate?.toLocaleString()}원 · 예상 기간: {app.expectedDuration}
                        </p>
                      </div>
                    </div>

                    {app.status === 'PENDING' && (
                      <div className="flex gap-2 pl-14 sm:pl-0 sm:ml-4 sm:shrink-0">
                        <Button
                          size="sm"
                          onClick={() => handleUpdate(app, 'ACCEPTED')}
                          loading={updating === app.id}
                        >
                          수락
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="!text-red-600 hover:!bg-red-50 hover:!border-red-200"
                          onClick={() => handleUpdate(app, 'REJECTED')}
                          loading={updating === app.id}
                        >
                          거절
                        </Button>
                      </div>
                    )}
                    {app.contract?.id && (
                      <Link href={`/contracts/${app.contract.id}`} className="pl-14 sm:pl-0 sm:ml-4 sm:shrink-0">
                        <Button size="sm" variant="secondary">계약서 보기</Button>
                      </Link>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>

        <aside className="lg:sticky lg:top-24">
          <RecommendedFreelancers projectId={id} />
        </aside>
      </div>
    </div>
  );
}
