---
paths:
  - "workbridge-server/vercel.json"
  - "workbridge-server/src/index.ts"
  - "workbridge-server/src/env.ts"
  - "workbridge-server/package.json"
  - "workbridge-client/next.config.js"
  - "workbridge-client/package.json"
  - ".github/workflows/**"
  - "docs/DEPLOYMENT.md"
  - "docs/ENV.md"
  - "**/.env.example"
---

# 배포 (Vercel)

- `workbridge-server/vercel.json`은 진입점을 **두 번** 하드코딩한다(`builds[].src`와 `routes[].dest`
  = `src/index.ts`). 진입점 이름을 바꾸면 둘 다 고친다.
- `@vercel/node`가 TypeScript를 바로 트랜스파일한다: **빌드 단계도 `dist/`도 없다.** Build Command
  (`npx prisma generate`)는 리포지토리가 아니라 Vercel 대시보드에 있다 — 그걸 고쳐야 하는 변경은 피한다.
- `index.ts`는 `export default app`을 유지한다. `app.listen()`과 개발 워커는 `NODE_ENV`가
  `production`도 `test`도 아닐 때만 시작한다.
- 환경: Vercel **Preview**와 **Production**은 환경변수도 따로, **Supabase 프로젝트도 따로**(DB가 다르다).
  어느 쪽 접속 문자열도 커맨드에 넣지 않는다(Bash에서 `supabase.co`/`supabase.com`은 거부된다).
  로컬 작업은 `localhost` Postgres를 쓴다.
- 원격 DB에 마이그레이션을 적용하는 것은 CI뿐이다: `main`에 머지되면 워크플로 작업이 preview와
  production에 `prisma migrate deploy`를 돌리는 것이 정해진 절차다(아직 워크플로로 만들지 않았다 —
  `docs/DEPLOYMENT.md`). 손으로 돌리지 않는다.
- **운영에는 작업 워커가 없다**(상주 프로세스 없음): `POST /api/internal/jobs/run`
  (`INTERNAL_JOB_TOKEN`)이나 `npm run jobs:run`뿐이다. `docs/DEPLOYMENT.md` "운영 환경의 한계" 참고.
- `ALLOW_PAYMENT_BYPASS`(서버)와 `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS`(클라이언트)는 운영에서 반드시
  `false`. `MAIL_PROVIDER=log`는 주소와 본문 전체를 로그에 쓴다 — 개발 전용.
- 새 환경변수: `src/env.ts`(지연 getter), `.env.example`, `docs/ENV.md`에 함께 추가한다.
- Google OAuth `GOOGLE_CALLBACK_URL`은 **프론트엔드**(`/api/auth/google/callback`)를 가리킨다.
