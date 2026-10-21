'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/authStore';
import api from '@/lib/api';
import authApi from '@/lib/authApi';
import UnreadBadge from '@/components/messages/UnreadBadge';
import usePolling from '@/components/messages/usePolling';
import { BADGE_POLL_MS, MESSAGES_CHANGED_EVENT } from '@/components/messages/messageUtils';

export default function Header() {
  const router = useRouter();
  const { user, clearAuth, initAuth } = useAuthStore();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const userId = user?.id;

  useEffect(() => {
    initAuth();
  }, [initAuth]);

  useEffect(() => {
    if (!user) {
      setUnreadCount(0);
      return undefined;
    }

    let ignored = false;

    function refreshUnreadCount() {
      api.get('/api/notifications/unread-count')
        .then(({ data }) => {
          if (!ignored) setUnreadCount(data.unreadCount || 0);
        })
        .catch(() => {
          if (!ignored) setUnreadCount(0);
        });
    }

    refreshUnreadCount();
    window.addEventListener('notifications:changed', refreshUnreadCount);

    return () => {
      ignored = true;
      window.removeEventListener('notifications:changed', refreshUnreadCount);
    };
  }, [user?.id]);

  // 안 읽은 메시지 수(BEHAVIOR.md MG12, MG20): 30초마다(탭이 보일 때만), 그리고 스레드를 읽거나
  // 메시지를 보냈을 때(`messages:changed`) 다시 센다.
  const refreshUnreadMessages = useCallback(() => {
    if (!userId) return;
    api.get('/api/conversations/unread-count')
      .then(({ data }) => setUnreadMessages(data.unreadCount || 0))
      .catch(() => {});
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setUnreadMessages(0);
      return undefined;
    }
    refreshUnreadMessages();
    window.addEventListener(MESSAGES_CHANGED_EVENT, refreshUnreadMessages);
    return () => window.removeEventListener(MESSAGES_CHANGED_EVENT, refreshUnreadMessages);
  }, [userId, refreshUnreadMessages]);

  usePolling(refreshUnreadMessages, BADGE_POLL_MS, { enabled: Boolean(userId) });

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
              <>
                <Link
                  href="/messages"
                  className="relative hidden sm:inline-flex items-center px-3 py-2 text-sm font-medium text-gray-600 hover:text-gray-900"
                >
                  메시지
                  <UnreadBadge count={unreadMessages} className="ml-1.5" />
                </Link>
                <Link
                  href="/my/notifications"
                  className="relative hidden sm:inline-flex items-center px-3 py-2 text-sm font-medium text-gray-600 hover:text-gray-900"
                >
                  알림
                  {unreadCount > 0 && (
                    <span
                      className="ml-1.5 h-2 w-2 rounded-full bg-primary-600"
                      aria-label="읽지 않은 알림 있음"
                    />
                  )}
                </Link>
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
                    <Link
                      href="/messages"
                      className="flex items-center justify-between px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      onClick={() => setDropdownOpen(false)}
                    >
                      <span>메시지</span>
                      <UnreadBadge count={unreadMessages} />
                    </Link>
                    <Link
                      href="/my/notifications"
                      className="flex items-center justify-between px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      onClick={() => setDropdownOpen(false)}
                    >
                      <span>알림</span>
                      {unreadCount > 0 && (
                        <span
                          className="h-2 w-2 rounded-full bg-primary-600"
                          aria-label="읽지 않은 알림 있음"
                        />
                      )}
                    </Link>
                    <Link
                      href="/my/notifications/settings"
                      className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      onClick={() => setDropdownOpen(false)}
                    >
                      알림 설정
                    </Link>
                    <Link
                      href="/my/contracts"
                      className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      onClick={() => setDropdownOpen(false)}
                    >
                      내 계약
                    </Link>
                    {user.role === 'FREELANCER' && (
                      <>
                        <Link
                          href="/settlements"
                          className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                          onClick={() => setDropdownOpen(false)}
                        >
                          정산
                        </Link>
                        <Link
                          href="/my/bookmarks"
                          className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                          onClick={() => setDropdownOpen(false)}
                        >
                          내 북마크
                        </Link>
                        <Link
                          href="/my/applications"
                          className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                          onClick={() => setDropdownOpen(false)}
                        >
                          내 지원 현황
                        </Link>
                      </>
                    )}
                    {user.role === 'CLIENT' && (
                      <>
                        <Link
                          href="/my/projects"
                          className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                          onClick={() => setDropdownOpen(false)}
                        >
                          내 프로젝트 보기
                        </Link>
                        <Link
                          href="/my/payments"
                          className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                          onClick={() => setDropdownOpen(false)}
                        >
                          결제 내역
                        </Link>
                      </>
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
              </>
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
