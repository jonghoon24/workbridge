'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import CheckboxChips from '@/components/ui/CheckboxChips';
import ProfileCompletionCard from '@/components/profile/ProfileCompletionCard';
import {
  BUSINESS_FIELD_OPTIONS,
  FREELANCER_ACTIVITY_CATEGORIES,
  normalizeSkillList,
  SKILL_OPTIONS,
  resolveOtherValue,
  resolvePreset,
} from '@/constants/taxonomy';

function resolveSelectableValue(preset, other) {
  return preset === '기타' ? other.trim() : preset;
}

export default function ProfilePage() {
  const router = useRouter();
  const { setAuth } = useAuthStore();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [imageFile, setImageFile] = useState(null);
  const [completionKey, setCompletionKey] = useState(0);

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get('/api/users/me')
      .then(({ data }) => {
        setProfile(data);
        setForm({
          name: data.name || '',
          bio: data.bio || '',
          companyName: data.companyName || '',
          businessFieldPreset: resolvePreset(data.businessField, BUSINESS_FIELD_OPTIONS),
          businessFieldOther: resolveOtherValue(data.businessField, BUSINESS_FIELD_OPTIONS),
          website: data.website || '',
          skills: normalizeSkillList(data.skills || []),
          activityCategoryPreset: resolvePreset(data.activityCategory, FREELANCER_ACTIVITY_CATEGORIES),
          activityCategoryOther: resolveOtherValue(data.activityCategory, FREELANCER_ACTIVITY_CATEGORIES),
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
      const payload = {
        name: form.name,
        bio: form.bio,
      };

      if (profile?.role === 'CLIENT') {
        const businessField = resolveSelectableValue(form.businessFieldPreset, form.businessFieldOther);
        if (!form.companyName?.trim() || !businessField) {
          setError('회사명과 사업 분야를 입력해주세요');
          return;
        }

        payload.companyName = form.companyName;
        payload.businessField = businessField;
        payload.website = form.website;
      }

      if (profile?.role === 'FREELANCER') {
        const activityCategory = resolveSelectableValue(form.activityCategoryPreset, form.activityCategoryOther);
        const experienceYears = Number(form.experienceYears);
        const hourlyRate = Number(form.hourlyRate);

        if (
          form.skills.length === 0
          || !activityCategory
          || form.experienceYears === ''
          || !Number.isInteger(experienceYears)
          || experienceYears < 0
          || form.hourlyRate === ''
          || !Number.isFinite(hourlyRate)
          || hourlyRate <= 0
        ) {
          setError('기술 스택, 활동 카테고리, 경력, 시간당 단가를 입력해주세요');
          return;
        }

        payload.skills = normalizeSkillList(form.skills);
        payload.activityCategory = activityCategory;
        payload.portfolioUrl = form.portfolioUrl;
        if (form.experienceYears !== '') payload.experienceYears = form.experienceYears;
        if (form.hourlyRate !== '') payload.hourlyRate = form.hourlyRate;
      }

      Object.entries(payload).forEach(([key, value]) => {
        if (Array.isArray(value)) {
          formData.append(key, value.join(','));
          return;
        }

        formData.append(key, value ?? '');
      });
      if (imageFile) formData.append('profileImage', imageFile);

      const { data } = await api.patch('/api/users/me', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      setProfile(data);
      setAuth(data, useAuthStore.getState().accessToken);
      setSuccess('프로필이 저장되었습니다');
      setCompletionKey((key) => key + 1);
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

      <div className="mb-6">
        <ProfileCompletionCard refreshKey={completionKey} />
      </div>

      {profile?.role === 'FREELANCER' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
          <Link
            href="/profile/portfolio"
            className="rounded-lg border border-gray-200 bg-white p-4 hover:border-primary-300 hover:bg-primary-50"
          >
            <p className="font-medium text-gray-900">포트폴리오 관리 →</p>
            <p className="text-xs text-gray-500 mt-1">대표 작업을 이미지와 함께 보여주세요</p>
          </Link>
          <Link
            href="/profile/careers"
            className="rounded-lg border border-gray-200 bg-white p-4 hover:border-primary-300 hover:bg-primary-50"
          >
            <p className="font-medium text-gray-900">경력 관리 →</p>
            <p className="text-xs text-gray-500 mt-1">회사, 직책, 기간을 정리해 신뢰를 높이세요</p>
          </Link>
        </div>
      )}

      <Card className="p-6" id="profile-form">
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
              <Input label="회사명" required value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} />
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  사업 분야 <span className="text-red-500">*</span>
                </label>
                <select
                  required
                  value={form.businessFieldPreset || ''}
                  onChange={(e) => setForm({ ...form, businessFieldPreset: e.target.value })}
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                >
                  <option value="">사업 분야 선택</option>
                  {BUSINESS_FIELD_OPTIONS.map((field) => (
                    <option key={field} value={field}>{field}</option>
                  ))}
                </select>
              </div>
              {form.businessFieldPreset === '기타' && (
                <Input
                  label="기타 사업 분야"
                  value={form.businessFieldOther}
                  onChange={(e) => setForm({ ...form, businessFieldOther: e.target.value })}
                  placeholder="사업 분야를 입력하세요"
                />
              )}
              <Input label="웹사이트" type="url" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
            </>
          )}

          {profile?.role === 'FREELANCER' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  기술 스택 <span className="text-red-500">*</span>
                </label>
                <CheckboxChips
                  options={SKILL_OPTIONS}
                  value={form.skills}
                  onChange={(skills) => setForm({ ...form, skills: normalizeSkillList(skills) })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  주요 활동 카테고리 <span className="text-red-500">*</span>
                </label>
                <select
                  required
                  value={form.activityCategoryPreset || ''}
                  onChange={(e) => setForm({ ...form, activityCategoryPreset: e.target.value })}
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                >
                  <option value="">활동 카테고리 선택</option>
                  {FREELANCER_ACTIVITY_CATEGORIES.map((category) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
              </div>
              {form.activityCategoryPreset === '기타' && (
                <Input
                  label="기타 활동 카테고리"
                  value={form.activityCategoryOther}
                  onChange={(e) => setForm({ ...form, activityCategoryOther: e.target.value })}
                  placeholder="활동 카테고리를 입력하세요"
                />
              )}
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="경력 (년)"
                  required
                  type="number"
                  value={form.experienceYears}
                  onChange={(e) => setForm({ ...form, experienceYears: e.target.value })}
                  placeholder="예: 3"
                />
                <Input
                  label="시간당 단가 (원)"
                  required
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
