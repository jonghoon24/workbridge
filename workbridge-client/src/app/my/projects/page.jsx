'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';

export default function MyProjectsPage() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get('/api/users/me/projects')
      .then(({ data }) => setProjects(data))
      .catch((err) => {
        setError(err.response?.data?.error?.message || '내 프로젝트를 불러오지 못했습니다');
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="max-w-5xl mx-auto px-4 py-8 text-center">로딩 중...</div>;
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">내 프로젝트</h1>
          <p className="text-gray-600 mt-1">등록한 프로젝트와 지원 현황을 확인하세요</p>
        </div>
        <Link href="/projects/new">
          <Button>프로젝트 등록</Button>
        </Link>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm mb-6">
          {error}
        </div>
      )}

      {!error && projects.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <p className="mb-4">아직 등록한 프로젝트가 없습니다</p>
          <Link href="/projects/new" className="text-primary-600 hover:text-primary-700 font-medium">
            프로젝트 등록하기 →
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {projects.map((project) => (
            <Card key={project.id} className="p-5">
              <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <Link
                      href={`/projects/${project.id}`}
                      className="font-semibold text-gray-900 hover:text-primary-600"
                    >
                      {project.title}
                    </Link>
                    <Badge variant={project.status}>{project.status}</Badge>
                  </div>
                  <p className="text-sm text-gray-600 line-clamp-2">{project.description}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-sm text-gray-500">
                    <span>{project.category}</span>
                    <span>지원자 {project._count?.applications || 0}명</span>
                    <span>{project.budget?.toLocaleString()}원</span>
                    <span>
                      모집 시작 {project.recruitmentStartDate
                        ? new Date(project.recruitmentStartDate).toLocaleDateString('ko-KR')
                        : '-'}
                    </span>
                    <span>마감 {new Date(project.deadline).toLocaleDateString('ko-KR')}</span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 lg:justify-end">
                  <Link href={`/projects/${project.id}`}>
                    <Button variant="secondary" size="sm">상세</Button>
                  </Link>
                  <Link href={`/projects/${project.id}/applications`}>
                    <Button variant="secondary" size="sm">지원자</Button>
                  </Link>
                  <Link href={`/projects/${project.id}/analysis`}>
                    <Button variant="secondary" size="sm">AI 분석</Button>
                  </Link>
                  <Link href={`/projects/${project.id}/edit`}>
                    <Button variant="secondary" size="sm">수정</Button>
                  </Link>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
