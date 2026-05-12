'use client';

import Link from 'next/link';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import ProjectBookmarkButton from '@/components/projects/ProjectBookmarkButton';

export default function ProjectCard({ project, onBookmarkChange }) {
  const now = new Date();
  const recruitmentStartDate = project.recruitmentStartDate
    ? new Date(project.recruitmentStartDate)
    : null;
  const daysUntilStart = recruitmentStartDate
    ? Math.ceil((recruitmentStartDate - now) / (1000 * 60 * 60 * 24))
    : null;
  const daysLeft = Math.ceil(
    (new Date(project.deadline) - now) / (1000 * 60 * 60 * 24)
  );
  const timelineLabel = project.status === 'UPCOMING' && recruitmentStartDate
    ? daysUntilStart > 0 ? `${daysUntilStart}일 후 시작` : '오늘 시작'
    : daysLeft > 0 ? `${daysLeft}일 남음` : '마감됨';

  return (
    <Card className="p-5 hover:shadow-md transition-shadow h-full">
      <div className="flex items-start justify-between gap-2 mb-3">
        <Link href={`/projects/${project.id}`} className="min-w-0 flex-1">
          <h3 className="font-semibold text-gray-900 hover:text-primary-600 line-clamp-1">{project.title}</h3>
        </Link>
        <div className="flex flex-wrap justify-end gap-2">
          <Badge variant={project.status}>{project.status}</Badge>
          <ProjectBookmarkButton
            projectId={project.id}
            initialBookmarked={project.isBookmarked}
            onChange={onBookmarkChange}
          />
        </div>
      </div>

      <p className="text-sm text-gray-600 line-clamp-2 mb-3">{project.description}</p>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {project.requiredSkills?.slice(0, 3).map((skill) => (
          <span key={skill} className="px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded-full">
            {skill}
          </span>
        ))}
        {project.requiredSkills?.length > 3 && (
          <span className="px-2 py-0.5 bg-gray-50 text-gray-500 text-xs rounded-full">
            +{project.requiredSkills.length - 3}
          </span>
        )}
      </div>

      <div className="flex items-center justify-between text-sm">
        <div>
          <span className="text-gray-500">예산: </span>
          <span className="font-semibold text-gray-900">
            {project.budget?.toLocaleString()}원
          </span>
        </div>
        <div className="text-gray-500">
          {timelineLabel}
        </div>
      </div>

      <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100 text-xs text-gray-500">
        <span>{project.client?.companyName || project.client?.name}</span>
        <div className="flex items-center gap-3">
          <span>지원자 {project._count?.applications || 0}명</span>
          <Link href={`/projects/${project.id}`} className="text-primary-600 hover:text-primary-700 font-medium">
            상세 보기 →
          </Link>
        </div>
      </div>
    </Card>
  );
}
