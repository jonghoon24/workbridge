'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import authApi from '@/lib/authApi';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import { toUserMessage } from '@/lib/errorMessages';

const ROLE_OPTIONS = [
  { value: 'CLIENT', label: '의뢰인', desc: '프로젝트를 등록하고 프리랜서를 찾습니다' },
  { value: 'FREELANCER', label: '프리랜서', desc: '프로젝트를 탐색하고 지원합니다' },
];

export default function SelectRolePage() {
  const router = useRouter();
  const { setAuth } = useAuthStore();
  const [role, setRole] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    useAuthStore.getState().initAuth();

    if (!localStorage.getItem('accessToken')) {
      router.push('/login');
    }
  }, [router]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (!role) {
      setError('역할을 선택해 주세요.');
      return;
    }

    setLoading(true);
    try {
      const { data } = await authApi.post('/api/auth/select-role', { role });
      setAuth(data.user, data.accessToken);
      router.push('/profile');
    } catch (err) {
      setError(toUserMessage(err, '역할 선택에 실패했습니다.'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-md mx-auto px-4 sm:px-6 py-12">
      <Card className="p-6">
        <h1 className="text-xl font-bold text-gray-900 mb-2">역할 선택</h1>
        <p className="text-sm text-gray-600 mb-6">WorkBridge에서 사용할 역할을 선택해 주세요.</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3">
            {ROLE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setRole(option.value)}
                className={`p-4 rounded-lg border-2 text-left transition-colors ${
                  role === option.value
                    ? 'border-primary-500 bg-primary-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="font-medium text-gray-900">{option.label}</div>
                <div className="text-xs text-gray-500 mt-0.5">{option.desc}</div>
              </button>
            ))}
          </div>

          <Button type="submit" loading={loading} className="w-full">
            시작하기
          </Button>
        </form>
      </Card>
    </div>
  );
}
