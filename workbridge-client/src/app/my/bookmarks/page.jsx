'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import ProjectCard from '@/components/projects/ProjectCard';
import PageLoader from '@/components/ui/PageLoader';
import EmptyState from '@/components/ui/EmptyState';
import { BookmarkIcon } from '@/components/ui/Icons';

export default function MyBookmarksPage() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get('/api/users/me/bookmarks')
      .then(({ data }) => setProjects(data))
      .catch((err) => {
        setError(err.response?.data?.error?.message || '북마크를 불러오지 못했습니다');
      })
      .finally(() => setLoading(false));
  }, []);

  function handleBookmarkChange(projectId, bookmarked) {
    if (bookmarked) return;
    setProjects((current) => current.filter((project) => project.id !== projectId));
  }

  if (loading) {
    return <PageLoader />;
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">내 북마크</h1>
        <p className="text-gray-600 mt-1">관심 있는 프로젝트를 모아보고 바로 지원하세요</p>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm mb-6">
          {error}
        </div>
      )}

      {!error && projects.length === 0 ? (
        <EmptyState
          icon={BookmarkIcon}
          title="아직 북마크한 프로젝트가 없습니다"
          action={(
            <Link href="/projects" className="text-primary-600 hover:text-primary-700 font-semibold">
              프로젝트 찾기 →
            </Link>
          )}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onBookmarkChange={(bookmarked) => handleBookmarkChange(project.id, bookmarked)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
