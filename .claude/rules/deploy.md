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
  - "docs/DEPLOYMENT.md"
  - "docs/ENV.md"
  - "**/.env.example"
---

# 배포 (Vercel)

- `workbridge-server/vercel.json`은 진입점을 **두 번** 하드코딩한다(`builds[].src`와 `routes[].dest`
  = `src/index.ts`). 진입점 이름을 바꾸면 둘 다 고친다. `index.ts`는 `export default app`을 유지한다.
- 두 `vercel.json`의 `regions: ["icn1"]`은 함수를 DB와 같은 서울 리전에 둔다. 지우거나 바꾸지 않는다: 서버는 쿼리가 많은
  트랜잭션이 인터랙티브 트랜잭션 한도(5초)를 넘겨 운영에서만 500이 나고, 클라이언트 프록시는 API 호출마다 지연이 붙는다
  (`docs/DEPLOYMENT.md` "백엔드").
- 서버는 빌드 단계도 `dist/`도 없다. Prisma 클라이언트는 `package.json`의 `postinstall: prisma generate`만 만든다
  (대시보드의 Build Command는 `vercel.json`에 `builds`가 있어서 무시된다) — `postinstall`을 지우지 않는다.
- `workbridge-client/vercel.json`에는 `builds`·`routes`를 넣지 않는다. Next.js 프레임워크 자동 감지가 꺼진다.
  프리뷰의 서버 주소는 `relatedProjects`로 찾는다 — 브랜치 URL을 직접 조립하지 않는다(해시가 프로젝트마다 다르다).
- 원격 DB 마이그레이션은 `migrate.yml`만 적용한다. 워크플로를 고칠 때 preview → production 순서와
  `concurrency: migrate`를 유지한다.
- `ALLOW_PAYMENT_BYPASS`(서버)와 `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS`(클라이언트)는 운영에서 `false`다.
  `MAIL_PROVIDER=log`는 주소와 본문 전체를 로그에 쓰므로 개발 전용이다. 예시 파일·문서·워크플로에서 이 기본을 뒤집지 않는다.
- 새 환경변수: `src/env.ts`(지연 getter), `.env.example`, `docs/ENV.md`에 함께 추가한다.
