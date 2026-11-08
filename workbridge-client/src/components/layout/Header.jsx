'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import useAuthStore from '@/store/authStore';
import api from '@/lib/api';
import authApi from '@/lib/authApi';
import UnreadBadge from '@/components/messages/UnreadBadge';
import usePolling from '@/components/messages/usePolling';
import { BADGE_POLL_MS, MESSAGES_CHANGED_EVENT } from '@/components/messages/messageUtils';
import {
  BellIcon,
  BookmarkIcon,
  BriefcaseIcon,
  ChevronDownIcon,
  CreditCardIcon,
  FileTextIcon,
  LogOutIcon,
  MessageIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  UserIcon,
  WalletIcon,
} from '@/components/ui/Icons';
import BrandMark from '@/components/ui/BrandMark';

function isActive(pathname, href) {
  if (href === '/projects') {
    return pathname === '/projects' || (/^\/projects\/[^/]+/.test(pathname) && pathname !== '/projects/new');
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

// 헤더 아이콘 버튼(메시지·알림). 화면에 보이는 글자는 없지만 sr-only 텍스트로 이전과 같은 이름을 유지한다.
function IconLink({ href, label, active, children, badge }) {
  return (
    <Link
      href={href}
      className={`relative inline-flex h-10 w-10 items-center justify-center rounded-full transition-colors ${
        active ? 'bg-primary-50 text-primary-700' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
      }`}
      title={label}
    >
      {children}
      <span className="sr-only">{label}</span>
      {badge}
    </Link>
  );
}

const ROLE_LABELS = { CLIENT: '의뢰인', FREELANCER: '프리랜서' };

function MenuLink({ href, icon: Icon, children, onClick, trailing }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 hover:text-gray-900"
      onClick={onClick}
    >
      {Icon && <Icon className="h-4 w-4 shrink-0 text-gray-400" />}
      <span className="flex-1">{children}</span>
      {trailing}
    </Link>
  );
}

export default function Header() {
  const router = useRouter();
  const pathname = usePathname() || '/';
  const { user, clearAuth, initAuth } = useAuthStore();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const menuRef = useRef(null);
  const userId = user?.id;

  useEffect(() => {
    initAuth();
  }, [initAuth]);

  // 페이지가 바뀌면 메뉴를 닫는다.
  useEffect(() => {
    setDropdownOpen(false);
  }, [pathname]);

  // 메뉴 바깥을 누르거나 Esc를 누르면 닫는다.
  useEffect(() => {
    if (!dropdownOpen) return undefined;
    function onPointer(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setDropdownOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') setDropdownOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [dropdownOpen]);

  useEffect(() => {
    if (!userId) {
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
  }, [userId]);

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

  const close = () => setDropdownOpen(false);
  const navClass = (href) =>
    `relative inline-flex h-16 items-center text-[15px] font-medium transition-colors ${
      isActive(pathname, href)
        ? 'text-gray-900 after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary-600'
        : 'text-gray-500 hover:text-gray-900'
    }`;

  return (
    <header className="sticky top-0 z-40 border-b border-gray-200/80 bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between gap-4">
          <div className="flex items-center gap-10">
            <Link href="/" className="flex items-center gap-2 text-lg font-bold tracking-tight text-gray-900">
              <BrandMark />
              <span>WorkBridge</span>
            </Link>

            <nav className="hidden md:flex items-center gap-7">
              <Link href="/projects" className={navClass('/projects')}>
                프로젝트 찾기
              </Link>
              {user?.role === 'CLIENT' && (
                <Link href="/projects/new" className={navClass('/projects/new')}>
                  프로젝트 등록
                </Link>
              )}
            </nav>
          </div>

          <div className="flex items-center gap-1 sm:gap-1.5">
            {/* 좁은 화면에서는 가운데 메뉴가 숨으므로 검색 아이콘으로 프로젝트 찾기를 연다. */}
            <Link
              href="/projects"
              className="inline-flex h-10 w-10 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-900 md:hidden"
              title="프로젝트 찾기"
            >
              <SearchIcon className="h-5 w-5" />
              <span className="sr-only">프로젝트 찾기</span>
            </Link>

            {user ? (
              <>
                <IconLink
                  href="/messages"
                  label="메시지"
                  active={isActive(pathname, '/messages')}
                  badge={
                    <UnreadBadge
                      count={unreadMessages}
                      variant="alert"
                      className="absolute -right-0.5 -top-0.5 ring-2 ring-white"
                    />
                  }
                >
                  <MessageIcon className="h-[22px] w-[22px]" />
                </IconLink>
                <IconLink
                  href="/my/notifications"
                  label="알림"
                  active={pathname === '/my/notifications'}
                  badge={
                    unreadCount > 0 && (
                      <span
                        className="absolute -right-0.5 -top-0.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-semibold leading-none text-white ring-2 ring-white"
                        aria-label="읽지 않은 알림 있음"
                      >
                        {unreadCount > 99 ? '99+' : unreadCount}
                      </span>
                    )
                  }
                >
                  <BellIcon className="h-[22px] w-[22px]" />
                </IconLink>

                <span className="mx-1.5 hidden h-6 w-px bg-gray-200 sm:block" aria-hidden="true" />

                <div className="relative" ref={menuRef}>
                  <button
                    onClick={() => setDropdownOpen(!dropdownOpen)}
                    className="flex items-center gap-2 rounded-full py-1 pl-1 pr-1 text-sm font-medium text-gray-700 hover:bg-gray-100 md:pr-2.5"
                    aria-expanded={dropdownOpen}
                    aria-haspopup="menu"
                  >
                    <div className="w-8 h-8 bg-gradient-to-br from-primary-500 to-primary-700 rounded-full flex items-center justify-center">
                      <span className="text-white font-semibold text-xs">
                        {user.name?.[0]?.toUpperCase()}
                      </span>
                    </div>
                    <span className="hidden md:block">{user.name}</span>
                    <ChevronDownIcon className={`hidden h-4 w-4 text-gray-400 transition-transform md:block ${dropdownOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {dropdownOpen && (
                    <div className="absolute right-0 mt-2 w-64 origin-top-right rounded-xl border border-gray-200/80 bg-white p-1.5 shadow-popover z-50">
                      <div className="flex items-center gap-3 px-3 pb-3 pt-2.5">
                        <div className="w-10 h-10 shrink-0 bg-gradient-to-br from-primary-500 to-primary-700 rounded-full flex items-center justify-center">
                          <span className="text-white font-semibold text-sm">{user.name?.[0]?.toUpperCase()}</span>
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-gray-900">{user.name}</p>
                          <p className="truncate text-xs text-gray-500">
                            {ROLE_LABELS[user.role] || ''}{user.email ? ` · ${user.email}` : ''}
                          </p>
                        </div>
                      </div>
                      <div className="my-1 h-px bg-gray-100" />

                      {/* 좁은 화면에서는 가운데 메뉴 대신 여기서 프로젝트 등록을 연다. */}
                      {user.role === 'CLIENT' && (
                        <div className="md:hidden">
                          <MenuLink href="/projects/new" icon={PlusIcon} onClick={close}>프로젝트 등록</MenuLink>
                        </div>
                      )}

                      <MenuLink href="/profile" icon={UserIcon} onClick={close}>내 프로필</MenuLink>
                      <MenuLink href="/messages" icon={MessageIcon} onClick={close} trailing={<UnreadBadge count={unreadMessages} />}>
                        메시지
                      </MenuLink>
                      <MenuLink
                        href="/my/notifications"
                        icon={BellIcon}
                        onClick={close}
                        trailing={
                          unreadCount > 0 && (
                            <span
                              className="h-2 w-2 rounded-full bg-red-500"
                              aria-label="읽지 않은 알림 있음"
                            />
                          )
                        }
                      >
                        알림
                      </MenuLink>
                      <MenuLink href="/my/notifications/settings" icon={SettingsIcon} onClick={close}>알림 설정</MenuLink>
                      <MenuLink href="/my/contracts" icon={FileTextIcon} onClick={close}>내 계약</MenuLink>
                      {user.role === 'FREELANCER' && (
                        <>
                          <MenuLink href="/settlements" icon={WalletIcon} onClick={close}>정산</MenuLink>
                          <MenuLink href="/my/bookmarks" icon={BookmarkIcon} onClick={close}>내 북마크</MenuLink>
                          <MenuLink href="/my/applications" icon={BriefcaseIcon} onClick={close}>내 지원 현황</MenuLink>
                          <MenuLink href="/my/recommendations" icon={SparklesIcon} onClick={close}>추천 프로젝트</MenuLink>
                        </>
                      )}
                      {user.role === 'CLIENT' && (
                        <>
                          <MenuLink href="/my/projects" icon={BriefcaseIcon} onClick={close}>내 프로젝트 보기</MenuLink>
                          <MenuLink href="/my/payments" icon={CreditCardIcon} onClick={close}>결제 내역</MenuLink>
                        </>
                      )}
                      <div className="my-1 h-px bg-gray-100" />
                      <button
                        onClick={() => { setDropdownOpen(false); handleLogout(); }}
                        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                      >
                        <LogOutIcon className="h-4 w-4 shrink-0" />
                        로그아웃
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <Link
                  href="/login"
                  className="inline-flex h-9 items-center rounded-lg px-3 text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                >
                  로그인
                </Link>
                <Link
                  href="/signup"
                  className="inline-flex h-9 items-center px-4 bg-primary-600 text-white text-sm font-semibold rounded-lg shadow-sm hover:bg-primary-700"
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
