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

function formatWon(value) {
  return `${Number(value || 0).toLocaleString()}원`;
}

export default function ApplicationsPage() {
  const { id } = useParams();
  const router = useRouter();
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(null);

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get(`/api/projects/${id}/applications`)
      .then(({ data }) => setApplications(data))
      .catch(console.error)
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
          `프로젝트 예산은 ${formatWon(projectBudget)}이고, ${application.freelancer?.name || '지원자'}님의 제안 금액은 ${formatWon(proposedAmount)}입니다.\n계약 금액은 제안 금액으로 생성됩니다. 수락하시겠습니까?`
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
      alert(err.response?.data?.error?.message || '처리에 실패했습니다');
    } finally {
      setUpdating(null);
    }
  }

  if (loading) return <div className="max-w-6xl mx-auto px-4 py-8 text-center">로딩 중...</div>;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">지원자 관리</h1>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2">
          {applications.length === 0 ? (
            <div className="text-center py-16 text-gray-500">
              <p>아직 지원자가 없습니다</p>
            </div>
          ) : (
            <div className="space-y-4">
              {applications.map((app) => (
                <Card key={app.id} className="p-5">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-4 flex-1">
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
                          제안 금액: {app.expectedRate?.toLocaleString()}원 · 예상 기간: {app.expectedDuration}
                        </p>
                      </div>
                    </div>

                    {app.status === 'PENDING' && (
                      <div className="flex gap-2 ml-4">
                        <Button
                          size="sm"
                          onClick={() => handleUpdate(app, 'ACCEPTED')}
                          loading={updating === app.id}
                        >
                          수락
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => handleUpdate(app, 'REJECTED')}
                          loading={updating === app.id}
                        >
                          거절
                        </Button>
                      </div>
                    )}
                    {app.contract?.id && (
                      <Link href={`/contracts/${app.contract.id}`} className="ml-4">
                        <Button size="sm" variant="secondary">계약서 보기</Button>
                      </Link>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>

        <aside className="lg:sticky lg:top-6">
          <RecommendedFreelancers projectId={id} />
        </aside>
      </div>
    </div>
  );
}
