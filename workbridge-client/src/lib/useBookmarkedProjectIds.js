'use client';

import { useCallback, useEffect, useState } from 'react';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';

// 프로젝트 카드 목록의 북마크 여부. 프리랜서의 북마크한 프로젝트 ID를 한 번에 불러온다(카드마다
// `GET /api/projects/:id/bookmark`를 부르지 않는다). 프리랜서가 아니거나 아직 불러오지 못했으면
// `bookmarkedIds`가 null이고, 카드의 북마크 버튼은 그동안 보이지 않는다.
// `isBookmarked(id)`는 ProjectCard의 `bookmarked` 값(true/false, 모르면 null)을 돌려주고,
// `setBookmarked(id, value)`는 카드에서 북마크를 바꾼 결과를 목록 상태에 반영한다.
export default function useBookmarkedProjectIds() {
  const user = useAuthStore((state) => state.user);
  const initAuth = useAuthStore((state) => state.initAuth);
  const [bookmarkedIds, setBookmarkedIds] = useState(null);

  useEffect(() => {
    initAuth();
  }, [initAuth]);

  useEffect(() => {
    setBookmarkedIds(null);
    if (user?.role !== 'FREELANCER') return undefined;

    let ignore = false;
    api.get('/api/users/me/bookmarks/ids')
      .then(({ data }) => {
        if (!ignore) setBookmarkedIds(new Set(data.projectIds));
      })
      .catch(() => {});

    return () => {
      ignore = true;
    };
  }, [user?.id, user?.role]);

  const isBookmarked = useCallback(
    (projectId) => (bookmarkedIds ? bookmarkedIds.has(projectId) : null),
    [bookmarkedIds],
  );

  const setBookmarked = useCallback((projectId, bookmarked) => {
    setBookmarkedIds((current) => {
      if (!current) return current;
      const next = new Set(current);
      if (bookmarked) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
  }, []);

  return { isBookmarked, setBookmarked };
}
