'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';

function formatDate(value) {
  return new Date(value).toLocaleString('ko-KR', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get('/api/notifications')
      .then(({ data }) => {
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
      })
      .catch((err) => {
        setError(err.response?.data?.error?.message || '알림을 불러오지 못했습니다');
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleMarkRead(notification) {
    if (notification.readAt || updating) return;

    setUpdating(notification.id);
    try {
      const { data } = await api.patch(`/api/notifications/${notification.id}/read`);
      setNotifications((prev) => prev.map((item) => (item.id === data.id ? data : item)));
      setUnreadCount((prev) => Math.max(prev - 1, 0));
      window.dispatchEvent(new Event('notifications:changed'));
    } catch (err) {
      setError(err.response?.data?.error?.message || '알림 상태를 변경하지 못했습니다');
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
      setError(err.response?.data?.error?.message || '알림 상태를 변경하지 못했습니다');
    } finally {
      setUpdating('');
    }
  }

  if (loading) {
    return <div className="max-w-4xl mx-auto px-4 py-8 text-center">로딩 중...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">알림</h1>
          <p className="text-gray-600 mt-1">지원 현황과 프로젝트 변경 사항을 확인하세요</p>
        </div>
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

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm mb-6">
          {error}
        </div>
      )}

      {notifications.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <p>아직 알림이 없습니다</p>
        </div>
      ) : (
        <div className="space-y-3">
          {notifications.map((notification) => {
            const unread = !notification.readAt;

            return (
              <Card
                key={notification.id}
                className={`p-5 ${unread ? 'border-primary-200 bg-primary-50/40' : ''}`}
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      {unread && <span className="h-2 w-2 rounded-full bg-primary-600" />}
                      <h2 className="font-semibold text-gray-900">{notification.title}</h2>
                    </div>
                    <p className="text-sm text-gray-700">{notification.message}</p>
                    <p className="text-xs text-gray-500 mt-2">{formatDate(notification.createdAt)}</p>
                  </div>

                  <div className="flex flex-wrap gap-2 sm:justify-end">
                    {notification.href && (
                      <Link href={notification.href}>
                        <Button variant="secondary" size="sm" onClick={() => handleMarkRead(notification)}>
                          관련 화면
                        </Button>
                      </Link>
                    )}
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
        </div>
      )}
    </div>
  );
}
