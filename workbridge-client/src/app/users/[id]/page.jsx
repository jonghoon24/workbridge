'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import api from '@/lib/api';
import Card from '@/components/ui/Card';
import PortfolioGrid from '@/components/profile/PortfolioGrid';
import CareerTimeline from '@/components/profile/CareerTimeline';
import { formatCareerSummary } from '@/components/profile/profileFormat';
import Tag from '@/components/ui/Tag';
import PageLoader from '@/components/ui/PageLoader';
import EmptyState from '@/components/ui/EmptyState';
import { BriefcaseIcon, BuildingIcon, GlobeIcon, UserIcon } from '@/components/ui/Icons';
import { formatDate } from '@/lib/format';

export default function UserProfilePage() {
  const { id } = useParams();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/api/users/${id}`)
      .then(({ data }) => setUser(data))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <PageLoader />;
  if (!user) return <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12"><EmptyState icon={UserIcon} title="사용자를 찾을 수 없습니다" /></div>;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <Card className="p-6 mb-6">
        <div className="flex items-start gap-4">
          <div className="w-16 h-16 bg-primary-100 rounded-full flex items-center justify-center overflow-hidden flex-shrink-0">
            {user.profileImage ? (
              // eslint-disable-next-line @next/next/no-img-element -- 저장소 URL은 remotePatterns 밖일 수 있다(ProfileImage 참고)
              <img src={user.profileImage} alt={user.name} className="w-full h-full object-cover" />
            ) : (
              <span className="text-primary-700 font-bold text-xl">{user.name?.[0]?.toUpperCase()}</span>
            )}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold text-gray-900">{user.name}</h1>
              <span className="px-2 py-0.5 bg-primary-50 text-primary-700 rounded-md text-xs font-medium">
                {user.role === 'CLIENT' ? '의뢰인' : '프리랜서'}
              </span>
            </div>
            {user.avgRating !== null && (
              <div className="flex items-center gap-1 mt-1">
                <span className="text-yellow-400">★</span>
                <span className="text-sm font-medium">{user.avgRating?.toFixed(1)}</span>
                <span className="text-sm text-gray-500">리뷰 {user.reviewCount}개</span>
              </div>
            )}
            {user.bio && <p className="text-gray-600 mt-2 text-sm">{user.bio}</p>}
          </div>
        </div>

        {user.role === 'FREELANCER' && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <div className="grid grid-cols-2 gap-4 text-sm">
              {user.experienceYears && (
                <div>
                  <span className="text-gray-500">경력</span>
                  <span className="ml-2 font-medium">{user.experienceYears}년</span>
                </div>
              )}
              {user.hourlyRate && (
                <div>
                  <span className="text-gray-500">시간당 단가</span>
                  <span className="ml-2 font-medium">{user.hourlyRate?.toLocaleString()}원</span>
                </div>
              )}
              {user.activityCategory && (
                <div>
                  <span className="text-gray-500">주요 활동</span>
                  <span className="ml-2 font-medium">{user.activityCategory}</span>
                </div>
              )}
            </div>
            {user.skills?.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {user.skills.map((skill) => (
                  <Tag key={skill}>{skill}</Tag>
                ))}
              </div>
            )}
            {user.portfolioUrl && (
              <a href={user.portfolioUrl} target="_blank" rel="noopener noreferrer"
                className="inline-block mt-3 text-sm text-primary-600 hover:text-primary-700">
                포트폴리오 보기 →
              </a>
            )}
          </div>
        )}

        {user.role === 'CLIENT' && (
          <div className="mt-4 pt-4 border-t border-gray-100 text-sm space-y-1.5">
            {user.companyName && (
              <p className="flex items-center gap-2 text-gray-600">
                <BuildingIcon className="h-4 w-4 shrink-0 text-gray-400" />
                <span className="sr-only">회사</span>
                {user.companyName}
              </p>
            )}
            {user.businessField && (
              <p className="flex items-center gap-2 text-gray-600">
                <BriefcaseIcon className="h-4 w-4 shrink-0 text-gray-400" />
                <span className="sr-only">사업 분야</span>
                {user.businessField}
              </p>
            )}
            {user.website && (
              <a href={user.website} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 text-primary-600 hover:text-primary-700 break-all">
                <GlobeIcon className="h-4 w-4 shrink-0" />
                <span className="sr-only">웹사이트</span>
                {user.website}
              </a>
            )}
          </div>
        )}
      </Card>

      {/* Portfolio and careers (BEHAVIOR.md PF18, C10) */}
      {user.portfolioItems?.length > 0 && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">포트폴리오</h2>
          <PortfolioGrid items={user.portfolioItems} />
        </div>
      )}

      {user.careers?.length > 0 && (
        <div className="mb-6">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">경력</h2>
            <span className="text-sm text-gray-600">{formatCareerSummary(user.careerSummary)}</span>
          </div>
          <Card className="p-6">
            <CareerTimeline careers={user.careers} />
          </Card>
        </div>
      )}

      {/* Reviews */}
      {user.receivedReviews?.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">리뷰</h2>
          <div className="space-y-3">
            {user.receivedReviews.map((review) => (
              <Card key={review.id} className="p-4">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-sm font-medium text-gray-600">
                    {review.reviewer?.name?.[0]?.toUpperCase()}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-gray-900">{review.reviewer?.name}</span>
                      <div className="flex text-yellow-400 text-sm">{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</div>
                    </div>
                    <p className="text-sm text-gray-700 mt-1">{review.content}</p>
                    {review.tags?.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {review.tags.map((tag) => (
                          <span key={tag} className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs">{tag}</span>
                        ))}
                      </div>
                    )}
                    <p className="text-xs text-gray-400 mt-1">{formatDate(review.createdAt)}</p>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
