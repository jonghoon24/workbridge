'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Card from '@/components/ui/Card';
import ProjectForm from '@/components/projects/ProjectForm';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import PageLoader from '@/components/ui/PageLoader';

export default function EditProjectPage() {
  const { id } = useParams();
  const router = useRouter();
  const { user } = useAuthStore();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get(`/api/projects/${id}`)
      .then(({ data }) => {
        if (data.clientId !== useAuthStore.getState().user?.id) {
          router.push(`/projects/${id}`);
        } else {
          setProject(data);
        }
      })
      .catch(() => router.push('/projects'))
      .finally(() => setLoading(false));
  }, [id, router]);

  if (loading) return <PageLoader />;
  if (!project) return null;

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
