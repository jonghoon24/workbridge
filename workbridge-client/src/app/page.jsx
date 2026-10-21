import Link from 'next/link';
import api from '@/lib/api';
import ProjectCard from '@/components/projects/ProjectCard';
import HeroActions from '@/components/home/HeroActions';
import ProjectDiscovery from '@/components/home/ProjectDiscovery';
import HomeRecommendedProjects from '@/components/profile/HomeRecommendedProjects';

async function getRecentProjects() {
  try {
    const { data } = await api.get('/api/projects?limit=6&sort=latest');
    return data.projects || [];
  } catch {
    return [];
  }
}

export default async function HomePage() {
  const projects = await getRecentProjects();

  return (
    <div>
      {/* Hero Section */}
      <section className="bg-gradient-to-r from-primary-600 to-primary-700 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
          <div className="text-center">
            <h1 className="text-4xl md:text-5xl font-bold mb-4">
              최고의 프리랜서를 찾아드립니다
            </h1>
            <p className="text-xl text-primary-100 mb-8 max-w-2xl mx-auto">
              WorkBridge는 의뢰인과 프리랜서를 연결하는 안전한 매칭 플랫폼입니다.
              AI 기반 단가 분석으로 합리적인 가격에 최고의 결과를 만드세요.
            </p>
            <HeroActions />
          </div>
        </div>
      </section>

      <ProjectDiscovery />

      <HomeRecommendedProjects />

      {/* Features Section */}
      <section className="py-16 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-bold text-center text-gray-900 mb-12">주요 기능</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              {
                icon: '🤖',
                title: 'AI 단가 분석',
                desc: '프로젝트 내용을 AI가 분석하여 적정 단가를 산정해드립니다.',
              },
              {
                icon: '🔒',
                title: '안전한 계약',
                desc: '전자 서명과 에스크로 결제로 안전한 거래를 보장합니다.',
              },
              {
                icon: '⭐',
                title: '신뢰 기반 리뷰',
                desc: '실제 프로젝트 완료 후 상호 평가로 신뢰를 쌓습니다.',
              },
            ].map((feature) => (
              <div key={feature.title} className="text-center p-6 rounded-xl bg-gray-50">
                <div className="text-4xl mb-4">{feature.icon}</div>
                <h3 className="text-xl font-semibold text-gray-900 mb-2">{feature.title}</h3>
                <p className="text-gray-600">{feature.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Recent Projects */}
      {projects.length > 0 && (
        <section className="py-16 bg-gray-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-3xl font-bold text-gray-900">최근 프로젝트</h2>
              <Link href="/projects" className="text-primary-600 hover:text-primary-700 font-medium">
                전체 보기 →
              </Link>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {projects.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
