'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import PageLoader from '@/components/ui/PageLoader';
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  describePreferenceError,
  typeLabel,
} from '@/components/notifications/preferenceLabels';

function Toggle({ checked, disabled, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:cursor-not-allowed ${
        checked ? 'bg-primary-600' : 'bg-gray-300'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

// 잠긴 채널의 안내 문구. 잠긴 채널은 켜진 채로 고정이고, 메시지 요약의 앱 알림만 꺼진 채로 고정이다.
function lockHint(on) {
  return on ? '필수 알림' : '이메일 전용';
}

// 알림 설정. 저장은 화면의 배열 전체를 PUT한다. 잠긴 채널은 자기 값 그대로라
// 서버가 바꾸지 않고 통과시킨다.
export default function NotificationSettingsPage() {
  const [preferences, setPreferences] = useState([]);
  const [saved, setSaved] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get('/api/notifications/preferences')
      .then(({ data }) => {
        setPreferences(data.preferences || []);
        setSaved(data.preferences || []);
      })
      .catch((err) => setError(describePreferenceError(err, '알림 설정을 불러오지 못했습니다')))
      .finally(() => setLoading(false));
  }, []);

  const dirty = useMemo(() => JSON.stringify(preferences) !== JSON.stringify(saved), [preferences, saved]);

  const groups = useMemo(() => CATEGORY_ORDER
    .map((category) => ({ category, items: preferences.filter((p) => p.category === category) }))
    .filter((group) => group.items.length > 0), [preferences]);

  const anyEmailOn = preferences.some((p) => !p.emailLocked && p.email);

  function update(type, channel, value) {
    setSuccess('');
    setPreferences((prev) => prev.map((p) => (p.type === type ? { ...p, [channel]: value } : p)));
  }

  // 잠기지 않은 이메일 채널만 끈다. 필수 이메일은 그대로 둔다.
  function turnOffAllEmail() {
    setSuccess('');
    setPreferences((prev) => prev.map((p) => (p.emailLocked ? p : { ...p, email: false })));
  }

  async function handleSave() {
    if (!dirty || saving) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const body = preferences.map(({ type, inApp, email }) => ({ type, inApp, email }));
      const { data } = await api.put('/api/notifications/preferences', { preferences: body });
      setPreferences(data.preferences);
      setSaved(data.preferences);
      setSuccess('알림 설정을 저장했습니다');
    } catch (err) {
      setError(describePreferenceError(err, '알림 설정을 저장하지 못했습니다'));
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setPreferences(saved);
    setError('');
    setSuccess('');
  }

  if (loading) {
    return <PageLoader />;
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <Link href="/my/notifications" className="text-sm text-gray-500 hover:text-gray-700">
          ← 알림 목록
        </Link>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div>
          <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900">알림 설정</h1>
          <p className="text-gray-600 mt-1">알림 종류마다 앱 알림과 이메일 수신 여부를 정하세요</p>
        </div>
        <Button variant="secondary" size="sm" onClick={turnOffAllEmail} disabled={!anyEmailOn}>
          이메일 전체 끄기
        </Button>
      </div>

      <p className="text-sm text-gray-500 mb-6">
        계약, 결제, 정산처럼 놓치면 안 되는 알림은 끌 수 없습니다. 이메일 전체 끄기도 이런 필수 알림에는 적용되지 않습니다.
      </p>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm mb-6">
          {error}
        </div>
      )}
      {success && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm mb-6">
          {success}
        </div>
      )}

      <div className="space-y-6">
        {groups.map(({ category, items }) => (
          <Card key={category} className="overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b border-gray-200">
              <h2 className="font-semibold text-gray-900">{CATEGORY_LABELS[category] || category}</h2>
              <div className="hidden sm:flex gap-6 text-xs font-medium text-gray-500">
                <span className="w-16 text-center">앱 알림</span>
                <span className="w-16 text-center">이메일</span>
              </div>
            </div>
            <ul className="divide-y divide-gray-100">
              {items.map((item) => {
                const { label, description } = typeLabel(item.type);
                return (
                  <li key={item.type} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900">{label}</p>
                      {description && <p className="text-sm text-gray-500 mt-0.5">{description}</p>}
                    </div>
                    <div className="flex gap-6">
                      {[
                        ['inApp', '앱 알림', item.inAppLocked],
                        ['email', '이메일', item.emailLocked],
                      ].map(([channel, channelLabel, locked]) => (
                        <div key={channel} className="flex w-16 flex-col items-center gap-1">
                          <span className="text-xs text-gray-500 sm:hidden">{channelLabel}</span>
                          <Toggle
                            checked={item[channel]}
                            disabled={locked || saving}
                            onChange={(value) => update(item.type, channel, value)}
                            label={`${label} ${channelLabel}`}
                          />
                          {locked && (
                            <span className="text-[11px] leading-tight text-gray-400 text-center">
                              {lockHint(item[channel])}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        ))}
      </div>

      <div className="sticky bottom-0 mt-6 flex justify-end gap-2 bg-gray-50/90 py-4 backdrop-blur">
        <Button variant="ghost" onClick={handleReset} disabled={!dirty || saving}>
          되돌리기
        </Button>
        <Button onClick={handleSave} disabled={!dirty} loading={saving}>
          저장
        </Button>
      </div>
    </div>
  );
}
