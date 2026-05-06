'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';

export default function MyApplicationsPage() {
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get('/api/users/me/applications')
      .then(({ data }) => setApplications(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="max-w-4xl mx-auto px-4 py-8 text-center">로딩 중...</div>;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">내 지원 현황</h1>

      {applications.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <p className="mb-4">아직 지원한 프로젝트가 없습니다</p>
          <Link href="/projects" className="text-primary-600 hover:text-primary-700 font-medium">
            프로젝트 찾기 →
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {applications.map((app) => (
            <Card key={app.id} className="p-5">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <Link href={`/projects/${app.project?.id}`} className="font-medium text-gray-900 hover:text-primary-600">
                      {app.project?.title}
                    </Link>
                    <Badge variant={app.status}>{app.status}</Badge>
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
                </div>
                <div className="text-right ml-4">
                  <p className="text-sm font-medium text-gray-900">
                    {app.expectedRate?.toLocaleString()}원
                  </p>
                  <p className="text-xs text-gray-500">{app.expectedDuration}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {new Date(app.createdAt).toLocaleDateString('ko-KR')}
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
