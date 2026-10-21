'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import Card from '@/components/ui/Card';
import ProfileImage from './ProfileImage';

// 프로젝트에 맞는 프리랜서 추천(BEHAVIOR.md RC3–RC5). 이 프로젝트에 이미 지원한 사람은 서버가 뺀다.
export default function RecommendedFreelancers({ projectId, limit = 10 }) {
  const [freelancers, setFreelancers] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/api/projects/${projectId}/recommended-freelancers`, { params: { limit } })
      .then(({ data }) => setFreelancers(data.freelancers))
      .catch((err) => {
        const status = err.response?.status;
        setError(status === 403 || status === 404 ? '' : '추천 프리랜서를 불러오지 못했습니다');
        setFreelancers([]);
      });
  }, [projectId, limit]);

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-gray-900">추천 프리랜서</h2>
      <p className="text-xs text-gray-500 mt-1 mb-4">요구 기술, 카테고리, 평점, 경력으로 매긴 점수 순입니다.</p>

      {freelancers === null && <p className="text-sm text-gray-400">불러오는 중...</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {freelancers?.length === 0 && !error && (
        <p className="text-sm text-gray-500">조건에 맞는 프리랜서가 아직 없습니다.</p>
      )}

      <ul className="space-y-4">
        {freelancers?.map((freelancer) => (
          <li key={freelancer.id} className="border-b border-gray-100 pb-4 last:border-0 last:pb-0">
            <div className="flex items-start gap-3">
              <ProfileImage
                src={freelancer.profileImage}
                alt={freelancer.name}
                className="w-10 h-10 rounded-full shrink-0"
                fallback={<span className="text-sm font-semibold text-primary-700">{freelancer.name?.[0]?.toUpperCase()}</span>}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <Link href={`/users/${freelancer.id}`} className="font-medium text-gray-900 hover:text-primary-600 truncate">
                    {freelancer.name}
                  </Link>
                  <span className="shrink-0 rounded-full bg-primary-50 px-2 py-0.5 text-xs font-semibold text-primary-700">
                    {freelancer.score.toFixed(2)}점
                  </span>
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  {[
                    freelancer.activityCategory,
                    `경력 ${freelancer.experienceYears}년`,
                    freelancer.avgRating !== null
                      ? `★ ${freelancer.avgRating.toFixed(1)} (${freelancer.reviewCount})`
                      : '리뷰 없음',
                  ].filter(Boolean).join(' · ')}
                </p>
                {freelancer.matchedSkills.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {freelancer.matchedSkills.map((skill) => (
                      <span key={skill} className="px-2 py-0.5 bg-green-50 text-green-700 rounded text-xs">{skill}</span>
                    ))}
                  </div>
                )}
                {freelancer.portfolioPreview.length > 0 && (
                  <p className="text-xs text-gray-500 mt-2 truncate">
                    포트폴리오: {freelancer.portfolioPreview.map((item) => item.title).join(', ')}
                  </p>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
