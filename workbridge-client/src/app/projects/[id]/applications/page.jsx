'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';

export default function ApplicationsPage() {
  const { id } = useParams();
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

  async function handleUpdate(appId, status) {
    setUpdating(appId);
    try {
      await api.patch(`/api/projects/${id}/applications/${appId}`, { status });
      const { data } = await api.get(`/api/projects/${id}/applications`);
      setApplications(data);
      if (status === 'ACCEPTED') alert('지원자를 수락했습니다. 계약서가 생성되었습니다.');
    } catch (err) {
      alert(err.response?.data?.error?.message || '처리에 실패했습니다');
    } finally {
      setUpdating(null);
    }
  }

  if (loading) return <div className="max-w-4xl mx-auto px-4 py-8 text-center">로딩 중...</div>;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">지원자 관리</h1>

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
                      예상 단가: {app.expectedRate?.toLocaleString()}원 · 예상 기간: {app.expectedDuration}
                    </p>
                  </div>
                </div>

                {app.status === 'PENDING' && (
                  <div className="flex gap-2 ml-4">
                    <Button
                      size="sm"
                      onClick={() => handleUpdate(app.id, 'ACCEPTED')}
                      loading={updating === app.id}
                    >
                      수락
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => handleUpdate(app.id, 'REJECTED')}
                      loading={updating === app.id}
                    >
                      거절
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
