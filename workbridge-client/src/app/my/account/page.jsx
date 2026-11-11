'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import EmptyState from '@/components/ui/EmptyState';
import Input from '@/components/ui/Input';
import PageLoader from '@/components/ui/PageLoader';
import { toUserMessage } from '@/lib/errorMessages';

// 서버의 가입 비밀번호 규칙(workbridge-server/src/schemas/auth.ts MIN_PASSWORD_LENGTH)과 같다.
const MIN_PASSWORD_LENGTH = 8;

const EMPTY_FORM = { currentPassword: '', newPassword: '', confirmPassword: '' };

function validate(form) {
  const errs = {};
  if (!form.currentPassword) errs.currentPassword = '현재 비밀번호를 입력해 주세요.';
  if (form.newPassword.length < MIN_PASSWORD_LENGTH) {
    errs.newPassword = `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`;
  } else if (form.newPassword === form.currentPassword) {
    errs.newPassword = '새 비밀번호는 현재 비밀번호와 달라야 합니다.';
  }
  if (form.confirmPassword !== form.newPassword) errs.confirmPassword = '새 비밀번호가 일치하지 않습니다.';
  return errs;
}

// 비밀번호 변경. 성공하면 서버가 이 기기에 새 토큰을 주고(리프레시 쿠키는 전용 라우트가 심는다),
// 다른 기기의 로그인은 다음 토큰 갱신에서 끊긴다.
function PasswordCard() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
    setSuccess('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSuccess('');
    const errs = validate(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSaving(true);
    try {
      const { data } = await api.post('/api/auth/change-password', {
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      });
      const { user, setAuth } = useAuthStore.getState();
      if (user) setAuth(user, data.accessToken);
      setForm(EMPTY_FORM);
      setSuccess('비밀번호를 변경했습니다. 다른 기기에서는 다시 로그인해야 합니다.');
    } catch (err) {
      setError(toUserMessage(err, '비밀번호를 변경하지 못했습니다.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold text-gray-900">비밀번호 변경</h2>
      <p className="mt-1 text-sm text-gray-500">
        비밀번호를 바꾸면 이 기기를 뺀 다른 기기에서는 로그아웃됩니다.
      </p>

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}
      {success && (
        <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">{success}</div>
      )}

      <form onSubmit={handleSubmit} noValidate className="mt-5 space-y-4">
        <Input
          id="currentPassword"
          label="현재 비밀번호"
          type="password"
          autoComplete="current-password"
          value={form.currentPassword}
          onChange={(e) => update('currentPassword', e.target.value)}
          error={errors.currentPassword}
        />
        <Input
          id="newPassword"
          label="새 비밀번호"
          type="password"
          autoComplete="new-password"
          value={form.newPassword}
          onChange={(e) => update('newPassword', e.target.value)}
          error={errors.newPassword}
          helpText={`${MIN_PASSWORD_LENGTH}자 이상`}
        />
        <Input
          id="confirmPassword"
          label="새 비밀번호 확인"
          type="password"
          autoComplete="new-password"
          value={form.confirmPassword}
          onChange={(e) => update('confirmPassword', e.target.value)}
          error={errors.confirmPassword}
        />
        <div className="flex justify-end">
          <Button type="submit" loading={saving}>비밀번호 변경</Button>
        </div>
      </form>
    </Card>
  );
}

export default function AccountSettingsPage() {
  const router = useRouter();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get('/api/users/me')
      .then(({ data }) => setProfile(data))
      .catch((err) => {
        if (err.response?.status === 401) {
          router.push('/login?redirect=/my/account');
          return;
        }
        setLoadError(toUserMessage(err, '계정 정보를 불러오지 못했습니다.'));
      })
      .finally(() => setLoading(false));
  }, [router]);

  if (loading) return <PageLoader />;

  if (loadError) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <EmptyState tone="error" title={loadError} description="잠시 후 새로고침해 주세요." />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900 mb-6">계정 설정</h1>

      <div className="space-y-6">
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-gray-900">로그인 정보</h2>
          <dl className="mt-4 grid grid-cols-[6rem_1fr] gap-y-3 text-sm">
            <dt className="text-gray-500">이메일</dt>
            <dd className="text-gray-900 break-all">{profile?.email}</dd>
            <dt className="text-gray-500">로그인 방식</dt>
            <dd className="text-gray-900">{profile?.hasPassword ? '이메일과 비밀번호' : 'Google 계정'}</dd>
          </dl>
          {profile && !profile.hasPassword && (
            <p className="mt-4 text-sm text-gray-500">
              Google 계정으로 로그인하는 회원은 비밀번호가 없습니다. 로그인 보안은 Google 계정에서 관리해 주세요.
            </p>
          )}
        </Card>

        {profile?.hasPassword && <PasswordCard />}
      </div>
    </div>
  );
}
