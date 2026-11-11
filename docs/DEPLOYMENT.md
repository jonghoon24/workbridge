# 배포 (Vercel)

## 환경

| 환경 | 언제 | 앱 | DB |
| --- | --- | --- | --- |
| 로컬 | 개발 | `npm run dev` (서버 :4000, 클라이언트 :3000) | 로컬 Postgres. 테스트는 이름에 `test`가 들어간 별도 DB(`scripts/test-db.sh`), E2E는 `workbridge_e2e` |
| CI | PR과 `main` 푸시 | GitHub Actions(`ci.yml`, `e2e.yml`) | 워크플로마다 띄우는 Postgres 서비스 컨테이너 |
| 프리뷰 | 브랜치 배포를 켰을 때 PR마다(지금은 꺼 둠, 아래 "백엔드") | Vercel Preview 배포 | Supabase 프리뷰 프로젝트 |
| 운영 | `main` 머지 | Vercel Production 배포 | Supabase 운영 프로젝트 |

프리뷰와 운영은 서로 다른 Supabase 프로젝트를 쓰므로 환경변수([ENV.md](ENV.md))도 Vercel의 Preview·Production 환경에 따로 넣는다. 마이그레이션은 `.github/workflows/migrate.yml`이 적용한다. `main`에 푸시된 커밋이 `workbridge-server/prisma/migrations/**`를 바꾸면(또는 Actions에서 수동 `workflow_dispatch`) 프리뷰 DB → 운영 DB 순서로 `prisma migrate deploy`를 돌린다. 운영 작업은 프리뷰 작업이 성공해야 시작한다. 시크릿 `PREVIEW_DIRECT_URL`·`PROD_DIRECT_URL`은 pgbouncer를 거치지 않는 Session mode(5432) 연결이고, `concurrency: migrate`로 두 실행이 겹치지 않는다. 원격 DB에 마이그레이션을 적용하는 경로는 이것뿐이다. 주의할 점 둘: 같은 `main` 푸시에서 Vercel 운영 배포와 이 워크플로가 따로 돌고 순서를 맞추는 장치가 없어서 새 코드가 마이그레이션 전의 DB를 잠깐 상대할 수 있다(그래서 마이그레이션은 이전 코드와 새 코드 모두에 안전해야 한다). 또 스키마를 바꾸는 PR의 서버 프리뷰는 머지 전까지 마이그레이션되지 않은 프리뷰 DB를 상대한다.

### Vercel 프로젝트

| 프로젝트 | 운영 주소 |
| --- | --- |
| 서버 | https://workbridge-server-tau.vercel.app |
| 클라이언트 | https://workbridge-client-alpha.vercel.app |

둘 다 Vercel 팀 `jonghoon24s-projects`에 있고 Preview·Production 환경변수는 넣어 두었다. 리포지토리와 Vercel GitHub 앱으로 연결돼 있고 `main` 머지는 운영 배포가 된다. 브랜치·PR 프리뷰 배포는 지금 꺼 두었다 — 두 `vercel.json`의 `git.deploymentEnabled`가 `main`만 배포한다. 이 설정을 지우면 푸시된 브랜치와 PR마다 두 프로젝트가 다시 프리뷰 배포된다.

### 시드 리셋 — `seed.yml`

프리뷰나 운영 DB를 시드 데이터([SEED_DATA.md](SEED_DATA.md))로 되돌리는 수동 실행 전용 워크플로다. 입력 `environment`(`preview`|`production`)와 `confirm`(`seed`를 넣어야 돈다)을 받고, 마이그레이션을 먼저 적용한 뒤 `npm run db:seed`를 돌린다. **시드는 모든 테이블을 비운다.** `migrate.yml`과 같은 `concurrency: migrate` 그룹이다.

```bash
gh workflow run seed.yml -f environment=preview -f confirm=seed
```

시드는 지급 계좌번호를 그 환경의 키로 암호화해 넣으므로, 이 워크플로는 리포지토리 시크릿
`PREVIEW_PAYOUT_ACCOUNT_ENCRYPTION_KEY`·`PROD_PAYOUT_ACCOUNT_ENCRYPTION_KEY`를 쓴다(아래 "지급 계좌 암호화 키").

### 지급 계좌 암호화 키

지급 계좌번호(`PayoutAccount.accountNumber`)는 저장할 때 AES-256-GCM으로 암호화한다(`src/lib/payoutAccountCrypto.ts`,
[DATABASE.md](DATABASE.md#지급-계좌번호-암호화)). 키는 환경마다 따로 만든다(`openssl rand -base64 32`, 32바이트 base64).
**한 환경의 키는 세 곳에 같은 값으로 들어간다.**

| 곳 | 프리뷰 | 운영 |
| --- | --- | --- |
| Vercel 서버 프로젝트 환경변수 | Preview의 `PAYOUT_ACCOUNT_ENCRYPTION_KEY` | Production의 `PAYOUT_ACCOUNT_ENCRYPTION_KEY` |
| GitHub 리포지토리 시크릿(`seed.yml`, `payout-encrypt.yml`) | `PREVIEW_PAYOUT_ACCOUNT_ENCRYPTION_KEY` | `PROD_PAYOUT_ACCOUNT_ENCRYPTION_KEY` |

- 키가 없으면 서버는 뜨지만 지급 계좌 등록, 계좌가 있는 사용자의 계좌 조회, 지급 작업이 실패한다(지연 getter). 시드는 아무것도 지우기 전에 멈춘다.
- **키를 잃으면 저장된 계좌번호를 되살릴 수 없다.** 프리랜서가 계좌를 다시 등록해야 한다. 키 값은 Vercel·GitHub 밖의
  비밀 보관소에도 둔다.
- **처음 켤 때(평문 행 백필)**: 키를 Vercel과 GitHub에 넣고 서버를 다시 배포한 뒤, 환경마다 한 번
  `gh workflow run payout-encrypt.yml -f environment=preview`(그다음 `production`)를 돌린다. 암호화 전에 저장된 행은 숫자
  그대로라 서버가 그대로 읽을 수 있고(배포와 백필 사이에도 지급이 된다), 계좌를 다시 저장하거나 이 백필이 돌면 암호화된다.
  백필은 여러 번 돌려도 안전하다. 끝나면 로그 한 줄 `payout account numbers encrypted`의 `encrypted`가 0이 될 때까지 다시 돌려 확인한다.
- **키 교체**: 저장 형식이 `v1:<iv>:<tag>:<암호문>`이고 접두어가 키를 가리킨다. 새 키는 새 버전(`v2`와 그 변수)으로 코드에
  추가해 새 쓰기를 그 버전으로 하고, 옛 버전은 읽기용으로 남긴 채 백필로 옛 행을 다시 암호화한 뒤 지운다. 지금 코드는 `v1`만 안다.

## 백엔드

- `workbridge-server/vercel.json`에 따라 `@vercel/node`가 `src/index.ts`를 서버리스 함수로 직접 트랜스파일한다. 빌드 단계와 `dist/`는 없다
- 함수 리전은 `vercel.json`의 `regions: ["icn1"]`(서울)이다. DB(Supabase)가 ap-northeast-2에 있어서 함수가 다른 리전(기본값 iad1)에서 돌면 쿼리마다 왕복 지연이 붙고, 지원 수락처럼 쿼리가 많은 트랜잭션이 Prisma의 인터랙티브 트랜잭션 기본 한도(5초)를 넘겨 500(`Transaction not found`)이 난다. DB 리전을 옮기면 이 값도 같이 옮긴다
- Prisma 클라이언트는 `package.json`의 `postinstall: prisma generate`가 설치 단계에서 만든다. 대시보드의 Build Command에도 `npx prisma generate`가 있지만 `vercel.json`에 `builds`가 있으면 대시보드 빌드 설정은 무시되므로 실제로 동작하는 것은 `postinstall`이다
- 운영(`NODE_ENV=production`)에서는 `app.listen()`도 작업 큐 워커도 시작하지 않는다
- API 문서(`/api/docs`, `/api/openapi.json`)는 프리뷰와 로컬에서만 열리고 운영에서는 404다. 내부 엔드포인트와 오류 메시지를 드러내지 않기 위해서다(조건은 [ENV.md](ENV.md)의 `VERCEL_ENV`)

## 프론트엔드

- 브라우저는 같은 출처의 `/api/*`를 부르고, Next 라우트 핸들러(`app/api/[...path]`, `app/api/auth/*`)가 백엔드로 전달한다
- 백엔드 주소는 서버 쪽(라우트 핸들러와 SSR)에서만 `src/lib/apiUrl.js`의 `getApiUrl()`이 정한다(우선순위는 그 파일 머리 주석)
- 그래서 PR 프리뷰에서는 클라이언트 프리뷰가 같은 브랜치의 서버 프리뷰를 부른다. `workbridge-client/vercel.json`의 `relatedProjects`에 서버 프로젝트 ID(`prj_u3RYDLPGTEVB29lYr8z60KXSyiSm`)가 들어 있어서, Vercel이 클라이언트 배포마다 `VERCEL_RELATED_PROJECTS`에 서버의 운영 주소와 같은 브랜치의 프리뷰 주소를 넣어 준다. 브랜치 이름이 길면 Vercel이 슬러그를 잘라 프로젝트마다 다른 해시를 붙이므로 클라이언트 쪽에서 서버 주소를 만들어 낼 수 없다 — 이 값만 믿는다. Preview에는 `API_URL`을 넣지 않는다(넣으면 이 값보다 먼저 쓰인다). Related Projects는 같은 리포지토리의 Git 연동 배포에서만 채워진다(CLI 배포에서는 비어 있어 `NEXT_PUBLIC_API_URL`로 간다)

## 배포 후 업데이트

- 백엔드 `CLIENT_URL` → 프론트엔드 Vercel URL **하나**(Google 로그인 리디렉션, 메일 링크, CORS의 기준 출처). 다른 출처(예: 커스텀 도메인)는 `CORS_ORIGINS`에 넣는다. 잘못 넣었을 때의 증상은 [ENV.md](ENV.md)의 `CLIENT_URL`
- 백엔드 `GOOGLE_CALLBACK_URL` → 프론트엔드 Vercel URL + `/api/auth/google/callback`
- 프론트엔드 `NEXT_PUBLIC_API_URL` → 백엔드 Vercel URL(Related Projects 값이 없는 CLI 배포용)
- 서버 `ALLOW_PAYMENT_BYPASS`와 클라이언트 `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS`는 반드시 `false`

## Sentry

`SENTRY_DSN`을 설정하면 서버 오류를 Sentry로 보낸다. **비어 있으면 꺼져 있고** `@sentry/node`도 불러오지 않는다(모든 호출이 바로 돌아온다).

- **보내는 것은 두 가지뿐이다.** 응답이 500으로 끝난 요청(`errorHandler`)과 최종 실패한 작업(`jobs/runner.ts`, 영구 실패나 재시도 소진). 4xx와 재시도될 작업 실패는 보내지 않는다. 오류만 보내고 개인정보(IP·쿠키·요청 본문)는 붙이지 않는다(`src/lib/sentry.ts`).
- **서버리스에서는 응답 직후 함수가 멈출 수 있어서** 500 응답을 보내기 전과 작업 큐 실행이 끝날 때 짧게 `flush`한다. 시간 안에 못 보내면 `warn` 한 줄을 남기고 응답은 그대로 나간다(그 이벤트는 잃을 수 있다).
- 기존 `error` 로그 한 줄은 그대로 남는다. Sentry 자체의 실패는 `warn`이다.

## 운영 환경의 한계

로컬 개발에서는 다 동작하지만 운영(Vercel)에서는 아직 막혀 있거나 손이 필요한 것들이다. 각각 의도된 현재 상태이고, 해결은 배포 결정과 함께 한다.

### 1. 작업 큐는 15분마다 돈다

Vercel에는 상주 프로세스가 없어서 개발 서버가 띄우는 워커(`JOB_WORKER_ENABLED`)가 운영에서는 돌지 않는다. 대신 **GitHub Actions(`.github/workflows/jobs.yml`)가 15분마다 운영 서버의 `POST /api/internal/jobs/run`을 부른다**(Actions 화면에서 수동 실행도 된다). Vercel Cron은 Hobby 플랜에서 하루 한 번만 돌아 15분 주기를 맞출 수 없어서 GitHub Actions를 쓴다. 프리뷰와 로컬 DB는 대상이 아니다.

| 방법 | 설명 |
| --- | --- |
| `POST /api/internal/jobs/run` | 크론이 부르는 엔드포인트. 운영 서버의 `INTERNAL_JOB_TOKEN`을 `X-Internal-Token` 헤더로 보낸다(워크플로는 같은 값을 리포지토리 시크릿 `PROD_INTERNAL_JOB_TOKEN`으로 가진다). 본문 `limit`으로 한 번에 실행할 작업 수를 제한하고, 워크플로는 서버리스 실행 시간 안에 끝나도록 작은 값(`JOBS_LIMIT`)을 보낸다. 토큰이 비어 있으면 엔드포인트가 404로 숨는다. 응답이 2xx가 아니면 워크플로가 실패한다 |
| `npm run jobs:run` | 한 번 실행하는 CLI. 운영 DB 연결 정보를 가진 곳에서 수동으로 |
| `npm run jobs:worker` | 상주 워커 CLI. 상주 서버가 있을 때 |

시각이 정해진 작업(자동 승인, 기한 알림, 주간 정산 배치 등)은 호출 간격(최대 15분, GitHub의 스케줄 지연이 더해질 수 있다)만큼 늦게 돈다. 함수 시간 초과로 끊긴 작업은 stale lock 회수(`STALE_LOCK_MS`, `jobs/runner.ts`)로 다시 시도된다. 리포지토리에 60일 동안 활동이 없으면 GitHub가 스케줄을 끈다.

**두 작업은 환경변수로 꺼 두었다.** 운영 서버에서 정확히 `true`로 켜기 전까지는 다음이 **일어나지 않는다**. 꺼져 있을 때 각 작업이 어떻게 남는지와 둘을 다르게 끈 이유는 [domain/jobs.md](domain/jobs.md#플래그로-꺼-둔-작업)에 있다. 로컬은 `.env.example`대로 둘 다 켠다(지급은 로그 provider, 메일은 로그에만 쓴다).

| 작업 | 플래그 | 켜는 조건 |
| --- | --- | --- |
| `settlement.payout`(정산 지급) | `JOB_PAYOUT_ENABLED` | 실제 은행 이체 provider 연동. 지금 `LogPayoutProvider`는 돈을 보내지 않고 성공을 보고해 정산을 `PAID`로 만든다. 켜는 날 밀린 지급이 실행된다 |
| `notification.email`(알림 메일과 미확인 메시지 요약 메일) | `JOB_EMAIL_ENABLED` | 실제 메일 provider 연결과 로그 개인정보 문제 해결([#26](https://github.com/jonghoon24/workbridge/issues/26)) — 아래 4번. 밀린 메일은 나가지 않는다 |

### 2. 요청 제한 카운터와 완료 작업 정리

요청 제한 카운터(`RateLimitCounter`) 중 만료된 행과 오래된 완료 작업은 `maintenance.cleanup` 작업(매일)이 지운다. 운영에서는 위 크론이 이 작업을 돌린다. 크론이 멈췄을 때는 직접 지운다.

```sql
DELETE FROM "RateLimitCounter" WHERE "expiresAt" <= now() AT TIME ZONE 'UTC';
```

### 3. 첨부 파일은 저장소로 직접 올린다

Vercel 서버리스 함수의 **요청 본문 한도는 4.5MB**다(넘으면 플랫폼이 앱의 오류 형식이 아닌 413으로 막는다. 브라우저 요청은 Next 프록시와 백엔드 두 함수를 거치므로 두 곳 모두 걸린다). 그래서 이 한도보다 큰 파일을 받는 메시지와 마일스톤 결과물 첨부는 서버를 거치지 않는다: 서버가 서명 업로드 URL을 주고, 브라우저가 Supabase Storage의 **비공개 버킷**(`SUPABASE_ATTACHMENT_BUCKET`)에 직접 `PUT`하고, 메시지·제출에는 업로드 ID만 보낸다. 읽고 내려받을 때는 짧은 서명 URL을 준다([domain/messaging-notifications.md "첨부 파일"](domain/messaging-notifications.md#첨부-파일), [#22](https://github.com/jonghoon24/workbridge/issues/22), [#25](https://github.com/jonghoon24/workbridge/issues/25)).

남은 한계:

- 프로필 이미지(`PATCH /api/users/me`)와 포트폴리오 이미지(5MB)는 여전히 multipart로 서버를 거친다. 4.5MB를 넘는 이미지는 운영에서 플랫폼 413이다.
- 지운 메시지의 파일과 붙지 않고 만료된 업로드의 파일은 작업이 지우므로 1번의 지연(최대 15분, 정리는 매일 04:00 KST)만큼 늦게 사라진다. 그동안에도 서명 URL은 나가지 않는다.
- 버킷은 프리뷰·운영 Supabase 프로젝트마다 따로 만든다. 만드는 법은 [ENV.md](ENV.md#supabase).

**첨부 파일 저장소 이전(한 번).** 이 방식 전에 올린 첨부는 공개 버킷 `workbridge`에 있고 행에 공개 URL만 있다. 그대로 두어도 화면에서 보이지만(공개 URL을 그대로 내보낸다) 로그인 없이 받을 수 있는 상태가 남는다. 그 환경에 이 코드가 배포된 뒤 프리뷰 → 운영 순서로 수동 워크플로 `attachments-migrate.yml`을 돌린다(원격 DB 접속 문자열과 Supabase 키는 GitHub 시크릿 `*_DIRECT_URL`·`*_SUPABASE_URL`·`*_SUPABASE_SECRET_KEY`에만 있다):

```bash
gh workflow run attachments-migrate.yml -f environment=preview              # 건수만 센다(found/skipped)
gh workflow run attachments-migrate.yml -f environment=preview -f apply=true # 비공개 버킷의 같은 키로 복사하고 행을 storageKey로 바꾼다
```

워크플로는 `workbridge-server/scripts/migrate-legacy-attachments.ts`를 돌린다. 로컬에서 그 환경의 값을 넣고 `npx tsx scripts/migrate-legacy-attachments.ts [--apply]`로 돌려도 같다.

다시 돌려도 안전하다(옮긴 행은 건너뛴다). `failed`가 비고 화면에서 예전 첨부가 열리는 것을 확인한 뒤, 공개 버킷의 `messages/`·`milestones/` 폴더를 Supabase 대시보드에서 지운다(`profiles/`·`portfolio/`는 지우지 않는다). 시드 데이터의 자리표시 이미지(`placehold.co`)는 건너뛴다(`skipped`).

### 4. 이메일은 로그로만 나간다

실제 메일 서비스는 연결돼 있지 않다. `MAIL_PROVIDER`는 비우거나 `log`만 지원하고, 이 provider는 메일을 보내지 않고 받는 주소와 본문 전체를 `info` 로그 `mail.sent` 한 줄로 남긴다. 운영 로그에 개인정보(이메일 주소와 알림 내용)가 남는다는 뜻이다. 그래서 운영에서는 `JOB_EMAIL_ENABLED`를 켜지 않아 메일 작업이 delivery를 `SKIPPED`로 끝내고, 메일은 로그에도 나가지 않는다(1번). 실제 메일 provider와 발송 기록 보관 기간을 정한 뒤에 켠다([#26](https://github.com/jonghoon24/workbridge/issues/26)). 다른 `MAIL_PROVIDER` 값을 넣으면 시작 때 경고 한 줄을 남기고 모든 발송이 `FAILED`가 된다. 구독 해지 링크도 없다(같은 이슈).

### 5. 클라이언트 IP

로그인 요청 제한과 접근 로그의 `ip`는 클라이언트 IP를 쓴다(`src/lib/clientIp.ts`). 프리뷰에서 확인한 Vercel의 동작(2026-11-08):

- 서버 함수의 소켓 주소와 `req.ip`는 **언제나 `127.0.0.1`**이다(`@vercel/node`가 Express를 로컬 소켓 뒤에서 돌린다).
- 서버를 직접 부르면 Vercel 엣지가 `X-Forwarded-For`·`X-Real-IP`·`X-Vercel-Forwarded-For`를 실제 클라이언트 IP로 **덮어쓴다**. 클라이언트가 보낸 같은 헤더는 버려진다.
- Next 프록시를 거치면 같은 헤더가 **Next 함수의 송신 IP**(AWS 주소)가 된다. Next 함수 자신은 엣지가 덮어쓴 실제 브라우저 IP를 받는다.

그래서 클라이언트 IP는 이 순서로 정한다.

1. Next 프록시가 Vercel에서 브라우저 IP를 `X-Client-IP`에, 공유 비밀 `PROXY_SHARED_SECRET`을 `X-Proxy-Secret`에 담아 보낸다. 서버는 비밀이 같을 때만(상수 시간 비교) 이 IP를 쓴다. 두 프로젝트의 Production·Preview에 **같은 값**이 들어 있어야 한다. 비밀을 바꿀 때는 두 프로젝트를 함께 바꾸고 다시 배포한다(어긋난 동안에는 프록시 경유 요청이 Next 함수 주소로 세어진다).
2. Vercel(`VERCEL=1`)에서는 `X-Vercel-Forwarded-For` — 직접 호출의 실제 IP.
3. 그 밖에는 `req.ip`. `TRUST_PROXY`가 설정되면 `X-Forwarded-For`에서 신뢰하는 프록시를 뺀 주소, 비어 있으면 소켓 주소다. 로컬은 `TRUST_PROXY=loopback`이고 `PROXY_SHARED_SECRET`은 비워 둔다.

**자체 호스팅**: `TRUST_PROXY=loopback`은 Next 포트에 신뢰하는 클라이언트만 닿을 때만 안전하다. 아니면 클라이언트가 헤더로 자기 IP를 골라 로그인 제한을 우회한다. 헤더를 다시 쓰는 프록시를 Next 앞에 두거나 `TRUST_PROXY`를 비운다. Next 프록시는 Vercel에서만 `X-Client-IP`를 보낸다.

### 6. Google 전용 계정의 재인증은 로그인 시각을 확인하지 못한다

Google로만 가입한 회원은 탈퇴 직전에 Google 로그인을 한 번 더 거친다([domain/accounts.md "Google 재인증"](domain/accounts.md#google-재인증)). "방금 로그인했다"의 근거는 Google이 ID 토큰에 담는 로그인 시각(`auth_time`)인데, Google은 이 값을 **게시·인증된 앱이 "Session age claims"를 켰을 때만** 준다. 운영의 Google OAuth 앱은 아직 이 조건을 갖추지 않았다고 보고 기본값(완화 모드)으로 둔다.

- **완화 모드(기본)**: 연결된 Google 계정으로 다녀왔는지와 계정이 이 회원의 것인지는 확인하지만, 시각이 오지 않으면 신선도를 확인하지 못하고 `warn` 로그 `google reauth without auth_time`를 남긴다. 그래서 **이 브라우저에 Google 로그인이 살아 있으면 비밀번호 입력 없이 클릭만으로 통과한다.** 시각이 오면 그때는 확인한다.
- **엄격 모드로 바꾸는 법**: Google 앱을 게시·인증하고 Session age claims를 켠다([ENV.md](ENV.md#google-oauth) "Google OAuth" 4번) → 프리뷰에서 실제 Google 왕복으로 `warn`이 사라진 것을 확인 → 운영 서버에 `GOOGLE_REAUTH_REQUIRE_AUTH_TIME=true`. 이후 시각이 없는 확인은 받지 않는다(`unavailable`, 화면은 고객센터를 안내). 조건 없이 켜면 Google 전용 회원은 탈퇴할 수 없다.

### 7. 그 밖에

- **프로필·포트폴리오 이미지는 공개 버킷**(`workbridge`)에 추측하기 어려운 키로 저장되고 공개 URL로 나간다. 공개 프로필에 보이는 이미지라 의도된 것이다. 메시지·결과물 첨부는 3번의 비공개 버킷이다.
- **지급 계좌번호는 저장할 때 암호화**하고(위 "지급 계좌 암호화 키") 응답·로그·정산에는 마스킹한 값만 나간다. 계좌가 회원 본인 것인지 은행 API로 확인하지는 않는다 — 예금주는 프로필 이름과만 비교한다. 은행 확인은 실제 송금을 연동할 때 한다([#28](https://github.com/jonghoon24/workbridge/issues/28)).
- 로그는 한 줄 JSON이고 `error`만 stderr로 간다. `LOG_LEVEL`로 기준을 정한다.
