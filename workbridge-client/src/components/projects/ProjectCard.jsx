'use client';

import Link from 'next/link';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';

export default function ProjectCard({ project }) {
  const daysLeft = Math.ceil(
    (new Date(project.deadline) - new Date()) / (1000 * 60 * 60 * 24)
  );

  return (
    <Link href={`/projects/${project.id}`}>
      <Card className="p-5 hover:shadow-md transition-shadow cursor-pointer h-full">
        <div className="flex items-start justify-between gap-2 mb-3">
          <h3 className="font-semibold text-gray-900 line-clamp-1 flex-1">{project.title}</h3>
          <Badge variant={project.status}>{project.status}</Badge>
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
            {daysLeft > 0 ? `${daysLeft}일 남음` : '마감됨'}
          </div>
        </div>

        <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100 text-xs text-gray-500">
          <span>{project.client?.companyName || project.client?.name}</span>
          <span>지원자 {project._count?.applications || 0}명</span>
        </div>
      </Card>
    </Link>
  );
}
