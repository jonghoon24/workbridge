# WorkBridge - 프리랜서 매칭 플랫폼

의뢰인과 프리랜서를 연결하는 중개 플랫폼입니다. 프로젝트 탐색부터 계약 체결, AI 단가 분석, 대금 결제까지 전체 외주 프로세스를 관리합니다.

## 기술 스택

| 분류 | 기술 |
| --- | --- |
| Frontend | Next.js 14 (App Router), Tailwind CSS, Zustand |
| Backend | Express 4.x, Prisma 5.x |
| Database | PostgreSQL (Supabase) |
| Auth | JWT (Access 15m / Refresh 7d httpOnly cookie), Google OAuth |
| File Upload | Multer memoryStorage → Supabase Storage |
| AI | OpenAI API (gpt-4o-mini), JSON mode |
| Payment | 토스페이먼츠 sandbox |
| Deploy | Vercel (FE + BE) |

## 프로젝트 구조

```
workbridge/
├── docs/PRD.md
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

## 실행 방법

### 1. 서버

```bash
cd workbridge-server
npm install
cp .env.example .env  # 아래 환경변수 참고하여 실제 값 입력
npx prisma migrate dev --name init
npm run dev
```

서버가 `http://localhost:4000`에서 실행됩니다.

### 2. 클라이언트

```bash
cd workbridge-client
npm install
cp .env.example .env.local  # 아래 환경변수 참고하여 실제 값 입력
npm run dev
```

클라이언트가 `http://localhost:3000`에서 실행됩니다.

### 3. 시드 데이터

```bash
cd workbridge-server
npx prisma db seed
# 또는
npm run db:seed
```

시드 실행 시 아래 데이터가 생성됩니다. **모든 계정의 비밀번호는 `password123`입니다.**

#### 사용자 (8명)

| 이메일 | 이름 | 역할 | 비고 |
| --- | --- | --- | --- |
| kim@example.com | 김서준 | 의뢰인 | 넥스트랩 (IT/소프트웨어) |
| lee@example.com | 이수현 | 의뢰인 | 브릿지마케팅 (마케팅/광고) |
| choi@example.com | 최민호 | 의뢰인 | 에듀플러스 (교육/에듀테크) |
| park@example.com | 박지윤 | 프리랜서 | 풀스택 5년, React/Node.js |
| jung@example.com | 정하은 | 프리랜서 | 디자인엔지니어 4년, Figma/React |
| han@example.com | 한도윤 | 프리랜서 | 백엔드 7년, Java/Spring/Docker |
| yoon@example.com | 윤서아 | 프리랜서 | 모바일 3년, React Native/Flutter |
| song@example.com | 송민재 | 프리랜서 | AI/ML 6년, Python/TensorFlow |

#### 프로젝트 (8개)

| 프로젝트 | 의뢰인 | 상태 | 예산 |
| --- | --- | --- | --- |
| AI 기반 고객 상담 챗봇 개발 | 김서준 | OPEN | 800만원 |
| 반응형 기업 홈페이지 리뉴얼 | 이수현 | OPEN | 500만원 |
| 온라인 강의 플랫폼 MVP 개발 | 최민호 | OPEN | 1,500만원 |
| 헬스케어 모바일 앱 개발 | 김서준 | OPEN | 1,200만원 |
| 소셜 미디어 대시보드 개발 | 이수현 | OPEN | 700만원 |
| 브랜드 아이덴티티 디자인 | 김서준 | OPEN | 300만원 |
| 사내 ERP 시스템 API 개발 | 이수현 | COMPLETED | 1,000만원 |
| 이커머스 관리자 페이지 개발 | 최민호 | IN_PROGRESS | 600만원 |

#### 기타 데이터

- **지원 11건** — OPEN 프로젝트에 프리랜서들이 지원한 상태
- **계약 2건** — 완료 프로젝트(한도윤), 진행중 프로젝트(박지윤)
- **결제 2건** — 양쪽 모두 COMPLETED 상태
- **리뷰 2건** — 완료 프로젝트에서 의뢰인↔프리랜서 상호 평가
- **AI 분석 1건** — AI 챗봇 프로젝트 단가 분석 결과

## 환경변수

### 서버 (.env)

| 변수 | 설명 |
| --- | --- |
| `PORT` | 서버 포트 (기본 4000) |
| `DATABASE_URL` | PostgreSQL 연결 문자열 (Supabase Transaction mode 포트 6543 권장) |
| `JWT_ACCESS_SECRET` | Access Token 서명 시크릿 |
| `JWT_REFRESH_SECRET` | Refresh Token 서명 시크릿 |
| `JWT_ACCESS_EXPIRES_IN` | Access Token 만료 시간 (기본 15m) |
| `JWT_REFRESH_EXPIRES_IN` | Refresh Token 만료 시간 (기본 7d) |
| `GOOGLE_CLIENT_ID` | Google OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 클라이언트 시크릿 |
| `GOOGLE_CALLBACK_URL` | Google OAuth 콜백 URL |
| `OPENAI_API_KEY` | OpenAI API 키 |
| `TOSS_SECRET_KEY` | 토스페이먼츠 시크릿 키 (test_sk_...) |
| `CLIENT_URL` | 프론트엔드 URL (기본 <http://localhost:3000>) |
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_SECRET_KEY` | Supabase Secret Key (sb_secret_...) |

### 클라이언트 (.env.local)

| 변수 | 설명 |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | 백엔드 API URL (기본 <http://localhost:4000>) |
| `NEXT_PUBLIC_TOSS_CLIENT_KEY` | 토스페이먼츠 클라이언트 키 (test_ck_...) |

## 외부 서비스 설정

### Supabase

1. 프로젝트 생성 후 Settings > API에서 URL과 Secret Key 복사
2. Storage에서 `workbridge` 버킷 생성 (Public으로 설정)
3. DATABASE_URL은 Settings > Database > Connection String에서 Transaction mode (포트 6543) 사용

### Google OAuth

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트 생성
2. APIs & Services > Credentials에서 OAuth 2.0 클라이언트 ID 생성
3. 승인된 리디렉션 URI에 `http://localhost:4000/api/auth/google/callback` 추가

### 토스페이먼츠

1. [토스페이먼츠 개발자센터](https://developers.tosspayments.com/)에서 테스트 키 발급
2. 클라이언트 키 (`test_ck_...`)와 시크릿 키 (`test_sk_...`) 확인

### OpenAI

1. [OpenAI Platform](https://platform.openai.com/)에서 API 키 발급

## API 엔드포인트

### 인증

| Method | Endpoint | 설명 |
| --- | --- | --- |
| POST | `/api/auth/signup` | 회원가입 |
| POST | `/api/auth/login` | 로그인 |
| POST | `/api/auth/logout` | 로그아웃 |
| POST | `/api/auth/refresh` | 토큰 갱신 |
| GET | `/api/auth/google` | Google OAuth 시작 |
| GET | `/api/auth/google/callback` | Google OAuth 콜백 |

### 사용자

| Method | Endpoint | 설명 |
| --- | --- | --- |
| GET | `/api/users/me` | 내 프로필 조회 |
| PATCH | `/api/users/me` | 내 프로필 수정 (multipart) |
| GET | `/api/users/me/applications` | 내 지원 목록 (프리랜서) |
| GET | `/api/users/me/projects` | 내 프로젝트 목록 (의뢰인) |
| GET | `/api/users/:id` | 공개 프로필 조회 |

### 프로젝트

| Method | Endpoint | 설명 |
| --- | --- | --- |
| GET | `/api/projects` | 프로젝트 목록 (검색/필터/정렬/페이징) |
| POST | `/api/projects` | 프로젝트 등록 (의뢰인) |
| GET | `/api/projects/:id` | 프로젝트 상세 |
| PATCH | `/api/projects/:id` | 프로젝트 수정 |
| DELETE | `/api/projects/:id` | 프로젝트 삭제 (소프트 딜리트) |
| PATCH | `/api/projects/:id/status` | 상태 변경 |
| POST | `/api/projects/:id/analyze` | AI 단가 분석 |

### 지원

| Method | Endpoint | 설명 |
| --- | --- | --- |
| POST | `/api/projects/:id/applications` | 프로젝트 지원 (프리랜서) |
| GET | `/api/projects/:id/applications` | 지원자 목록 (의뢰인) |
| PATCH | `/api/projects/:projectId/applications/:appId` | 지원 수락/거절 |

### 계약 & 결제

| Method | Endpoint | 설명 |
| --- | --- | --- |
| GET | `/api/contracts/:id` | 계약서 조회 |
| POST | `/api/contracts/:id/sign` | 계약서 서명 |
| POST | `/api/payments` | 결제 생성 |
| POST | `/api/payments/confirm` | 결제 승인 (토스 검증) |
| GET | `/api/payments` | 결제 내역 |

### 리뷰

| Method | Endpoint | 설명 |
| --- | --- | --- |
| POST | `/api/reviews` | 리뷰 작성 |
| GET | `/api/reviews/users/:id` | 사용자 리뷰 조회 |

## 데이터베이스 모델

- **User** — 사용자 (의뢰인/프리랜서)
- **Project** — 프로젝트 (OPEN → IN_PROGRESS → COMPLETED)
- **Application** — 지원서 (PENDING → ACCEPTED/REJECTED)
- **Contract** — 계약서 (PENDING → ACTIVE → COMPLETED)
- **Payment** — 결제 (PENDING → COMPLETED/FAILED/REFUNDED)
- **Review** — 리뷰 (별점 1-5, 태그)
- **PricingAnalysis** — AI 단가 분석 결과

## 배포 (Vercel)

### 백엔드

- `vercel.json`이 이미 설정되어 있음
- Vercel 대시보드에서 환경변수 설정
- Build Command: `npx prisma generate`

### 프론트엔드

- GitHub 연동 시 Next.js 자동 감지
- `NEXT_PUBLIC_API_URL`을 백엔드 배포 URL로 설정

### 배포 후 업데이트

- 백엔드 `CLIENT_URL` → 프론트엔드 Vercel URL
- 백엔드 `GOOGLE_CALLBACK_URL` → 백엔드 Vercel URL + `/api/auth/google/callback`
- 프론트엔드 `NEXT_PUBLIC_API_URL` → 백엔드 Vercel URL
