'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import PageLoader from '@/components/ui/PageLoader';
import EmptyState from '@/components/ui/EmptyState';
import { BellIcon } from '@/components/ui/Icons';
import { toUserMessage } from '@/lib/errorMessages';
import { formatDateTime } from '@/lib/format';

// 서버는 한 번에 최대 50개까지 준다(limit). 20개씩 늘려 가며 다시 받는다.
const PAGE_SIZE = 20;
const MAX_LIMIT = 50;

// 알림 type별 분류 라벨(20종). 이동할 화면은 서버가 준 href를 그대로 쓴다.
const TYPE_CATEGORIES = {
  APPLICATION_CREATED: '지원',
  APPLICATION_ACCEPTED: '지원',
  APPLICATION_REJECTED: '지원',
  PROJECT_STATUS_CHANGED: '프로젝트',
  CONTRACT_ACTIVATED: '계약',
  CONTRACT_COMPLETED: '계약',
  CONTRACT_CANCELLED: '계약',
  MILESTONE_PLAN_UPDATED: '마일스톤',
  MILESTONE_FUNDED: '마일스톤',
  MILESTONE_SUBMITTED: '마일스톤',
  MILESTONE_REVISION_REQUESTED: '마일스톤',
  MILESTONE_APPROVED: '마일스톤',
  MILESTONE_AUTO_APPROVED: '마일스톤',
  MILESTONE_AUTO_APPROVE_REMINDER: '마일스톤',
  MILESTONE_DUE_SOON: '마일스톤',
  MILESTONE_OVERDUE: '마일스톤',
  SETTLEMENT_SCHEDULED: '정산',
  SETTLEMENT_PAID: '정산',
  SETTLEMENT_ON_HOLD: '정산',
  SETTLEMENT_FAILED: '정산',
};

// 놓치면 돈이나 기한에 영향이 있는 알림은 강조한다.
const URGENT_TYPES = new Set([
  'MILESTONE_AUTO_APPROVE_REMINDER',
  'MILESTONE_OVERDUE',
  'MILESTONE_REVISION_REQUESTED',
  'SETTLEMENT_ON_HOLD',
  'SETTLEMENT_FAILED',
]);

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState('');
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    useAuthStore.getState().initAuth();
  }, []);

  useEffect(() => {
    api.get('/api/notifications', { params: { limit } })
      .then(({ data }) => {
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
      })
      .catch((err) => {
        setError(toUserMessage(err, '알림을 불러오지 못했습니다.'));
      })
      .finally(() => {
        setLoading(false);
        setLoadingMore(false);
      });
  }, [limit]);

  function handleLoadMore() {
    setLoadingMore(true);
    setLimit((prev) => Math.min(prev + PAGE_SIZE, MAX_LIMIT));
  }

  const hasMore = notifications.length >= limit && limit < MAX_LIMIT;
  const reachedMax = notifications.length >= MAX_LIMIT;

  async function handleMarkRead(notification) {
    if (notification.readAt || updating) return;

    setUpdating(notification.id);
    try {
      const { data } = await api.patch(`/api/notifications/${notification.id}/read`);
      setNotifications((prev) => prev.map((item) => (item.id === data.id ? data : item)));
      setUnreadCount((prev) => Math.max(prev - 1, 0));
      window.dispatchEvent(new Event('notifications:changed'));
    } catch (err) {
      setError(toUserMessage(err, '알림 상태를 변경하지 못했습니다.'));
    } finally {
      setUpdating('');
    }
  }

  async function handleMarkAllRead() {
    if (unreadCount === 0 || updating) return;

    setUpdating('all');
    try {
      await api.patch('/api/notifications/read-all');
      const readAt = new Date().toISOString();
      setNotifications((prev) => prev.map((item) => ({ ...item, readAt: item.readAt || readAt })));
      setUnreadCount(0);
      window.dispatchEvent(new Event('notifications:changed'));
    } catch (err) {
      setError(toUserMessage(err, '알림 상태를 변경하지 못했습니다.'));
    } finally {
      setUpdating('');
    }
  }

  if (loading) {
    return <PageLoader />;
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div>
          <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900">알림</h1>
          <p className="text-gray-600 mt-1">지원, 계약, 마일스톤, 정산 소식을 모아 보여 드립니다</p>
        </div>
        <div className="flex gap-2">
          <Link href="/my/notifications/settings">
            <Button variant="ghost" size="sm">
              알림 설정
            </Button>
          </Link>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleMarkAllRead}
            disabled={unreadCount === 0}
            loading={updating === 'all'}
          >
            모두 읽음
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm mb-6">
          {error}
        </div>
      )}

      {notifications.length === 0 ? (
        <EmptyState icon={BellIcon} title="아직 알림이 없습니다" />
      ) : (
        <div className="space-y-3">
          {notifications.map((notification) => {
            const unread = !notification.readAt;

            return (
              <Card
                key={notification.id}
                className={`relative p-5 transition-colors ${notification.href ? 'hover:border-primary-300' : ''} ${unread ? 'border-primary-200 bg-primary-50/50 shadow-[inset_3px_0_0_0_theme(colors.primary.500)]' : ''}`}
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1.5">
                      {unread && <span className="h-2 w-2 shrink-0 rounded-full bg-primary-600" />}
                      {TYPE_CATEGORIES[notification.type] && (
                        <span
                          className={`shrink-0 px-2 py-0.5 rounded-md text-xs font-medium ${
                            URGENT_TYPES.has(notification.type)
                              ? 'bg-orange-50 text-orange-700 ring-1 ring-inset ring-orange-600/20'
                              : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {TYPE_CATEGORIES[notification.type]}
                        </span>
                      )}
                      <h2 className="font-semibold text-gray-900">
                        {notification.href ? (
                          // 카드 전체를 누르면 읽음 처리하고 관련 화면으로 간다(after:inset-0로 링크 영역을 카드 전체로 넓힘).
                          <Link
                            href={notification.href}
                            onClick={() => handleMarkRead(notification)}
                            className="after:absolute after:inset-0 after:rounded-[inherit] focus:outline-none focus-visible:underline"
                          >
                            {notification.title}
                          </Link>
                        ) : (
                          notification.title
                        )}
                      </h2>
                    </div>
                    <p className="text-sm leading-relaxed text-gray-700">{notification.message}</p>
                    <p className="text-xs text-gray-500 mt-2">{formatDateTime(notification.createdAt)}</p>
                  </div>

                  <div className="relative z-10 flex flex-wrap gap-2 sm:justify-end">
                    {unread && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleMarkRead(notification)}
                        loading={updating === notification.id}
                      >
                        읽음
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
          {hasMore && (
            <div className="pt-2 text-center">
              <Button variant="secondary" onClick={handleLoadMore} loading={loadingMore}>
                이전 알림 더 보기
              </Button>
            </div>
          )}
          {reachedMax && (
            <p className="pt-2 text-center text-sm text-gray-500">최근 알림 {MAX_LIMIT}개까지 보여 드립니다.</p>
          )}
        </div>
      )}
    </div>
  );
}
