'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Input from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import useAuthStore from '@/store/authStore';
import authApi from '@/lib/authApi';
import { toUserMessage } from '@/lib/errorMessages';

// 서버 signup 스키마(workbridge-server/src/schemas/auth.ts)와 같은 규칙. 로그인에는 적용하지 않는다.
const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function SignupForm() {
  const router = useRouter();
  const { setAuth } = useAuthStore();

  const [form, setForm] = useState({ name: '', email: '', password: '', role: '' });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);

  function validate() {
    const errs = {};
    if (!form.name.trim()) errs.name = '이름을 입력해 주세요.';
    if (!form.email.trim()) errs.email = '이메일을 입력해 주세요.';
    else if (!EMAIL_PATTERN.test(form.email.trim())) errs.email = '올바른 이메일 주소를 입력해 주세요.';
    if (!form.password || form.password.length < MIN_PASSWORD_LENGTH) {
      errs.password = `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`;
    }
    if (!form.role) errs.role = '역할을 선택해 주세요.';
    return errs;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }

    setLoading(true);
    try {
      const { data } = await authApi.post('/api/auth/signup', form);
      setAuth(data.user, data.accessToken);
      router.push('/');
    } catch (err) {
      setErrors({ submit: toUserMessage(err, '회원가입에 실패했습니다.') });
    } finally {
      setLoading(false);
    }
  }

  // noValidate: 브라우저 기본 검증 말풍선 대신 위 validate()의 한국어 안내를 보여 준다.
  // type="email"은 모바일 키보드 힌트로 남겨 둔다.
  return (
    <form noValidate onSubmit={handleSubmit} className="space-y-4">
      {errors.submit && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {errors.submit}
        </div>
      )}

      <Input
        label="이름"
        required
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        error={errors.name}
        placeholder="홍길동"
      />

      <Input
        label="이메일"
        type="email"
        required
        value={form.email}
        onChange={(e) => setForm({ ...form, email: e.target.value })}
        error={errors.email}
        placeholder="example@email.com"
      />

      <Input
        label="비밀번호"
        type="password"
        required
        value={form.password}
        onChange={(e) => setForm({ ...form, password: e.target.value })}
        error={errors.password}
        placeholder="8자 이상 입력해 주세요"
      />

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          역할 선택 <span className="text-red-500">*</span>
        </label>
        <div className="grid grid-cols-2 gap-3">
          {[
            { value: 'CLIENT', label: '의뢰인', desc: '프로젝트를 의뢰합니다' },
            { value: 'FREELANCER', label: '프리랜서', desc: '프로젝트에 지원합니다' },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setForm({ ...form, role: option.value })}
              className={`p-4 rounded-xl border-2 text-left transition-colors ${
                form.role === option.value
                  ? 'border-primary-500 bg-primary-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="font-medium text-gray-900">{option.label}</div>
              <div className="text-xs text-gray-500 mt-0.5">{option.desc}</div>
            </button>
          ))}
        </div>
        {errors.role && <p className="mt-1 text-sm text-red-600">{errors.role}</p>}
      </div>

      <Button type="submit" loading={loading} className="w-full" size="lg">
        회원가입
      </Button>

      <p className="text-center text-sm text-gray-600">
        이미 계정이 있으신가요?{' '}
        <Link href="/login" className="text-primary-600 hover:text-primary-700 font-medium">
          로그인
        </Link>
      </p>
    </form>
  );
}
