'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import { BookmarkIcon } from '@/components/ui/Icons';

export default function ProjectBookmarkButton({
  projectId,
  initialBookmarked = false,
  onChange,
  className = '',
}) {
  const { user, initAuth } = useAuthStore();
  const [initialized, setInitialized] = useState(false);
  const [bookmarked, setBookmarked] = useState(initialBookmarked);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    initAuth();
    setInitialized(true);
  }, [initAuth]);

  useEffect(() => {
    if (!initialized || user?.role !== 'FREELANCER') return;

    let ignore = false;
    api.get(`/api/projects/${projectId}/bookmark`)
      .then(({ data }) => {
        if (!ignore) setBookmarked(data.bookmarked);
      })
      .catch(() => {});

    return () => {
      ignore = true;
    };
  }, [initialized, projectId, user?.role]);

  if (!initialized || user?.role !== 'FREELANCER') return null;

  async function handleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (loading) return;

    const nextBookmarked = !bookmarked;
    setBookmarked(nextBookmarked);
    setLoading(true);

    try {
      if (nextBookmarked) {
        await api.post(`/api/projects/${projectId}/bookmark`);
      } else {
        await api.delete(`/api/projects/${projectId}/bookmark`);
      }
      onChange?.(nextBookmarked);
    } catch {
      setBookmarked(!nextBookmarked);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className={`inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-60 ${
        bookmarked
          ? 'border-primary-200 bg-primary-50 text-primary-700 hover:bg-primary-100'
          : 'border-gray-200 bg-white text-gray-500 hover:border-primary-200 hover:text-primary-700'
      } ${className}`}
      aria-pressed={bookmarked}
    >
      <BookmarkIcon filled={bookmarked} className="h-3.5 w-3.5" />
      {bookmarked ? '북마크됨' : '북마크'}
    </button>
  );
}
