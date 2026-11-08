'use client';

import Link from 'next/link';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import ProjectBookmarkButton from '@/components/projects/ProjectBookmarkButton';
import Tag from '@/components/ui/Tag';

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

  const urgent = project.status === 'OPEN' && daysLeft > 0 && daysLeft <= 7;

  return (
    <Card className="group flex h-full flex-col p-5 transition-shadow hover:shadow-card-hover">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant={project.status}>{project.status}</Badge>
          <span className={`truncate text-xs font-medium ${urgent ? 'text-red-600' : 'text-gray-500'}`}>
            {timelineLabel}
          </span>
        </div>
        <ProjectBookmarkButton
          projectId={project.id}
          initialBookmarked={project.isBookmarked}
          onChange={onBookmarkChange}
        />
      </div>

      <Link href={`/projects/${project.id}`} className="block">
        <h3 className="text-[17px] font-semibold leading-snug text-gray-900 line-clamp-1 group-hover:text-primary-700">{project.title}</h3>
      </Link>

      <p className="mt-1.5 mb-3 text-sm leading-relaxed text-gray-600 line-clamp-2">{project.description}</p>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {project.requiredSkills?.slice(0, 3).map((skill) => (
          <Tag key={skill}>{skill}</Tag>
        ))}
        {project.requiredSkills?.length > 3 && (
          <Tag tone="muted">+{project.requiredSkills.length - 3}</Tag>
        )}
      </div>

      <div className="mt-auto flex items-baseline justify-between text-sm">
        <div>
          <span className="text-gray-500">예산: </span>
          <span className="text-base font-bold text-gray-900">
            {project.budget?.toLocaleString()}원
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-gray-100 text-xs text-gray-500">
        <span className="truncate">{project.client?.companyName || project.client?.name}</span>
        <div className="flex shrink-0 items-center gap-3">
          <span>지원자 {project._count?.applications || 0}명</span>
          <Link href={`/projects/${project.id}`} className="text-primary-600 hover:text-primary-700 font-semibold">
            상세 보기 →
          </Link>
        </div>
      </div>
    </Card>
  );
}
