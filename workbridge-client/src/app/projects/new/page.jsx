import Card from '@/components/ui/Card';
import ProjectForm from '@/components/projects/ProjectForm';

export default function NewProjectPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">프로젝트 등록</h1>
        <p className="text-gray-600 mt-1">새 프로젝트를 등록하여 프리랜서를 모집하세요</p>
      </div>
      <Card className="p-6">
        <ProjectForm />
      </Card>
    </div>
  );
}
