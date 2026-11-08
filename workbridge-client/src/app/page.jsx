import Link from 'next/link';
import api from '@/lib/api';
import ProjectCard from '@/components/projects/ProjectCard';
import HeroActions from '@/components/home/HeroActions';
import ProjectDiscovery from '@/components/home/ProjectDiscovery';
import HomeRecommendedProjects from '@/components/profile/HomeRecommendedProjects';
import { ShieldCheckIcon, SparklesIcon, StarIcon } from '@/components/ui/Icons';

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
      <section className="relative overflow-hidden bg-gradient-to-br from-primary-700 via-primary-600 to-indigo-600 text-white">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_30rem_at_80%_-10%,rgba(255,255,255,0.18),transparent),radial-gradient(40rem_20rem_at_0%_110%,rgba(255,255,255,0.10),transparent)]" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:linear-gradient(to_right,white_1px,transparent_1px),linear-gradient(to_bottom,white_1px,transparent_1px)] [background-size:44px_44px]" />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-24">
          <div className="text-center">
            <h1 className="text-[2rem] leading-tight sm:text-5xl font-bold mb-5 tracking-tight">
              최고의 프리랜서를 찾아드립니다
            </h1>
            <p className="text-base sm:text-lg text-primary-100 mb-9 max-w-2xl mx-auto leading-relaxed">
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
      <section className="py-16 sm:py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl sm:text-3xl font-bold text-center text-gray-900 mb-10 sm:mb-12">주요 기능</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
            {[
              {
                icon: SparklesIcon,
                title: 'AI 단가 분석',
                desc: '프로젝트 내용을 AI가 분석하여 적정 단가를 산정해드립니다.',
              },
              {
                icon: ShieldCheckIcon,
                title: '안전한 계약',
                desc: '전자 서명과 에스크로 결제로 안전한 거래를 보장합니다.',
              },
              {
                icon: StarIcon,
                title: '신뢰 기반 리뷰',
                desc: '실제 프로젝트 완료 후 상호 평가로 신뢰를 쌓습니다.',
              },
            ].map((feature) => (
              <div key={feature.title} className="rounded-2xl border border-gray-200/80 bg-gray-50/60 p-6 sm:p-7">
                <div className="mb-5 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-primary-600 text-white shadow-sm shadow-primary-600/30">
                  <feature.icon className="h-5 w-5" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-1.5">{feature.title}</h3>
                <p className="text-[15px] leading-relaxed text-gray-600">{feature.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Recent Projects */}
      {projects.length > 0 && (
        <section className="py-16 sm:py-20 bg-gray-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-end justify-between mb-6 sm:mb-8">
              <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">최근 프로젝트</h2>
              <Link href="/projects" className="inline-flex items-center gap-1 text-sm sm:text-base text-primary-600 hover:text-primary-700 font-semibold">
                전체 보기 →
              </Link>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
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
