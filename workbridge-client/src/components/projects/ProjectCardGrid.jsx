'use client';

import ProjectCard from '@/components/projects/ProjectCard';
import useBookmarkedProjectIds from '@/lib/useBookmarkedProjectIds';

// 서버 컴포넌트가 렌더링하는 카드 목록(홈의 최근 프로젝트). 북마크 여부를 목록에서 한 번에 불러와
// 카드에 넘긴다.
export default function ProjectCardGrid({ projects, className }) {
  const { isBookmarked, setBookmarked } = useBookmarkedProjectIds();

  return (
    <div className={className}>
      {projects.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          bookmarked={isBookmarked(project.id)}
          onBookmarkChange={(bookmarked) => setBookmarked(project.id, bookmarked)}
        />
      ))}
    </div>
  );
}
