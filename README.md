# WorkBridge - 프리랜서 매칭 플랫폼

의뢰인과 프리랜서를 연결하는 중개 플랫폼입니다. 프로젝트 탐색과 지원, AI 단가 분석, 계약 체결부터 마일스톤 단위의 결제·산출물 제출·검수(반려와 7일 뒤 자동 승인), 수수료를 뗀 주간 정산과 지급 계좌, 계약별 대화방(첨부, 읽음 표시), 포트폴리오·경력과 스킬 기반 추천, 알림 종류별 인앱·이메일 설정까지 외주 프로세스 전체를 다룹니다. 자동 승인·정산·이메일은 Postgres 기반 작업 큐가 처리하고, 이메일은 아직 로그로만 남깁니다.

## 구성

| 패키지 | 스택 |
| --- | --- |
| `workbridge-server` | Node 22, Express, TypeScript, Prisma, PostgreSQL(Supabase), Supabase Storage, OpenAI(`gpt-4o-mini`), 토스페이먼츠, Sentry(선택, `SENTRY_DSN`) |
| `workbridge-client` | Next.js 14 App Router(JSX), Tailwind CSS, Zustand, Axios |

두 패키지는 따로 설치하고 따로 배포합니다(Vercel). 브라우저는 같은 출처의 `/api/*`를 부르고 Next 라우트 핸들러가 백엔드로 전달합니다.

## 로컬 실행

로컬 Postgres가 필요합니다.

```bash
# 서버 — http://localhost:4000
cd workbridge-server
npm install
cp .env.example .env          # DATABASE_URL·DIRECT_URL을 로컬 DB로 (docs/ENV.md)
createdb workbridge
npx prisma migrate deploy
npm run db:seed               # 선택: 모든 테이블을 비우고 시드를 넣는다
npm run dev

# 클라이언트 — http://localhost:3000
cd ../workbridge-client
npm install
cp .env.example .env.local    # NEXT_PUBLIC_API_URL=http://localhost:4000
npm run dev
```

시드 계정은 [docs/SEED_DATA.md](docs/SEED_DATA.md)에 있습니다(비밀번호는 모두 `password123`, 예: 의뢰인 `kim@example.com`, 프리랜서 `park@example.com`). 토스 결제창 없이 결제를 끝내려면 서버 `ALLOW_PAYMENT_BYPASS`와 클라이언트 `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS`를 `true`로 둡니다(로컬 전용).

## 테스트

```bash
# 서버 동작 테스트 (vitest + supertest, 실제 Postgres)
cd workbridge-server
bash scripts/test-db.sh       # workbridge_test 생성·마이그레이션
npm run typecheck
npm test

# E2E (Playwright) — 리포지토리 루트에서. 시드한 workbridge_e2e DB, 서버 :4002, 클라이언트 :3002
cd ..
bash scripts/e2e.sh

# 클라이언트
cd workbridge-client
npm run lint && npm run build
```

- 서버 테스트는 [docs/BEHAVIOR.md](docs/BEHAVIOR.md)를 기준으로 단언하고, 알려진 불일치(D)는 실패가 예상되는 테스트로 고정합니다. 테스트마다 모든 테이블을 비우므로 이름에 `test`가 들어간 DB에서만 돕니다.
- E2E는 로그인, 프로젝트 등록, 지원, 수락·서명, 마일스톤 결제·제출·승인을 브라우저로 확인합니다([workbridge-client/e2e/README.md](workbridge-client/e2e/README.md)).
- CI: `.github/workflows/ci.yml`(서버 typecheck·`prisma validate`·테스트, 클라이언트 lint·빌드)과 `e2e.yml`(Playwright)이 PR과 `main` 푸시마다 Postgres 서비스 컨테이너로 돕니다. PR마다 Claude가 `REVIEW.md` 기준으로 AI 리뷰를 남기고(`claude-code-review.yml`), 이슈·PR에서 `@claude`를 멘션해 작업을 맡길 수 있습니다(`claude.yml`).

## 배포

백엔드와 프론트엔드를 각각 Vercel에 배포합니다. 환경(로컬, CI, 프리뷰, 운영), 마이그레이션, Sentry, 운영 환경의 한계(작업 큐 스케줄러 미연결 등)와 프리뷰·운영 주소는 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)에 있습니다.

## 문서

| 문서 | 설명 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 구조: 레이어, 요청 흐름, 작업 큐, 클라이언트, 환경 |
| [docs/BEHAVIOR.md](docs/BEHAVIOR.md) | API 동작 명세 (영문, 테스트의 기준). 알려진 불일치(D)와 미결 질문(Q) |
| [docs/API.md](docs/API.md) | API 엔드포인트 목록 |
| [docs/DATABASE.md](docs/DATABASE.md) | 데이터베이스 모델과 불변식 |
| [docs/ENV.md](docs/ENV.md) | 환경변수와 외부 서비스 설정 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 환경, Vercel 배포, 운영 환경의 한계 |
| [docs/SEED_DATA.md](docs/SEED_DATA.md) | 시드 데이터와 둘러보기 시나리오 |
| [docs/HARNESS.md](docs/HARNESS.md) | Claude Code 작업 하네스(지침, 권한, 훅, 스킬) |
| [REVIEW.md](REVIEW.md) | 코드 리뷰 기준 |

## 기여

이슈는 템플릿으로 엽니다: 버그, 명세 불일치(BEHAVIOR.md와 구현이 다른 것), 기능 제안. 명세 불일치는 BEHAVIOR.md의 D·Q 목록에 이미 있는지 먼저 확인합니다. PR은 `.github/PULL_REQUEST_TEMPLATE.md`를 따릅니다.
