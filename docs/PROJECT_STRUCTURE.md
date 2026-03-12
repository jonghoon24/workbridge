# 프로젝트 구조

```
workbridge/
├── docs/
│   ├── PRD.md
│   ├── TECH_STACK.md
│   ├── PROJECT_STRUCTURE.md
│   ├── API.md
│   ├── DATABASE.md
│   ├── ENV.md
│   ├── DEPLOYMENT.md
│   └── SEED_DATA.md
├── workbridge-server/
│   ├── package.json
│   ├── vercel.json
│   ├── .env.example
│   ├── prisma/schema.prisma
│   └── src/
│       ├── index.js                    # Express 앱 (Vercel serverless export)
│       ├── lib/
│       │   ├── prisma.js              # PrismaClient 싱글톤
│       │   ├── openai.js             # OpenAI 클라이언트
│       │   ├── jwt.js                # 토큰 생성 유틸
│       │   └── errors.js            # AppError 클래스
│       ├── middlewares/
│       │   ├── auth.js               # authenticate, requireRole
│       │   ├── errorHandler.js       # 글로벌 에러 핸들러
│       │   └── upload.js            # Multer + Supabase Storage 업로드
│       ├── routes/
│       │   ├── auth.routes.js
│       │   ├── users.routes.js
│       │   ├── projects.routes.js
│       │   ├── applications.routes.js
│       │   ├── contracts.routes.js
│       │   ├── payments.routes.js
│       │   └── reviews.routes.js
│       └── controllers/
│           ├── auth.controller.js     # 회원가입, 로그인, Google OAuth
│           ├── users.controller.js    # 프로필 CRUD
│           ├── projects.controller.js # 프로젝트 CRUD + AI 분석
│           ├── applications.controller.js # 지원 + 수락(트랜잭션)
│           ├── contracts.controller.js    # 계약 조회 + 서명
│           ├── payments.controller.js     # 결제 생성 + 토스 검증
│           └── reviews.controller.js      # 리뷰 작성 + 조회
└── workbridge-client/
    ├── package.json
    ├── next.config.js
    ├── tailwind.config.js
    ├── .env.example
    └── src/
        ├── middleware.js              # 라우트 보호
        ├── lib/api.js                # Axios + 토큰 갱신 인터셉터
        ├── store/
        │   ├── authStore.js          # Zustand 인증 상태
        │   └── projectStore.js       # 필터/페이지네이션 상태
        ├── components/
        │   ├── ui/                   # Button, Input, Card, Badge, Modal
        │   ├── layout/              # Header, Footer
        │   ├── projects/            # ProjectCard, ProjectForm, ProjectFilters
        │   └── auth/                # LoginForm, SignupForm
        └── app/
            ├── layout.js
            ├── page.jsx              # 랜딩 페이지
            ├── login/page.jsx
            ├── signup/page.jsx
            ├── auth/callback/page.jsx
            ├── projects/
            │   ├── page.jsx          # 프로젝트 목록 (검색/필터/페이지네이션)
            │   ├── new/page.jsx
            │   └── [id]/
            │       ├── page.jsx      # 프로젝트 상세 + 지원 모달
            │       ├── edit/page.jsx
            │       ├── applications/page.jsx
            │       └── analysis/page.jsx
            ├── profile/page.jsx
            ├── users/[id]/page.jsx
            ├── my/
            │   ├── applications/page.jsx
            │   └── payments/page.jsx
            ├── contracts/[id]/page.jsx
            └── payments/
                ├── [id]/page.jsx     # 토스 결제 위젯
                └── result/page.jsx
```
