'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import useAuthStore from '@/store/authStore';
import api from '@/lib/api';

function AuthCallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setAuth } = useAuthStore();

  useEffect(() => {
    const token = searchParams.get('token');
    const error = searchParams.get('error');
    const needsRoleSelection = searchParams.get('needsRoleSelection') === 'true';

    if (error) {
      router.push('/login?error=oauth_failed');
      return;
    }

    if (token) {
      // Set token temporarily to fetch user info
      localStorage.setItem('accessToken', token);

      api.get('/api/users/me')
        .then(({ data }) => {
          setAuth(data, token);
          router.push(needsRoleSelection ? '/auth/select-role' : '/');
        })
        .catch(() => {
          localStorage.removeItem('accessToken');
          router.push('/login?error=oauth_failed');
        });
    } else {
      router.push('/login');
    }
  }, [searchParams, setAuth, router]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto mb-4" />
        <p className="text-gray-600">로그인 처리 중...</p>
      </div>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
      </div>
    }>
      <AuthCallbackContent />
    </Suspense>
  );
}
