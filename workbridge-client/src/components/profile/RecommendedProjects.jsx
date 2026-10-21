'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import Card from '@/components/ui/Card';
import { formatDate, formatKRW } from '@/lib/format';

const INCOMPLETE_PROFILE = '프로필을 먼저 완성해주세요';

// 프리랜서에게 맞는 프로젝트 추천(BEHAVIOR.md RC6–RC8). 프로필이 미완성이면 서버가 403을 주므로
// 완성을 유도한다. compact는 홈 화면용(카드 3개 + 더 보기).
export default function RecommendedProjects({ limit = 10, compact = false }) {
  const [projects, setProjects] = useState(null);
  const [incomplete, setIncomplete] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/users/me/recommended-projects', { params: { limit } })
      .then(({ data }) => setProjects(data.projects))
      .catch((err) => {
        if (err.response?.data?.error?.message === INCOMPLETE_PROFILE) setIncomplete(true);
        else setError('추천 프로젝트를 불러오지 못했습니다');
        setProjects([]);
      });
  }, [limit]);

  if (incomplete) {
    return (
      <Card className="p-6 text-center">
        <p className="text-gray-700">프로필을 완성하면 기술과 카테고리에 맞는 프로젝트를 추천해드려요.</p>
        <Link href="/profile" className="inline-block mt-3 text-sm font-medium text-primary-600 hover:text-primary-700">
          프로필 완성하러 가기 →
        </Link>
      </Card>
    );
  }
  if (projects === null) return <p className="text-sm text-gray-400">추천 프로젝트를 불러오는 중...</p>;
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (projects.length === 0) {
    return (
      <Card className="p-6 text-center text-gray-500">
        지금은 추천할 모집 중인 프로젝트가 없습니다. 기술 스택을 넓혀 보거나 프로젝트 목록을 둘러보세요.
      </Card>
    );
  }

  return (
    <div className={compact ? 'grid grid-cols-1 md:grid-cols-3 gap-4' : 'space-y-3'}>
      {projects.map((project) => (
        <Card key={project.id} className="p-5 hover:shadow-md transition-shadow">
          <div className="flex items-start justify-between gap-2">
            <Link href={`/projects/${project.id}`} className="min-w-0 flex-1">
              <h3 className="font-semibold text-gray-900 hover:text-primary-600 line-clamp-1">{project.title}</h3>
            </Link>
            <span className="shrink-0 rounded-full bg-primary-50 px-2 py-0.5 text-xs font-semibold text-primary-700">
              {project.score.toFixed(2)}점
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            {project.category} · {project.client?.companyName || project.client?.name}
          </p>
          <div className="flex flex-wrap gap-1 mt-3">
            {project.requiredSkills.map((skill) => (
              <span
                key={skill}
                className={`px-2 py-0.5 rounded text-xs ${
                  project.matchedSkills.includes(skill) ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-500'
                }`}
              >
                {skill}
              </span>
            ))}
          </div>
          <div className="flex items-center justify-between mt-3 text-sm">
            <span className="font-medium text-gray-900">{formatKRW(project.budget)}</span>
            <span className="text-xs text-gray-500">마감 {formatDate(project.deadline)}</span>
          </div>
        </Card>
      ))}
    </div>
  );
}
