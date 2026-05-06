'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/authStore';
import authApi from '@/lib/authApi';

export default function Header() {
  const router = useRouter();
  const { user, clearAuth, initAuth } = useAuthStore();
  const [dropdownOpen, setDropdownOpen] = useState(false);

  useEffect(() => {
    initAuth();
  }, [initAuth]);

  async function handleLogout() {
    try {
      await authApi.post('/api/auth/logout');
    } catch {}
    clearAuth();
    router.push('/');
  }

  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <Link href="/" className="text-xl font-bold text-primary-600">
            WorkBridge
          </Link>

          <nav className="hidden md:flex items-center gap-6">
            <Link href="/projects" className="text-gray-600 hover:text-gray-900 text-sm font-medium">
              프로젝트 찾기
            </Link>
            {user?.role === 'CLIENT' && (
              <Link href="/projects/new" className="text-gray-600 hover:text-gray-900 text-sm font-medium">
                프로젝트 등록
              </Link>
            )}
          </nav>

          <div className="flex items-center gap-3">
            {user ? (
              <div className="relative">
                <button
                  onClick={() => setDropdownOpen(!dropdownOpen)}
                  className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900"
                >
                  <div className="w-8 h-8 bg-primary-100 rounded-full flex items-center justify-center">
                    <span className="text-primary-700 font-semibold text-xs">
                      {user.name?.[0]?.toUpperCase()}
                    </span>
                  </div>
                  <span className="hidden md:block">{user.name}</span>
                </button>

                {dropdownOpen && (
                  <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
                    <Link
                      href="/profile"
                      className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      onClick={() => setDropdownOpen(false)}
                    >
                      내 프로필
                    </Link>
                    {user.role === 'FREELANCER' && (
                      <Link
                        href="/my/applications"
                        className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                        onClick={() => setDropdownOpen(false)}
                      >
                        내 지원 현황
                      </Link>
                    )}
                    {user.role === 'CLIENT' && (
                      <Link
                        href="/my/payments"
                        className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                        onClick={() => setDropdownOpen(false)}
                      >
                        결제 내역
                      </Link>
                    )}
                    <hr className="my-1 border-gray-200" />
                    <button
                      onClick={() => { setDropdownOpen(false); handleLogout(); }}
                      className="block w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                    >
                      로그아웃
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <Link href="/login" className="text-sm font-medium text-gray-600 hover:text-gray-900">
                  로그인
                </Link>
                <Link
                  href="/signup"
                  className="inline-flex items-center px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700"
                >
                  회원가입
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
