'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';

export default function ProfilePage() {
  const router = useRouter();
  const { user, setAuth } = useAuthStore();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [imageFile, setImageFile] = useState(null);

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get('/api/users/me')
      .then(({ data }) => {
        setProfile(data);
        setForm({
          name: data.name || '',
          bio: data.bio || '',
          companyName: data.companyName || '',
          businessField: data.businessField || '',
          website: data.website || '',
          skills: data.skills?.join(', ') || '',
          experienceYears: data.experienceYears || '',
          hourlyRate: data.hourlyRate || '',
          portfolioUrl: data.portfolioUrl || '',
        });
      })
      .catch(() => router.push('/login'))
      .finally(() => setLoading(false));
  }, [router]);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');

    try {
      const formData = new FormData();
      Object.entries(form).forEach(([key, value]) => {
        if (value !== '') formData.append(key, value);
      });
      if (imageFile) formData.append('profileImage', imageFile);

      const { data } = await api.patch('/api/users/me', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      setProfile(data);
      setAuth(data, useAuthStore.getState().accessToken);
      setSuccess('프로필이 저장되었습니다');
    } catch (err) {
      setError(err.response?.data?.error?.message || '저장에 실패했습니다');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="max-w-2xl mx-auto px-4 py-8 text-center">로딩 중...</div>;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">내 프로필</h1>

      <Card className="p-6">
        <form onSubmit={handleSubmit} className="space-y-5">
          {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
          {success && <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">{success}</div>}

          {/* Profile Image */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">프로필 이미지</label>
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 bg-primary-100 rounded-full flex items-center justify-center overflow-hidden">
                {profile?.profileImage ? (
                  <img src={profile.profileImage} alt="profile" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-primary-700 font-bold text-xl">{profile?.name?.[0]?.toUpperCase()}</span>
                )}
              </div>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => setImageFile(e.target.files[0])}
                className="text-sm text-gray-600"
              />
            </div>
          </div>

          <Input
            label="이름"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">자기소개</label>
            <textarea
              value={form.bio}
              onChange={(e) => setForm({ ...form, bio: e.target.value })}
              rows={3}
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
              placeholder="자신을 소개해주세요"
            />
          </div>

          {/* Role-specific fields */}
          {profile?.role === 'CLIENT' && (
            <>
              <Input label="회사명" value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} />
              <Input label="사업 분야" value={form.businessField} onChange={(e) => setForm({ ...form, businessField: e.target.value })} />
              <Input label="웹사이트" type="url" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
            </>
          )}

          {profile?.role === 'FREELANCER' && (
            <>
              <Input
                label="기술 스택"
                value={form.skills}
                onChange={(e) => setForm({ ...form, skills: e.target.value })}
                placeholder="React, Node.js (쉼표 구분)"
              />
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="경력 (년)"
                  type="number"
                  value={form.experienceYears}
                  onChange={(e) => setForm({ ...form, experienceYears: e.target.value })}
                  placeholder="예: 3"
                />
                <Input
                  label="시간당 단가 (원)"
                  type="number"
                  value={form.hourlyRate}
                  onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })}
                  placeholder="예: 50000"
                />
              </div>
              <Input
                label="포트폴리오 URL"
                type="url"
                value={form.portfolioUrl}
                onChange={(e) => setForm({ ...form, portfolioUrl: e.target.value })}
              />
            </>
          )}

          <div className="flex justify-end">
            <Button type="submit" loading={saving}>저장하기</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
