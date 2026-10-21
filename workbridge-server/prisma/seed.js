// CommonJS: this file is run directly by `node` and is outside tsconfig's `include`,
// so it is not transpiled. The package has no `"type": "module"`, which means `import`
// syntax here would be a SyntaxError.
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Clean existing data (역순으로 삭제)
  // Notification must be deleted first: it holds a `userId` foreign key, so the
  // `user.deleteMany()` below fails with Prisma P2003 if any notification rows survive.
  // The app creates these whenever an application is accepted, so anyone who uses the
  // app and then re-seeds hits this.
  // Infrastructure tables have no foreign keys; cleared so a re-seed starts from an empty queue.
  // (Recurring jobs are not seeded — the worker recreates them via `ensureRecurringJobs`.)
  await prisma.job.deleteMany();
  await prisma.rateLimitCounter.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.review.deleteMany();
  // Phase 1 models, children first (every FK is ON DELETE RESTRICT).
  await prisma.settlementItem.deleteMany();
  await prisma.settlement.deleteMany();
  await prisma.payoutAccount.deleteMany();
  await prisma.milestoneAttachment.deleteMany();
  await prisma.milestoneSubmission.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.milestone.deleteMany();
  await prisma.contract.deleteMany();
  await prisma.pricingAnalysis.deleteMany();
  await prisma.projectBookmark.deleteMany();
  await prisma.application.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();

  const password = await bcrypt.hash('password123', 10);

  // ─── Users ───────────────────────────────────────────
  const client1 = await prisma.user.create({
    data: {
      email: 'kim@example.com',
      password,
      name: '김서준',
      role: 'CLIENT',
      bio: '스타트업 대표로 다양한 IT 프로젝트를 진행하고 있습니다.',
      companyName: '넥스트랩',
      businessField: 'IT/소프트웨어',
      website: 'https://nextlab.io',
    },
  });

  const client2 = await prisma.user.create({
    data: {
      email: 'lee@example.com',
      password,
      name: '이수현',
      role: 'CLIENT',
      bio: '마케팅 에이전시를 운영하며 웹/앱 개발 외주를 자주 의뢰합니다.',
      companyName: '브릿지마케팅',
      businessField: '마케팅/광고',
      website: 'https://bridgemkt.co.kr',
    },
  });

  const client3 = await prisma.user.create({
    data: {
      email: 'choi@example.com',
      password,
      name: '최민호',
      role: 'CLIENT',
      bio: '교육 플랫폼 기획자입니다.',
      companyName: '에듀플러스',
      businessField: '교육/에듀테크',
    },
  });

  const freelancer1 = await prisma.user.create({
    data: {
      email: 'park@example.com',
      password,
      name: '박지윤',
      role: 'FREELANCER',
      bio: '풀스택 개발자로 5년간 다양한 웹 서비스를 개발해왔습니다. React와 Node.js를 주로 사용합니다.',
      skills: ['React', 'Node.js', 'TypeScript', 'SQL', 'AWS'],
      activityCategory: '웹 개발',
      experienceYears: 5,
      hourlyRate: 60000,
      portfolioUrl: 'https://jiyun-dev.vercel.app',
    },
  });

  const freelancer2 = await prisma.user.create({
    data: {
      email: 'jung@example.com',
      password,
      name: '정하은',
      role: 'FREELANCER',
      bio: 'UI/UX 디자인과 프론트엔드 개발을 모두 할 수 있는 디자인 엔지니어입니다.',
      skills: ['Figma', 'React', 'Next.js', 'Tailwind CSS', 'Framer Motion'],
      activityCategory: '디자인',
      experienceYears: 4,
      hourlyRate: 55000,
      portfolioUrl: 'https://haeun-design.com',
    },
  });

  const freelancer3 = await prisma.user.create({
    data: {
      email: 'han@example.com',
      password,
      name: '한도윤',
      role: 'FREELANCER',
      bio: '백엔드 전문 개발자입니다. 대규모 트래픽 처리와 API 설계에 강점이 있습니다.',
      skills: ['Java', 'Spring Boot', 'Node.js', 'Docker', 'Kubernetes', 'Redis'],
      activityCategory: '웹 개발',
      experienceYears: 7,
      hourlyRate: 80000,
      portfolioUrl: 'https://github.com/handoyun',
    },
  });

  const freelancer4 = await prisma.user.create({
    data: {
      email: 'yoon@example.com',
      password,
      name: '윤서아',
      role: 'FREELANCER',
      bio: '모바일 앱 개발 전문. React Native와 Flutter 경험이 풍부합니다.',
      skills: ['React Native', 'Flutter', 'Dart', 'Firebase', 'Swift'],
      activityCategory: '모바일 앱',
      experienceYears: 3,
      hourlyRate: 50000,
      portfolioUrl: 'https://seoa-app.dev',
    },
  });

  const freelancer5 = await prisma.user.create({
    data: {
      email: 'song@example.com',
      password,
      name: '송민재',
      role: 'FREELANCER',
      bio: 'AI/ML 엔지니어입니다. Python과 데이터 분석 기반 솔루션을 제공합니다.',
      skills: ['Python', 'TensorFlow', 'PyTorch', 'FastAPI', 'Pandas', 'SQL'],
      activityCategory: 'AI/ML',
      experienceYears: 6,
      hourlyRate: 70000,
    },
  });

  console.log('Users created');

  // ─── Projects ────────────────────────────────────────
  const project1 = await prisma.project.create({
    data: {
      title: 'AI 기반 고객 상담 챗봇 개발',
      description:
        '자사 쇼핑몰에 적용할 AI 챗봇을 개발합니다. GPT API를 연동하여 고객 문의에 자동 응답하고, 주문 조회/반품 접수 등의 기능을 포함해야 합니다. 관리자 대시보드에서 대화 이력 확인 및 챗봇 학습 데이터 관리 기능도 필요합니다.',
      category: 'AI/ML',
      budget: 8000000,
      deadline: new Date('2026-05-15'),
      requiredSkills: ['Python', 'React', 'OpenAI API', 'SQL'],
      status: 'OPEN',
      clientId: client1.id,
    },
  });

  const project2 = await prisma.project.create({
    data: {
      title: '반응형 기업 홈페이지 리뉴얼',
      description:
        '기존 워드프레스 기반 홈페이지를 Next.js로 전환합니다. 모바일 퍼스트 반응형 디자인, SEO 최적화, 다국어 지원(한/영)이 필요합니다. 디자인 시안은 Figma로 제공될 예정입니다.',
      category: '웹 개발',
      budget: 5000000,
      deadline: new Date('2026-04-30'),
      requiredSkills: ['Next.js', 'React', 'Tailwind CSS', 'Figma'],
      status: 'OPEN',
      clientId: client2.id,
    },
  });

  const project3 = await prisma.project.create({
    data: {
      title: '온라인 강의 플랫폼 MVP 개발',
      description:
        '강사가 강의를 등록하고 학생이 수강할 수 있는 LMS 플랫폼입니다. 영상 스트리밍, 진도 관리, 퀴즈/과제 제출, 수료증 발급 기능이 필요합니다. 결제는 토스페이먼츠를 사용합니다.',
      category: '웹 개발',
      budget: 15000000,
      deadline: new Date('2026-06-30'),
      requiredSkills: ['React', 'Node.js', 'SQL', 'AWS', 'FFmpeg'],
      status: 'OPEN',
      clientId: client3.id,
    },
  });

  const project4 = await prisma.project.create({
    data: {
      title: '헬스케어 모바일 앱 개발',
      description:
        '사용자의 운동 기록, 식단 관리, 건강 데이터 시각화를 제공하는 모바일 앱입니다. iOS/Android 크로스 플랫폼으로 개발하며 웨어러블 기기 연동도 고려해주세요.',
      category: '모바일 앱',
      budget: 12000000,
      recruitmentStartDate: new Date('2026-06-01'),
      deadline: new Date('2026-07-31'),
      requiredSkills: ['React Native', 'Node.js', 'Firebase', 'HealthKit'],
      status: 'UPCOMING',
      clientId: client1.id,
    },
  });

  const project5 = await prisma.project.create({
    data: {
      title: '소셜 미디어 대시보드 개발',
      description:
        '인스타그램, 유튜브, 블로그 등 여러 채널의 마케팅 성과를 한눈에 볼 수 있는 대시보드입니다. 각 플랫폼 API 연동, 실시간 데이터 시각화, 보고서 PDF 출력 기능이 필요합니다.',
      category: '데이터 분석',
      budget: 7000000,
      deadline: new Date('2026-05-31'),
      requiredSkills: ['React', 'Python', 'FastAPI', 'Chart.js', 'SQL'],
      status: 'OPEN',
      clientId: client2.id,
    },
  });

  const project6 = await prisma.project.create({
    data: {
      title: '브랜드 아이덴티티 디자인',
      description:
        '신규 브랜드의 로고, 컬러 팔레트, 타이포그래피, 명함, 패키지 디자인 등 전체 BI를 작업합니다. 브랜드 가이드라인 문서도 함께 납품해야 합니다.',
      category: '디자인',
      budget: 3000000,
      deadline: new Date('2026-04-15'),
      requiredSkills: ['Figma', 'Illustrator', 'Photoshop', 'Branding'],
      status: 'OPEN',
      clientId: client1.id,
    },
  });

  // 완료된 프로젝트 (계약+결제+리뷰 플로우 시연용)
  const project7 = await prisma.project.create({
    data: {
      title: '사내 ERP 시스템 API 개발',
      description:
        '기존 엑셀 기반 업무 관리를 대체할 REST API 서버를 개발합니다. 인사관리, 프로젝트 관리, 비용 처리 모듈이 포함됩니다.',
      category: '웹 개발',
      budget: 10000000,
      deadline: new Date('2026-03-31'),
      requiredSkills: ['Node.js', 'Express', 'SQL', 'Docker'],
      status: 'COMPLETED',
      clientId: client2.id,
    },
  });

  // 계약 진행 중인 마감 프로젝트
  const project8 = await prisma.project.create({
    data: {
      title: '이커머스 관리자 페이지 개발',
      description:
        '쇼핑몰 관리자 전용 대시보드를 개발합니다. 상품 등록/수정, 주문 관리, 매출 통계, 회원 관리 기능이 필요합니다.',
      category: '웹 개발',
      budget: 6000000,
      deadline: new Date('2026-05-15'),
      requiredSkills: ['React', 'TypeScript', 'Node.js', 'Prisma'],
      status: 'CLOSED',
      clientId: client3.id,
    },
  });

  console.log('Projects created');

  // ─── Applications ────────────────────────────────────
  // project1 (AI 챗봇) - 3명 지원
  const app1 = await prisma.application.create({
    data: {
      projectId: project1.id,
      freelancerId: freelancer1.id,
      coverLetter:
        'React와 Node.js 기반 웹 서비스에 OpenAI API를 연동한 경험이 있습니다. 이전에 진행한 고객 상담 자동화 프로젝트에서 GPT-4를 활용하여 응답 정확도 85% 이상을 달성한 바 있습니다.',
      expectedRate: 7500000,
      expectedDuration: '6주',
    },
  });

  await prisma.application.create({
    data: {
      projectId: project1.id,
      freelancerId: freelancer5.id,
      coverLetter:
        'AI/ML 분야 전문 엔지니어입니다. Python 기반으로 다양한 NLP 프로젝트를 수행했으며, 챗봇 개발 및 배포 경험이 풍부합니다. RAG 패턴을 적용한 고품질 챗봇을 만들어 드리겠습니다.',
      expectedRate: 8000000,
      expectedDuration: '5주',
    },
  });

  await prisma.application.create({
    data: {
      projectId: project1.id,
      freelancerId: freelancer3.id,
      coverLetter:
        '백엔드 시스템과 API 설계에 강점이 있습니다. 대화형 AI 시스템의 서버 아키텍처를 설계하고, 안정적인 서비스 운영 환경을 구축해 드리겠습니다.',
      expectedRate: 8500000,
      expectedDuration: '7주',
    },
  });

  // project2 (홈페이지 리뉴얼) - 2명 지원
  await prisma.application.create({
    data: {
      projectId: project2.id,
      freelancerId: freelancer2.id,
      coverLetter:
        'UI/UX 디자인과 Next.js 프론트엔드를 모두 작업할 수 있습니다. 반응형 웹사이트를 여러 차례 제작했으며, Lighthouse 성능 점수 95 이상을 달성한 경험이 있습니다.',
      expectedRate: 4500000,
      expectedDuration: '4주',
    },
  });

  await prisma.application.create({
    data: {
      projectId: project2.id,
      freelancerId: freelancer1.id,
      coverLetter:
        'Next.js App Router를 활용한 SSR/SSG 웹사이트 구축 경험이 풍부합니다. 다국어 처리는 next-intl을 활용하여 효율적으로 구현할 수 있습니다.',
      expectedRate: 5000000,
      expectedDuration: '5주',
    },
  });

  // project3 (LMS) - 2명 지원
  await prisma.application.create({
    data: {
      projectId: project3.id,
      freelancerId: freelancer1.id,
      coverLetter:
        'LMS와 유사한 SaaS 플랫폼을 개발한 경험이 있습니다. 영상 스트리밍에는 AWS MediaConvert + CloudFront 조합을 제안드립니다.',
      expectedRate: 14000000,
      expectedDuration: '10주',
    },
  });

  await prisma.application.create({
    data: {
      projectId: project3.id,
      freelancerId: freelancer3.id,
      coverLetter:
        '대규모 트래픽을 처리하는 백엔드 아키텍처 설계에 자신 있습니다. 영상 인코딩 파이프라인과 CDN 설정까지 포함하여 안정적인 서비스를 만들어 드리겠습니다.',
      expectedRate: 15000000,
      expectedDuration: '12주',
    },
  });

  // project4 (헬스케어 앱) - 1명 지원
  await prisma.application.create({
    data: {
      projectId: project4.id,
      freelancerId: freelancer4.id,
      coverLetter:
        'React Native로 헬스케어 앱을 개발한 경험이 있습니다. Apple HealthKit과 Google Fit API 연동 경험이 있으며, 직관적인 데이터 시각화를 구현할 수 있습니다.',
      expectedRate: 11000000,
      expectedDuration: '8주',
    },
  });

  // project5 (대시보드) - 1명 지원
  await prisma.application.create({
    data: {
      projectId: project5.id,
      freelancerId: freelancer5.id,
      coverLetter:
        'Python + FastAPI로 데이터 수집 파이프라인을 구축하고, React 기반 실시간 대시보드를 개발해본 경험이 있습니다. 소셜 미디어 API 연동도 다수 진행했습니다.',
      expectedRate: 6500000,
      expectedDuration: '6주',
    },
  });

  console.log('Applications created');

  // ─── 완료된 프로젝트 플로우 (project7) ────────────────
  const app7 = await prisma.application.create({
    data: {
      projectId: project7.id,
      freelancerId: freelancer3.id,
      coverLetter: 'ERP 시스템 API 개발 경험이 풍부합니다. Spring Boot와 Node.js 모두 가능하며, 확장 가능한 아키텍처를 설계해 드리겠습니다.',
      expectedRate: 9500000,
      expectedDuration: '8주',
      status: 'ACCEPTED',
    },
  });

  const contract7 = await prisma.contract.create({
    data: {
      projectId: project7.id,
      applicationId: app7.id,
      clientId: client2.id,
      freelancerId: freelancer3.id,
      amount: 9500000,
      startDate: new Date('2026-01-15'),
      endDate: new Date('2026-03-15'),
      clientSigned: true,
      freelancerSigned: true,
      status: 'COMPLETED',
      completedAt: new Date('2026-03-15'),
    },
  });

  // Payments are per milestone. Minimal plan for now; the full demo plan arrives in Phase 4.
  const milestone7 = await prisma.milestone.create({
    data: {
      contractId: contract7.id,
      sequence: 1,
      title: '전체 작업',
      amount: 9500000,
      dueDate: new Date('2026-03-15T14:59:59.999Z'),
      status: 'APPROVED',
      fundedAt: new Date('2026-02-15'),
      approvedAt: new Date('2026-03-15'),
      approvalType: 'MANUAL',
    },
  });

  await prisma.payment.create({
    data: {
      contractId: contract7.id,
      milestoneId: milestone7.id,
      clientId: client2.id,
      amount: 9500000,
      status: 'COMPLETED',
      paymentKey: 'tgen_20260215_seed_001',
      orderId: uuidv4(),
    },
  });

  // 의뢰인 → 프리랜서 리뷰
  await prisma.review.create({
    data: {
      contractId: contract7.id,
      reviewerId: client2.id,
      revieweeId: freelancer3.id,
      rating: 5,
      content: '기술력이 뛰어나고 커뮤니케이션도 매우 원활했습니다. 일정 내에 완벽하게 납품해 주셨습니다. 다음에도 꼭 함께 일하고 싶습니다.',
      tags: ['기술력', '소통', '책임감', '일정 준수'],
    },
  });

  // 프리랜서 → 의뢰인 리뷰
  await prisma.review.create({
    data: {
      contractId: contract7.id,
      reviewerId: freelancer3.id,
      revieweeId: client2.id,
      rating: 4,
      content: '요구사항이 명확하고 피드백도 빠르게 주셔서 작업하기 좋았습니다. 중간에 소소한 스코프 변경이 있었지만 전반적으로 만족스러운 협업이었습니다.',
      tags: ['명확한 요구사항', '신속한 피드백'],
    },
  });

  console.log('Contract, payment, reviews for completed project created');

  // ─── 진행중 프로젝트 플로우 (project8) ────────────────
  const app8 = await prisma.application.create({
    data: {
      projectId: project8.id,
      freelancerId: freelancer1.id,
      coverLetter: 'React + TypeScript 기반 관리자 페이지를 다수 개발한 경험이 있습니다. Prisma와 함께 사용하면 빠르게 고품질 결과물을 만들 수 있습니다.',
      expectedRate: 5500000,
      expectedDuration: '6주',
      status: 'ACCEPTED',
    },
  });

  // 거절된 지원자
  await prisma.application.create({
    data: {
      projectId: project8.id,
      freelancerId: freelancer2.id,
      coverLetter: '프론트엔드 전문으로 관리자 대시보드 개발 경험이 있습니다.',
      expectedRate: 5000000,
      expectedDuration: '5주',
      status: 'REJECTED',
    },
  });

  const contract8 = await prisma.contract.create({
    data: {
      projectId: project8.id,
      applicationId: app8.id,
      clientId: client3.id,
      freelancerId: freelancer1.id,
      amount: 5500000,
      startDate: new Date('2026-03-01'),
      endDate: new Date('2026-05-15'),
      clientSigned: true,
      freelancerSigned: true,
      status: 'ACTIVE',
    },
  });

  const milestone8 = await prisma.milestone.create({
    data: {
      contractId: contract8.id,
      sequence: 1,
      title: '전체 작업',
      amount: 5500000,
      dueDate: new Date('2026-05-15T14:59:59.999Z'),
      status: 'FUNDED',
      fundedAt: new Date('2026-03-01'),
    },
  });

  await prisma.payment.create({
    data: {
      contractId: contract8.id,
      milestoneId: milestone8.id,
      clientId: client3.id,
      amount: 5500000,
      status: 'COMPLETED',
      paymentKey: 'tgen_20260301_seed_002',
      orderId: uuidv4(),
    },
  });

  console.log('Contract and payment for in-progress project created');

  // ─── AI 분석 결과 (project1) ─────────────────────────
  await prisma.pricingAnalysis.create({
    data: {
      projectId: project1.id,
      features: [
        {
          name: 'GPT API 연동 챗봇 엔진',
          description: 'OpenAI API 기반 대화 처리 엔진 개발',
          estimatedCost: 2500000,
          rationale: 'GPT API 연동 및 프롬프트 엔지니어링, 컨텍스트 관리 포함',
          duration: '2주',
        },
        {
          name: '주문 조회/반품 접수 기능',
          description: '기존 쇼핑몰 DB와 연동하여 주문 조회, 반품 접수 처리',
          estimatedCost: 1500000,
          rationale: '외부 시스템 API 연동 및 비즈니스 로직 구현',
          duration: '1주',
        },
        {
          name: '고객 채팅 UI',
          description: '실시간 채팅 인터페이스 (웹 위젯 형태)',
          estimatedCost: 1200000,
          rationale: 'WebSocket 기반 실시간 통신 및 반응형 UI 구현',
          duration: '1주',
        },
        {
          name: '관리자 대시보드',
          description: '대화 이력 조회, 통계, 챗봇 학습 데이터 관리',
          estimatedCost: 2000000,
          rationale: '데이터 시각화 및 관리 기능 포함 어드민 페이지',
          duration: '1.5주',
        },
        {
          name: '배포 및 인프라 설정',
          description: 'AWS/GCP 배포, CI/CD 파이프라인 구성',
          estimatedCost: 800000,
          rationale: '컨테이너화 및 자동 배포 환경 구성',
          duration: '0.5주',
        },
      ],
      totalAmount: 8000000,
      summary:
        '전체 프로젝트는 약 6주 소요 예상이며, GPT API 연동 챗봇 엔진이 가장 핵심적인 작업입니다. 예산 800만원은 시장 평균 대비 적정한 수준입니다.',
      marketReference:
        '유사 AI 챗봇 프로젝트의 시장 평균 단가는 700만원~1,200만원 범위입니다. 관리자 대시보드 포함 시 상위 범위에 해당합니다.',
    },
  });

  console.log('Pricing analysis created');
  console.log('Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
