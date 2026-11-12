---
paths:
  - "workbridge-server/vercel.json"
  - "workbridge-server/src/index.ts"
  - "workbridge-server/src/env.ts"
  - "workbridge-server/package.json"
  - "workbridge-client/vercel.json"
  - "workbridge-client/next.config.js"
  - "workbridge-client/package.json"
  - ".github/workflows/**"
  - "**/.env.example"
---

# 배포 (Vercel)

- `workbridge-server/vercel.json`은 진입점 `src/index.ts`를 `builds[].src`와 `routes[].dest` **두 곳**에 적는다.
  진입점 이름을 바꾸면 둘 다 고친다. `index.ts`는 `export default app`을 유지한다.
- 두 `vercel.json`의 `regions: ["icn1"]`(서울)을 바꾸지 않는다. DB가 서울에 있어서, 다른 리전이면 쿼리가 많은
  트랜잭션이 5초 한도를 넘겨 프로덕션에서만 500이 난다(`docs/DEPLOYMENT.md` "백엔드").
- 서버의 `package.json`에서 `postinstall: prisma generate`를 지우지 않는다. 서버에는 빌드 단계가 없어서 Prisma
  클라이언트를 만드는 곳이 이것뿐이다(`docs/DEPLOYMENT.md` "백엔드").
- `workbridge-client/vercel.json`에는 `builds`나 `routes`를 넣지 않는다. 넣으면 Vercel이 Next.js 프레임워크 자동
  감지를 끈다.
- 클라이언트 프리뷰가 부를 서버 주소는 `relatedProjects`로 찾는다. 브랜치 URL을 직접 조립하지 않는다. Vercel이 긴
  브랜치 이름을 자르고 프로젝트마다 다른 해시를 붙이기 때문이다(`src/lib/apiUrl.js` 머리 주석).
- 원격 DB 마이그레이션은 `migrate.yml`만 적용한다. 워크플로를 고칠 때 preview → production 순서와
  `concurrency: migrate`를 유지한다.
- 결제 우회 플래그 `ALLOW_PAYMENT_BYPASS`(서버)와 `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS`(클라이언트)는 프리뷰·프로덕션과 두
  `.env.example`에서 `false`로 둔다. 켜면 실제 결제 없이 마일스톤이 결제 완료가 된다. 켜는 곳은 로컬 `.env`와
  `scripts/e2e.sh`뿐이다(`docs/DEPLOYMENT.md` "프로덕션 환경의 한계").
- `MAIL_PROVIDER=log`는 받는 주소와 본문 전체를 로그에 쓰므로 개발 전용이다. 프로덕션에서는 `JOB_EMAIL_ENABLED`를 켜지
  않는다(`docs/DEPLOYMENT.md` "프로덕션 환경의 한계").
- 새 환경변수는 해당 패키지의 `.env.example`에 뜻과 기본값을 주석으로 달아 추가한다. 서버 변수는
  `workbridge-server/src/env.ts`에 지연 getter도 만든다. CI(`scripts/check-env-example.mjs`)가 코드가 읽는 변수와
  두 `.env.example`을 양방향으로 대조한다. 값을 넣을 곳은 `docs/ENV.md`에 있다.
