'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import ProjectForm from '@/components/projects/ProjectForm';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import { getProfileCompletionMessage, isProfileComplete } from '@/lib/profileCompletion';
import { toUserMessage } from '@/lib/errorMessages';

export default function NewProjectPage() {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get('/api/users/me')
      .then(({ data }) => setProfile(data))
      .catch((err) => {
        setError(toUserMessage(err, '프로필을 불러오지 못했습니다.'));
      })
      .finally(() => setLoading(false));
  }, []);

  const isClient = profile?.role === 'CLIENT';
  const needsProfile = isClient && !isProfileComplete(profile);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900">프로젝트 등록</h1>
        <p className="text-gray-600 mt-1">새 프로젝트를 등록하여 프리랜서를 모집하세요</p>
      </div>

      {loading ? (
        <Card className="p-6">
          <p className="text-center text-gray-500">프로필 확인 중...</p>
        </Card>
      ) : error ? (
        <Card className="p-6">
          <p className="text-sm text-red-600">{error}</p>
        </Card>
      ) : !isClient ? (
        <Card className="p-6">
          <h2 className="font-semibold text-gray-900 mb-2">프로젝트 등록 권한이 없습니다</h2>
          <p className="text-sm text-gray-600 mb-5">프로젝트 등록은 의뢰인 계정으로만 이용할 수 있습니다.</p>
          <Link href="/projects">
            <Button variant="secondary">프로젝트 찾기로 이동</Button>
          </Link>
        </Card>
      ) : needsProfile ? (
        <Card className="p-6">
          <h2 className="font-semibold text-gray-900 mb-2">프로필 작성이 필요합니다</h2>
          <p className="text-sm text-gray-600 mb-5">
            {getProfileCompletionMessage(profile.role)}
          </p>
          <Link href="/profile">
            <Button>프로필 작성하기</Button>
          </Link>
        </Card>
      ) : (
        <Card className="p-6">
          <ProjectForm />
        </Card>
      )}
    </div>
  );
}
