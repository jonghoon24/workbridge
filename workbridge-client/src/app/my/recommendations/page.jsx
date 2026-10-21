'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import useAuthStore from '@/store/authStore';
import RecommendedProjects from '@/components/profile/RecommendedProjects';

// 추천 프로젝트 전체 보기(BEHAVIOR.md RC6–RC8, 최대 20개). 프리랜서 전용이다.
export default function MyRecommendationsPage() {
  const [role, setRole] = useState(undefined);

  useEffect(() => {
    useAuthStore.getState().initAuth();
    setRole(useAuthStore.getState().user?.role ?? null);
  }, []);

  if (role === undefined) return <div className="max-w-4xl mx-auto px-4 py-8 text-center">로딩 중...</div>;

  if (role !== 'FREELANCER') {
    return (
      <div className="max-w-4xl mx-auto px-4 py-16 text-center text-gray-600">
        추천 프로젝트는 프리랜서 회원만 볼 수 있습니다.
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">추천 프로젝트</h1>
          <p className="text-gray-600 mt-1">
            요구 기술이 겹치거나 활동 카테고리가 같은 모집 중 프로젝트를 점수 순으로 보여드려요.
            지원한 프로젝트는 빠집니다.
          </p>
        </div>
        <Link href="/profile" className="text-sm text-primary-600 hover:text-primary-700 shrink-0">
          기술 스택 수정 →
        </Link>
      </div>
      <RecommendedProjects limit={20} />
    </div>
  );
}
