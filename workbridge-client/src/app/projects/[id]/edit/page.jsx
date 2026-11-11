'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import { LockIcon } from '@/components/ui/Icons';
import ProjectForm from '@/components/projects/ProjectForm';
import api from '@/lib/api';
import { toUserMessage } from '@/lib/errorMessages';
import useAuthStore from '@/store/authStore';
import PageLoader from '@/components/ui/PageLoader';

export default function EditProjectPage() {
  const { id } = useParams();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  // 불러오기 실패나 권한 없음: { kind: 'notFound' | 'forbidden' | 'error', message }. 이동하지 않고 화면에 보여 준다.
  const [loadError, setLoadError] = useState(null);

  const fetchProject = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    return api.get(`/api/projects/${id}`)
      .then(({ data }) => {
        if (data.clientId !== useAuthStore.getState().user?.id) {
          setLoadError({ kind: 'forbidden' });
        } else {
          setProject(data);
        }
      })
      .catch((err) => {
        if (err.response?.status === 404) setLoadError({ kind: 'notFound' });
        else setLoadError({ kind: 'error', message: toUserMessage(err, '프로젝트를 불러오지 못했습니다.') });
      })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    useAuthStore.getState().initAuth();
    fetchProject();
  }, [fetchProject]);

  if (loading) return <PageLoader />;

  if (loadError || !project) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        {loadError?.kind === 'forbidden' ? (
          <EmptyState
            icon={LockIcon}
            title="이 프로젝트를 수정할 권한이 없습니다."
            description="프로젝트를 등록한 의뢰인만 수정할 수 있습니다."
            action={(
              <Link href={`/projects/${id}`} className="text-primary-600 hover:text-primary-700 font-semibold">
                프로젝트로 돌아가기 →
              </Link>
            )}
          />
        ) : loadError?.kind === 'error' ? (
          <EmptyState
            tone="error"
            title={loadError.message}
            action={<Button variant="secondary" onClick={fetchProject}>다시 시도</Button>}
          />
        ) : (
          <EmptyState
            tone="error"
            title="프로젝트를 찾을 수 없습니다."
            description="삭제되었거나 주소가 바뀌었을 수 있습니다."
            action={(
              <Link href="/projects" className="text-primary-600 hover:text-primary-700 font-semibold">
                프로젝트 찾기로 →
              </Link>
            )}
          />
        )}
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900">프로젝트 수정</h1>
      </div>
      <Card className="p-6">
        <ProjectForm initialData={project} />
      </Card>
    </div>
  );
}
