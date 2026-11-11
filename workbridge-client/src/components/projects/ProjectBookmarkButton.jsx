'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import { BookmarkIcon } from '@/components/ui/Icons';

// `bookmarked`가 북마크 여부를 정한다.
// - true/false: 목록이 한 번에 불러온 값을 쓰고 따로 조회하지 않는다(useBookmarkedProjectIds).
// - null: 목록이 아직 불러오는 중이라 버튼을 그리지 않는다.
// - 넘기지 않음(undefined): 버튼이 `GET /api/projects/:id/bookmark`로 스스로 조회한다(상세 화면).
export default function ProjectBookmarkButton({
  projectId,
  bookmarked: bookmarkedProp,
  onChange,
  className = '',
}) {
  const { user, initAuth } = useAuthStore();
  const [initialized, setInitialized] = useState(false);
  const [bookmarked, setBookmarked] = useState(bookmarkedProp ?? false);
  const [loading, setLoading] = useState(false);
  const loadsItself = bookmarkedProp === undefined;

  useEffect(() => {
    initAuth();
    setInitialized(true);
  }, [initAuth]);

  // 목록이 값을 늦게 불러오거나 다른 카드에서 바꾸면 따라간다.
  useEffect(() => {
    if (typeof bookmarkedProp === 'boolean') setBookmarked(bookmarkedProp);
  }, [bookmarkedProp]);

  useEffect(() => {
    if (!loadsItself || !initialized || user?.role !== 'FREELANCER') return;

    let ignore = false;
    api.get(`/api/projects/${projectId}/bookmark`)
      .then(({ data }) => {
        if (!ignore) setBookmarked(data.bookmarked);
      })
      .catch(() => {});

    return () => {
      ignore = true;
    };
  }, [loadsItself, initialized, projectId, user?.role]);

  if (!initialized || user?.role !== 'FREELANCER' || bookmarkedProp === null) return null;

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
