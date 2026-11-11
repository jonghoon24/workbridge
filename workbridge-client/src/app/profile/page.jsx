'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Button, { buttonClasses } from '@/components/ui/Button';
import CopyLinkButton from '@/components/ui/CopyLinkButton';
import { ExternalLinkIcon } from '@/components/ui/Icons';
import Input from '@/components/ui/Input';
import CheckboxChips from '@/components/ui/CheckboxChips';
import ProfileCompletionCard from '@/components/profile/ProfileCompletionCard';
import PageLoader from '@/components/ui/PageLoader';
import FileButton from '@/components/ui/FileButton';
import EmptyState from '@/components/ui/EmptyState';
import {
  BUSINESS_FIELD_OPTIONS,
  FREELANCER_ACTIVITY_CATEGORIES,
  normalizeSkillList,
  SKILL_OPTIONS,
  resolveOtherValue,
  resolvePreset,
} from '@/constants/taxonomy';
import { toUserMessage } from '@/lib/errorMessages';

function resolveSelectableValue(preset, other) {
  return preset === '기타' ? other.trim() : preset;
}

// 서버의 시간당 단가 상한(workbridge-server/src/schemas/users.ts MAX_HOURLY_RATE)
const MAX_HOURLY_RATE = 100_000_000;

// 웹사이트·포트폴리오 URL. 예전 type="url" 입력의 브라우저 검사를 대신한다(http/https만).
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export default function ProfilePage() {
  const router = useRouter();
  const { setUser } = useAuthStore();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [imageFile, setImageFile] = useState(null);
  const [completionKey, setCompletionKey] = useState(0);
  const [loadError, setLoadError] = useState('');

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
          experienceYears: data.experienceYears ?? '',
          hourlyRate: data.hourlyRate ?? '',
          portfolioUrl: data.portfolioUrl || '',
        });
      })
      .catch((err) => {
        // 로그인이 풀린 경우만 로그인으로 보낸다. 서버 오류나 네트워크 오류는 이 화면에서 알린다.
        if (err.response?.status === 401) {
          router.push('/login?redirect=/profile');
          return;
        }
        setLoadError(toUserMessage(err, '프로필을 불러오지 못했습니다.'));
      })
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

      // 브라우저 기본 검증은 끄고(<form noValidate>) 여기서 검사한다. 안내 문구는 같은 오류에 대한
      // 서버 문구의 한국어 매핑(lib/errorMessages.js)과 같다.
      if (!form.name.trim()) {
        setError('이름을 입력해 주세요.');
        return;
      }

      if (profile?.role === 'CLIENT') {
        const businessField = resolveSelectableValue(form.businessFieldPreset, form.businessFieldOther);
        if (!form.companyName?.trim()) {
          setError('회사명을 입력해 주세요.');
          return;
        }
        if (!businessField) {
          setError('사업 분야를 선택해 주세요.');
          return;
        }
        if (form.website.trim() && !isHttpUrl(form.website.trim())) {
          setError('웹사이트는 http:// 또는 https://로 시작하는 주소여야 합니다.');
          return;
        }

        payload.companyName = form.companyName;
        payload.businessField = businessField;
        payload.website = form.website;
      }

      if (profile?.role === 'FREELANCER') {
        const activityCategory = resolveSelectableValue(form.activityCategoryPreset, form.activityCategoryOther);
        // 숫자 입력칸은 숫자가 아닌 입력을 ''로 준다. 빈 값도 형식 오류와 같은 안내를 쓴다.
        const experienceYears = form.experienceYears === '' ? NaN : Number(form.experienceYears);
        const hourlyRate = form.hourlyRate === '' ? NaN : Number(form.hourlyRate);

        if (form.skills.length === 0) {
          setError('기술 스택을 하나 이상 선택해 주세요.');
          return;
        }
        if (!activityCategory) {
          setError('활동 카테고리를 선택해 주세요.');
          return;
        }
        if (!Number.isSafeInteger(experienceYears) || experienceYears < 0) {
          setError('경력은 0 이상의 정수(년 단위)로 입력해 주세요.');
          return;
        }
        // 서버 규칙(workbridge-server/src/schemas/users.ts): 단가는 1원 이상 1억 원 이하의 원 단위 정수.
        if (!Number.isSafeInteger(hourlyRate) || hourlyRate <= 0) {
          setError('시간당 단가는 1원 이상의 원 단위 정수로 입력해 주세요.');
          return;
        }
        if (hourlyRate > MAX_HOURLY_RATE) {
          setError('시간당 단가는 1억 원 이하로 입력해 주세요.');
          return;
        }
        if (form.portfolioUrl.trim() && !isHttpUrl(form.portfolioUrl.trim())) {
          setError('포트폴리오 URL은 http:// 또는 https://로 시작하는 주소여야 합니다.');
          return;
        }

        payload.skills = normalizeSkillList(form.skills);
        payload.activityCategory = activityCategory;
        payload.portfolioUrl = form.portfolioUrl;
        // 숫자 입력칸은 '1e5' 같은 표기도 받으므로, 서버가 받는 정수 문자열로 바꿔 보낸다.
        payload.experienceYears = String(experienceYears);
        payload.hourlyRate = String(hourlyRate);
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
      setUser(data);
      setSuccess('프로필이 저장되었습니다.');
      setCompletionKey((key) => key + 1);
    } catch (err) {
      setError(toUserMessage(err, '저장에 실패했습니다.'));
    } finally {
      setSaving(false);
    }
  }

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
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900">내 프로필</h1>
        {profile?.id && (
          <div className="flex items-center gap-2">
            <CopyLinkButton path={`/users/${profile.id}`} />
            <Link href={`/users/${profile.id}`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
              <ExternalLinkIcon className="h-4 w-4" />
              공개 프로필 보기
            </Link>
          </div>
        )}
      </div>

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
            <p className="text-xs text-gray-500 mt-1">대표 작업을 이미지와 함께 보여 주세요</p>
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
        {/* noValidate: 브라우저 기본 검증 말풍선 대신 handleSubmit의 한국어 안내를 보여 준다. */}
        <form noValidate onSubmit={handleSubmit} className="space-y-5">
          {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
          {success && <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">{success}</div>}

          {/* Profile Image */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">프로필 이미지</label>
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 bg-primary-100 rounded-full flex items-center justify-center overflow-hidden">
                {profile?.profileImage ? (
                  // eslint-disable-next-line @next/next/no-img-element -- 저장소 URL은 remotePatterns 밖일 수 있다(ProfileImage 참고)
                  <img src={profile.profileImage} alt="profile" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-primary-700 font-bold text-xl">{profile?.name?.[0]?.toUpperCase()}</span>
                )}
              </div>
              <div className="min-w-0">
                <FileButton
                  label={profile?.profileImage ? '이미지 바꾸기' : '이미지 선택'}
                  accept="image/*"
                  onChange={(e) => setImageFile(e.target.files[0] || null)}
                  fileName={imageFile?.name || ''}
                  placeholder="이미지 파일, 5MB 이하"
                />
              </div>
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
              className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
              placeholder="자신을 소개해 주세요"
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
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
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
                  placeholder="사업 분야를 입력해 주세요"
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
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
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
                  placeholder="활동 카테고리를 입력해 주세요"
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
