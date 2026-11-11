'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Input from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import { GoogleIcon } from '@/components/ui/Icons';
import useAuthStore from '@/store/authStore';
import authApi from '@/lib/authApi';
import { toUserMessage } from '@/lib/errorMessages';

/**
 * Where to go after logging in. Only a path on this site: it must start with `/`, and not with
 * `//` or `/\`, which browsers read as another host. Anything else (an absolute URL, a missing
 * value) goes home, so `/login?redirect=https://…` cannot send a user off-site.
 */
function safeRedirect(value) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

/** Google 로그인 콜백이 `/login?error=<코드>`로 돌려보낼 때 보여 줄 문구. */
const OAUTH_ERROR_MESSAGES = {
  oauth_failed: 'Google 로그인에 실패했습니다. 다시 시도해 주세요.',
  // 같은 이메일의 기존 계정에 Google 계정을 자동으로 연결하지 않는다(docs/domain/accounts.md).
  email_account_exists: '이미 이메일로 가입된 계정입니다. 이메일로 로그인해 주세요.',
};

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirect = safeRedirect(searchParams.get('redirect'));
  const { setAuth } = useAuthStore();

  const [form, setForm] = useState({ email: '', password: '' });
  const oauthError = searchParams.get('error');
  const [error, setError] = useState(
    oauthError && Object.hasOwn(OAUTH_ERROR_MESSAGES, oauthError) ? OAUTH_ERROR_MESSAGES[oauthError] : '',
  );
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    // 형식 검사는 하지 않는다: 형식이 틀린 이메일은 서버에서 없는 계정(401)과 같게 답한다.
    if (!form.email.trim()) {
      setError('이메일을 입력해 주세요.');
      return;
    }
    if (!form.password) {
      setError('비밀번호를 입력해 주세요.');
      return;
    }
    setError('');
    setLoading(true);

    try {
      const { data } = await authApi.post('/api/auth/login', form);
      setAuth(data.user, data.accessToken);
      router.push(redirect);
    } catch (err) {
      setError(toUserMessage(err, '로그인에 실패했습니다.'));
    } finally {
      setLoading(false);
    }
  }

  function handleGoogleLogin() {
    window.location.href = '/api/auth/google';
  }

  // noValidate: 브라우저 기본 검증 말풍선 대신 이 화면의 한국어 안내를 보여 준다.
  return (
    <form noValidate onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      <Input
        label="이메일"
        type="email"
        required
        value={form.email}
        onChange={(e) => setForm({ ...form, email: e.target.value })}
        placeholder="example@email.com"
      />

      <Input
        label="비밀번호"
        type="password"
        required
        value={form.password}
        onChange={(e) => setForm({ ...form, password: e.target.value })}
        placeholder="비밀번호를 입력해 주세요"
      />

      <Button type="submit" loading={loading} className="w-full" size="lg">
        로그인
      </Button>

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-gray-300" />
        </div>
        <div className="relative flex justify-center text-sm">
          <span className="bg-white px-2 text-gray-500">또는</span>
        </div>
      </div>

      <button
        type="button"
        onClick={handleGoogleLogin}
        className="w-full h-12 flex items-center justify-center gap-3 px-4 border border-gray-300 rounded-lg shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
      >
        <GoogleIcon />
        Google로 로그인
      </button>

      <p className="text-center text-sm text-gray-600">
        계정이 없으신가요?{' '}
        <Link href="/signup" className="text-primary-600 hover:text-primary-700 font-medium">
          회원가입
        </Link>
      </p>
    </form>
  );
}
