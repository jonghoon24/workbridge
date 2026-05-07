'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';

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
      className={`inline-flex items-center justify-center rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60 ${
        bookmarked
          ? 'border-yellow-300 bg-yellow-50 text-yellow-700 hover:bg-yellow-100'
          : 'border-gray-300 bg-white text-gray-600 hover:border-yellow-300 hover:text-yellow-700'
      } ${className}`}
      aria-pressed={bookmarked}
    >
      {bookmarked ? '북마크됨' : '북마크'}
    </button>
  );
}
