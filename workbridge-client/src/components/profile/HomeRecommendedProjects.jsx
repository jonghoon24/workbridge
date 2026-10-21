'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import useAuthStore from '@/store/authStore';
import RecommendedProjects from './RecommendedProjects';

// 홈 화면의 "추천 프로젝트" 섹션. 로그인한 프리랜서에게만 보인다(PLAN §2.3.4).
export default function HomeRecommendedProjects() {
  const { user, initAuth } = useAuthStore();
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    initAuth();
    setInitialized(true);
  }, [initAuth]);

  if (!initialized || user?.role !== 'FREELANCER') return null;

  return (
    <section className="py-12 bg-gray-50 border-b border-gray-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">나에게 맞는 프로젝트</h2>
            <p className="text-gray-600 mt-1">기술 스택과 활동 카테고리로 고른 모집 중인 프로젝트입니다</p>
          </div>
          <Link href="/my/recommendations" className="text-primary-600 hover:text-primary-700 font-medium">
            더 보기 →
          </Link>
        </div>
        <RecommendedProjects limit={3} compact />
      </div>
    </section>
  );
}
