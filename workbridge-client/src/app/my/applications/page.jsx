'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Badge, { StatusPill } from '@/components/ui/Badge';
import PageLoader from '@/components/ui/PageLoader';
import EmptyState from '@/components/ui/EmptyState';
import { BriefcaseIcon } from '@/components/ui/Icons';
import { formatDate } from '@/lib/format';
import { toUserMessage } from '@/lib/errorMessages';

export default function MyApplicationsPage() {
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get('/api/users/me/applications')
      .then(({ data }) => setApplications(data))
      .catch((err) => setError(toUserMessage(err, '지원 현황을 불러오지 못했습니다.', {
        messages: { 'Insufficient permissions': '지원 현황은 프리랜서 회원만 볼 수 있습니다.' },
      })))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <PageLoader />;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900 mb-6">내 지원 현황</h1>

      {error ? (
        <EmptyState tone="error" title={error} />
      ) : applications.length === 0 ? (
        <EmptyState
          icon={BriefcaseIcon}
          title="아직 지원한 프로젝트가 없습니다"
          action={(
            <Link href="/projects" className="text-primary-600 hover:text-primary-700 font-semibold">
              프로젝트 찾기 →
            </Link>
          )}
        />
      ) : (
        <div className="space-y-4">
          {applications.map((app) => (
            <Card key={app.id} data-testid="application-card" className="p-5">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <Link href={`/projects/${app.project?.id}`} className="font-medium text-gray-900 hover:text-primary-600">
                      {app.project?.title}
                    </Link>
                    <Badge variant={app.status}>{app.status}</Badge>
                    {app.contract?.status === 'CANCELLED' && <StatusPill tone="gray">계약 철회</StatusPill>}
                  </div>
                  <p className="text-sm text-gray-500">
                    {app.project?.category} · {app.project?.client?.companyName || app.project?.client?.name}
                  </p>
                  <p className="text-sm text-gray-600 mt-2 line-clamp-2">{app.coverLetter}</p>
                  {app.contract?.id && (
                    <Link href={`/contracts/${app.contract.id}`} className="inline-block mt-3 text-sm text-primary-600 hover:text-primary-700 font-medium">
                      계약서 보기 →
                    </Link>
                  )}
                  {app.canReapply && (
                    <p className="mt-3 text-sm text-gray-600">
                      의뢰인이 다시 모집하고 있습니다.{' '}
                      <Link href={`/projects/${app.project?.id}`} className="text-primary-600 hover:text-primary-700 font-medium">
                        다시 지원하기 →
                      </Link>
                    </p>
                  )}
                </div>
                <div className="text-right ml-4">
                  <p className="text-sm font-medium text-gray-900">
                    {app.expectedRate?.toLocaleString()}원
                  </p>
                  <p className="text-xs text-gray-500">{app.expectedDuration}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {formatDate(app.createdAt)}
                  </p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
