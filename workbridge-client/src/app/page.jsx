import Link from 'next/link';
import api from '@/lib/api';
import ProjectCard from '@/components/projects/ProjectCard';
import HeroActions from '@/components/home/HeroActions';
import ProjectDiscovery from '@/components/home/ProjectDiscovery';
import HomeRecommendedProjects from '@/components/profile/HomeRecommendedProjects';
import { ShieldCheckIcon, SparklesIcon, StarIcon } from '@/components/ui/Icons';

// 최근 프로젝트는 요청마다 서버에서 읽는다. axios 호출은 Next가 동적 데이터로 알아채지 못해서
// 그냥 두면 빌드 때 정적으로 굳는다. 그러면 목록이 다음 배포까지 바뀌지 않고, 빌드가 그 환경의
// 목록 API(마감된 프로젝트를 닫으며 행을 쓴다)를 부른다. ISR(revalidate)도 빌드 때 한 번은
// 부르므로 동적 렌더링으로 둔다.
export const dynamic = 'force-dynamic';

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
              프로젝트를 단계별로 맡기고, 승인된 만큼 정산합니다
            </h1>
            <p className="text-base sm:text-lg text-primary-100 mb-9 max-w-2xl mx-auto leading-relaxed">
              의뢰인은 프로젝트를 등록하고 지원자를 비교해 전자 계약을 맺습니다.
              프리랜서는 마일스톤마다 결과물을 제출하고, 의뢰인이 승인한 금액을 정산받습니다.
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
          <h2 className="text-2xl sm:text-3xl font-bold text-center text-gray-900 mb-10 sm:mb-12">WorkBridge에서 일하는 방식</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
            {[
              {
                icon: SparklesIcon,
                title: 'AI 단가 분석',
                desc: '프로젝트 설명과 필요 기술을 바탕으로 기능별 예상 비용을 계산합니다. 예산을 정할 때 참고할 수 있습니다.',
              },
              {
                icon: ShieldCheckIcon,
                title: '전자 계약과 안전결제',
                desc: '양측이 마일스톤 계획에 서명하면 계약이 시작됩니다. 결제한 금액은 WorkBridge가 보관하다가 결과물이 승인되면 정산합니다.',
              },
              {
                icon: StarIcon,
                title: '상호 리뷰',
                desc: '계약이 끝나면 의뢰인과 프리랜서가 서로 평가를 남깁니다. 리뷰는 공개 프로필에 쌓입니다.',
              },
            ].map((feature) => (
              <div key={feature.title} className="flex gap-4 rounded-2xl border border-gray-200/80 bg-gray-50/60 p-5 sm:p-7 md:block">
                <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-600 text-white shadow-sm shadow-primary-600/30 md:mb-5">
                  <feature.icon className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">{feature.title}</h3>
                  <p className="text-[15px] leading-relaxed text-gray-600">{feature.desc}</p>
                </div>
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
