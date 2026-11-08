# 배포 (Vercel)

## 환경

| 환경 | 언제 | 앱 | DB |
| --- | --- | --- | --- |
| 로컬 | 개발 | `npm run dev` (서버 :4000, 클라이언트 :3000) | 로컬 Postgres. 테스트는 이름에 `test`가 들어간 별도 DB(`scripts/test-db.sh`), E2E는 `workbridge_e2e` |
| CI | PR과 `main` 푸시 | GitHub Actions(`ci.yml`, `e2e.yml`) | 워크플로마다 띄우는 Postgres 서비스 컨테이너 |
| 프리뷰 | PR마다 | Vercel Preview 배포 | Supabase 프리뷰 프로젝트 |
| 운영 | `main` 머지 | Vercel Production 배포 | Supabase 운영 프로젝트 |

프리뷰와 운영은 서로 다른 Supabase 프로젝트를 쓰므로 환경변수([ENV.md](ENV.md))도 Vercel의 Preview·Production 환경에 따로 넣는다. 마이그레이션은 `.github/workflows/migrate.yml`이 적용한다. `main`에 푸시된 커밋이 `workbridge-server/prisma/migrations/**`를 바꾸면(또는 Actions에서 수동 `workflow_dispatch`) 프리뷰 DB → 운영 DB 순서로 `prisma migrate deploy`를 돌린다. 운영 작업은 프리뷰 작업이 성공해야 시작한다. 시크릿 `PREVIEW_DIRECT_URL`·`PROD_DIRECT_URL`은 pgbouncer를 거치지 않는 Session mode(5432) 연결이고, `concurrency: migrate`로 두 실행이 겹치지 않는다. 원격 DB에 마이그레이션을 적용하는 경로는 이것뿐이다. 그래서 이미 커밋된 마이그레이션은 고치지 않고 새 마이그레이션을 추가한다. 주의할 점 둘: 같은 `main` 푸시에서 Vercel 운영 배포와 이 워크플로가 따로 돌고 순서를 맞추는 장치가 없어서 새 코드가 마이그레이션 전의 DB를 잠깐 상대할 수 있다(그래서 마이그레이션은 이전 코드와 새 코드 모두에 안전해야 한다). 또 스키마를 바꾸는 PR의 서버 프리뷰는 머지 전까지 마이그레이션되지 않은 프리뷰 DB를 상대한다.

### Vercel 프로젝트

| 프로젝트 | 운영 주소 |
| --- | --- |
| 서버 | https://workbridge-server-tau.vercel.app |
| 클라이언트 | https://workbridge-client-alpha.vercel.app |

둘 다 Vercel 팀 `jonghoon24s-projects`에 있고 Preview·Production 환경변수는 넣어 두었다. Git 연결은 Vercel GitHub 앱을 설치한 뒤에 된다(아직 연결 전). 연결하면 PR마다 두 프로젝트가 프리뷰 배포되고 `main` 머지는 운영 배포가 된다.

### 시드 리셋 — `seed.yml`

프리뷰나 운영 DB를 시드 데이터([SEED_DATA.md](SEED_DATA.md))로 되돌리는 수동 실행 전용 워크플로다. 입력 `environment`(`preview`|`production`)와 `confirm`(`seed`를 넣어야 돈다)을 받고, 마이그레이션을 먼저 적용한 뒤 `npm run db:seed`를 돌린다. **시드는 모든 테이블을 비운다.** `migrate.yml`과 같은 `concurrency: migrate` 그룹이다.

```bash
gh workflow run seed.yml -f environment=preview -f confirm=seed
```

## 백엔드

- `vercel.json`이 이미 설정되어 있음(`src/index.ts`를 `@vercel/node`가 서버리스 함수로 직접 트랜스파일한다. 빌드 단계와 `dist/`는 없다)
- 함수 리전은 `vercel.json`의 `regions: ["icn1"]`(서울)이다. DB(Supabase)가 ap-northeast-2에 있어서 함수가 다른 리전(기본값 iad1)에서 돌면 쿼리마다 왕복 지연이 붙고, 지원 수락처럼 쿼리가 많은 트랜잭션이 Prisma의 인터랙티브 트랜잭션 기본 한도(5초)를 넘겨 500(`Transaction not found`)이 난다. DB 리전을 옮기면 이 값도 같이 옮긴다
- Vercel 대시보드에서 환경변수 설정([ENV.md](ENV.md))
- Prisma 클라이언트는 `package.json`의 `postinstall: prisma generate`가 설치 단계에서 만든다. 대시보드의 Build Command에도 `npx prisma generate`가 있지만 `vercel.json`에 `builds`가 있으면 대시보드 빌드 설정은 무시되므로 실제로 동작하는 것은 `postinstall`이다
- 마이그레이션은 손으로 적용하지 않는다. 위 `migrate.yml`이 `prisma migrate deploy`를 돌리며, 이때 `DIRECT_URL`은 pgbouncer를 거치지 않는 직접 연결(Supabase Session mode 5432)이어야 한다
- 운영(`NODE_ENV=production`)에서는 `app.listen()`도 작업 큐 워커도 시작하지 않는다

## 프론트엔드

- GitHub 연동 시 Next.js 자동 감지
- `NEXT_PUBLIC_API_URL`을 백엔드 배포 URL로 설정
- 브라우저는 같은 출처의 `/api/*`를 부르고, Next 라우트 핸들러(`app/api/[...path]`, `app/api/auth/*`)가 백엔드로 전달한다
- 백엔드 주소는 서버 쪽(라우트 핸들러와 SSR)에서만 `src/lib/apiUrl.js`의 `getApiUrl()`이 정한다. 우선순위는 `API_URL` → `API_URL_TEMPLATE`과 `VERCEL_GIT_COMMIT_REF`가 둘 다 있으면 템플릿의 `{branch}`를 브랜치 슬러그로 바꾼 값 → `NEXT_PUBLIC_API_URL` → `http://localhost:4000`이고, 끝의 `/`는 뗀다
- 그래서 PR 프리뷰에서는 클라이언트 프리뷰가 같은 브랜치의 서버 프리뷰를 부른다. Vercel Preview 환경에는 `API_URL_TEMPLATE=https://workbridge-server-git-{branch}-jonghoon24s-projects.vercel.app`이 들어 있다(Preview에는 `API_URL`을 넣지 않는다 — 넣으면 템플릿보다 먼저 쓰인다). 브랜치 슬러그는 Vercel 브랜치 URL 규칙대로 소문자로 바꾸고 `[a-z0-9]` 밖의 글자를 `-`로, 연속 `-`는 하나로, 앞뒤 `-`는 뗀다. Vercel은 호스트명이 길면 슬러그를 잘라 해시를 붙이는데 이건 재현하지 않으므로 **브랜치 이름은 20자 안팎으로 짧게** 둔다

## 배포 후 업데이트

- 백엔드 `CLIENT_URL` → 프론트엔드 Vercel URL (CORS와 메일 링크 기준 주소. 운영에서 비어 있으면 시작 때 경고하고 브라우저 요청이 CORS로 막힌다)
- 백엔드 `GOOGLE_CALLBACK_URL` → 프론트엔드 Vercel URL + `/api/auth/google/callback`
- 프론트엔드 `NEXT_PUBLIC_API_URL` → 백엔드 Vercel URL
- 서버 `ALLOW_PAYMENT_BYPASS`와 클라이언트 `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS`는 반드시 `false`

## Sentry

`SENTRY_DSN`을 설정하면 서버 오류를 Sentry로 보낸다. **비어 있으면 꺼져 있고** `@sentry/node`도 불러오지 않는다(모든 호출이 바로 돌아온다).

- **보내는 것은 두 가지뿐이다.** 응답이 500으로 끝난 요청(`errorHandler`, 요청 ID·메서드·경로와 로그인한 경우 사용자 ID를 태그로)과 최종 실패한 작업(`jobs/runner.ts`, 영구 실패나 재시도 소진 — 작업 ID·종류·시도 횟수). 4xx와 재시도될 작업 실패는 보내지 않는다.
- 오류만 보낸다(`tracesSampleRate: 0`). `sendDefaultPii: false`라 IP·쿠키·요청 본문은 붙지 않는다.
- `environment`는 `SENTRY_ENVIRONMENT` → `VERCEL_ENV` → `NODE_ENV` 순, `release`는 `VERCEL_GIT_COMMIT_SHA`다.
- **서버리스에서는 응답 직후 함수가 멈출 수 있어서** 500 응답을 보내기 전에 최대 2초 `flush`한다. 작업 큐도 `runDueJobs` 한 번이 끝날 때 `flush`하므로 `POST /api/internal/jobs/run`과 `npm run jobs:run`에서 이벤트가 사라지지 않는다. 2초 안에 못 보내면 `warn` 한 줄을 남기고 응답은 그대로 나간다(그 이벤트는 잃을 수 있다).
- 기존 `error` 로그 한 줄은 그대로 남는다. Sentry 자체의 실패는 `warn`이다.

## 운영 환경의 한계

로컬 개발에서는 다 동작하지만 운영(Vercel)에서는 아직 막혀 있거나 손이 필요한 것들이다. 각각 의도된 현재 상태이고, 해결은 배포 결정과 함께 한다.

### 1. 작업 큐를 실행하는 주체가 없다

Vercel에는 상주 프로세스가 없어서 개발 서버가 띄우는 워커(`JOB_WORKER_ENABLED`)가 운영에서는 돌지 않는다. 작업 큐를 돌리는 방법은 셋뿐이다.

| 방법 | 설명 |
| --- | --- |
| `POST /api/internal/jobs/run` | 외부 스케줄러가 주기적으로 부를 엔드포인트. `INTERNAL_JOB_TOKEN`을 설정하고 `X-Internal-Token` 헤더로 호출한다. 본문 `{ "limit": 1~500 }`(기본 50)으로 한 번에 실행할 작업 수를 제한한다. 토큰이 비어 있으면 엔드포인트가 404로 숨는다 |
| `npm run jobs:run` | 한 번 실행하는 CLI. 운영 DB 연결 정보를 가진 곳에서 수동으로 |
| `npm run jobs:worker` | 상주 워커 CLI. 상주 서버가 있을 때 |

**어떤 외부 스케줄러가 엔드포인트를 부를지는 아직 정하지 않았다**([#23 작업 큐를 실행할 외부 스케줄러가 없다](https://github.com/jonghoon24/workbridge/issues/23)). 연결하기 전까지 운영에서는 다음이 **일어나지 않는다**.

- 마일스톤 자동 승인(제출 7일 뒤)과 자동 승인 48시간 전 리마인더 — 의뢰인이 검수하지 않으면 마일스톤이 `SUBMITTED`에 머문다
- 마일스톤 기한 임박·기한 경과 알림
- 주간 정산 배치(월요일 03:00 KST)와 지급(수요일 10:00 KST) — 승인된 금액이 미정산 항목으로 쌓인다
- 이메일 발송(`notification.email`)과 미확인 메시지 요약 메일 — `EmailDelivery`가 `PENDING`으로 쌓인다
- 10분마다 도는 프로젝트 상태 스윕 — 단, `GET /api/projects`와 `GET /api/projects/:id`가 읽을 때마다 같은 스윕을 하므로 상태는 계속 맞는다
- `maintenance.cleanup` — 아래 2번

이 작업들은 `Job` 테이블에 `PENDING`으로 남아 있다가 러너가 처음 돌 때 한꺼번에 처리된다. 반복 작업(스윕, 정리, 주간 배치)은 러너가 시작할 때 만들어지므로 그 전에는 행 자체가 없다. 밀린 반복 슬롯은 하나씩 따라잡지 않고 한 번만 실행한다.

스케줄러를 붙일 때 확인할 것:

- **지급 provider가 로그 전용이다.** `LogPayoutProvider`는 실제 이체 없이 로그만 남기고 성공한다. 러너가 돌면 정산이 실제 송금 없이 `PAID`가 된다. 실제 은행 이체 연동 전에는 운영에서 지급 작업이 돌지 않게 해야 한다.
- 서버리스 함수의 실행 시간 제한 안에 끝나도록 `limit`을 작게 잡는다. 시간 초과로 끊긴 작업은 10분 뒤 stale lock 회수로 다시 시도된다.
- 주간 배치·지급처럼 시각이 정해진 작업은 호출 간격만큼 늦게 돈다.

### 2. 요청 제한 카운터가 정리되지 않는다

로그인과 AI 단가 분석의 요청 제한 카운터(`RateLimitCounter`)는 Postgres에 있고, 만료된 행은 `maintenance.cleanup` 작업(매일 04:00 KST)만 지운다. 러너가 없는 운영에서는 **만료된 카운터 행이 계속 쌓인다**. 행 수는 윈도마다 (IP 수 + 이메일·IP 조합 수 + 분석 사용자 수)에 비례해 유한하지만 줄지 않는다. 같은 이유로 14일 지난 완료 작업도 지워지지 않는다. 스케줄러가 붙기 전까지는 가끔 직접 지운다.

```sql
DELETE FROM "RateLimitCounter" WHERE "expiresAt" <= now() AT TIME ZONE 'UTC';
```

### 3. 큰 첨부 파일은 Vercel이 막는다

로컬에서는 마일스톤 제출과 메시지에 파일을 10MB × 5개까지 올릴 수 있다. Vercel 서버리스 함수의 **요청 본문 한도는 4.5MB**라서 운영에서는 그보다 큰 요청이 플랫폼에서 413으로 막힌다(앱의 오류 형식이 아니다). 브라우저 요청은 Next 프록시와 백엔드 두 함수를 거치므로 두 곳 모두 이 한도에 걸린다. 코드로 우회하지 않았다. 해결은 브라우저가 저장소에 직접 올리는 서명된 업로드 URL 방식이고, 첨부를 비공개 버킷과 서명 URL로 옮기는 문제(BEHAVIOR.md Q21)와 함께 정한다.

### 4. 이메일은 로그로만 나간다

실제 메일 서비스는 연결돼 있지 않다. `MAIL_PROVIDER`는 비우거나 `log`만 지원하고, 이 provider는 메일을 보내지 않고 받는 주소와 본문 전체를 `info` 로그 `mail.sent` 한 줄로 남긴다. 운영 로그에 개인정보(이메일 주소와 알림 내용)가 남는다는 뜻이므로 러너를 붙이기 전에 검토가 필요하다(Q24). 다른 값을 넣으면 시작 때 경고 한 줄을 남기고 모든 발송이 `FAILED`가 된다. 지금은 러너도 없어서 운영에서는 메일이 아예 나가지 않는다. 구독 해지 링크도 없다(Q25).

### 5. `TRUST_PROXY`와 클라이언트 IP

로그인 요청 제한은 클라이언트 IP를 키로 쓴다. `TRUST_PROXY`가 설정되면 `X-Forwarded-For`에서 신뢰하는 프록시를 뺀 주소, 비어 있으면 소켓 주소다. Next 프록시는 받은 `X-Forwarded-For`를 그대로 전달한다.

- **자체 호스팅**: `TRUST_PROXY=loopback`은 Next 포트에 신뢰하는 클라이언트만 닿을 때만 안전하다. 아니면 클라이언트가 헤더로 자기 IP를 골라 로그인 제한을 우회한다(Q23). 헤더를 다시 쓰는 프록시를 Next 앞에 두거나 `TRUST_PROXY`를 비운다.
- **Vercel**: 브라우저 → Next 함수 구간은 Vercel 엣지가 `X-Forwarded-For`를 실제 주소로 덮어쓴다. 하지만 Next 함수 → 백엔드 함수 구간에서 백엔드가 어떤 주소를 보게 되는지는 **아직 검증하지 않았다**. 배포 후 백엔드 접근 로그의 `ip`를 확인해, 모든 요청이 한 주소(Next 함수의 주소)로 보이면 전체 사용자가 15분 20회 로그인 한도를 함께 쓰게 되므로 `TRUST_PROXY` 값을 다시 정해야 한다.

### 6. 그 밖에

- **첨부 파일은 공개 버킷**(`workbridge`)에 추측하기 어려운 키로 저장되고 공개 URL로 나간다. URL을 아는 사람은 로그인 없이 내려받을 수 있고, 메시지를 지워도 파일은 남는다(Q21).
- **지급 계좌번호는 평문 저장**이고 응답·로그·정산에는 마스킹한 값만 나간다(Q22).
- 로그는 한 줄 JSON이고 `error`만 stderr로 간다. `LOG_LEVEL`로 기준을 정한다.
