'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import useAuthStore from '@/store/authStore';

function getSecondaryAction(user) {
  if (!user) {
    return { href: '/signup', label: '시작하기' };
  }

  if (user.role === 'CLIENT') {
    return { href: '/my/projects', label: '내 프로젝트' };
  }

  if (user.role === 'FREELANCER') {
    return { href: '/my/applications', label: '내 지원 현황' };
  }

  return { href: '/auth/select-role', label: '역할 선택하기' };
}

export default function HeroActions() {
  const { user, initAuth } = useAuthStore();
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    initAuth();
    setInitialized(true);
  }, [initAuth]);

  const secondaryAction = initialized ? getSecondaryAction(user) : null;

  return (
    <div className="flex flex-col sm:flex-row gap-3 justify-center">
      <Link
        href="/projects"
        className="inline-flex h-12 items-center justify-center px-8 bg-white text-primary-700 font-semibold rounded-xl shadow-lg shadow-primary-900/20 hover:bg-primary-50 transition-colors"
      >
        프로젝트 찾기
      </Link>
      {secondaryAction && (
        <Link
          href={secondaryAction.href}
          className="inline-flex h-12 items-center justify-center px-8 border border-white/40 bg-white/10 text-white font-semibold rounded-xl backdrop-blur hover:bg-white/20 transition-colors"
        >
          {secondaryAction.label}
        </Link>
      )}
    </div>
  );
}
