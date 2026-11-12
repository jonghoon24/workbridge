# 배포 (Vercel)

## 환경

| 환경 | 언제 | 앱 | DB |
| --- | --- | --- | --- |
| 로컬 | 개발 | `npm run dev` (서버 :4000, 클라이언트 :3000) | 로컬 Postgres. 테스트는 이름에 `test`가 들어간 별도 DB(`scripts/test-db.sh`), E2E는 `workbridge_e2e` |
| CI | PR과 `main` 푸시 | GitHub Actions(`ci.yml`, `e2e.yml`) | 워크플로마다 띄우는 Postgres 서비스 컨테이너 |
| 프리뷰 | PR마다 | Vercel Preview 배포 | Supabase 프리뷰 프로젝트 |
| 프로덕션 | `main` 머지 | Vercel Production 배포 | Supabase 프로덕션 프로젝트 |

프리뷰와 프로덕션은 서로 다른 Supabase 프로젝트를 쓴다. 그래서 환경변수도 Vercel의 Preview·Production 환경에 따로 넣는다
([ENV.md](ENV.md)).

### 마이그레이션

원격 DB에 마이그레이션을 적용하는 경로는 `.github/workflows/migrate.yml` 하나뿐이다.

- 언제: `main`에 푸시된 커밋이 `workbridge-server/prisma/migrations/**`를 바꿨을 때 돈다. Actions 화면에서 수동으로도 돌린다.
- 순서: 프리뷰 DB에 `prisma migrate deploy`를 돌리고, 성공하면 프로덕션 DB에 돌린다.
- 연결: 시크릿 `PREVIEW_DIRECT_URL`·`PROD_DIRECT_URL`(어떤 연결인지는 `migrate.yml` 머리 주석).
- `concurrency: migrate`로 두 실행이 겹치지 않는다.

주의할 점은 둘이다.

1. 같은 `main` 푸시에서 Vercel 프로덕션 배포와 이 워크플로가 따로 돌고, 둘의 순서를 맞추는 장치가 없다. 새 코드가
   마이그레이션 전의 DB를 잠깐 상대할 수 있으므로, 마이그레이션은 이전 코드와 새 코드 모두에 안전해야 한다.
2. 스키마를 바꾸는 PR의 서버 프리뷰는 머지 전까지 마이그레이션되지 않은 프리뷰 DB를 상대한다.

### Vercel 프로젝트

| 프로젝트 | 프로덕션 주소 |
| --- | --- |
| 서버 | https://workbridge-server-tau.vercel.app |
| 클라이언트 | https://workbridge-client-alpha.vercel.app |

둘 다 Vercel 팀 `jonghoon24s-projects`에 있고 Preview·Production 환경변수는 넣어 두었다. 리포지토리와 Vercel GitHub 앱으로 연결돼 있어서, 푸시된 브랜치와 PR마다 두 프로젝트가 프리뷰 배포되고 `main` 머지는 프로덕션 배포가 된다.

### 시드 리셋 — `seed.yml`

프리뷰나 프로덕션 DB를 시드 데이터([SEED_DATA.md](SEED_DATA.md))로 되돌리는 수동 실행 전용 워크플로다. 입력 `environment`(`preview`|`production`)와 `confirm`(`seed`를 넣어야 돈다)을 받고, 마이그레이션을 먼저 적용한 뒤 `npm run db:seed`를 돌린다. **시드는 모든 테이블을 비운다.** `migrate.yml`과 같은 `concurrency: migrate` 그룹이다.

```bash
gh workflow run seed.yml -f environment=preview -f confirm=seed
```

시드는 지급 계좌번호를 그 환경의 키로 암호화해 넣는다. 그래서 이 워크플로는 리포지토리 시크릿
`PREVIEW_PAYOUT_ACCOUNT_ENCRYPTION_KEY`·`PROD_PAYOUT_ACCOUNT_ENCRYPTION_KEY`를 쓴다(아래 "지급 계좌 암호화 키").

### 지급 계좌 암호화 키

지급 계좌번호(`PayoutAccount.accountNumber`)는 저장할 때 암호화한다(저장 형식은
[DATABASE.md](DATABASE.md#지급-계좌번호-암호화), 키 형식은 `workbridge-server/.env.example` 주석). 키는 환경마다 따로 만든다.
**한 환경의 키는 아래 두 곳에 같은 값으로 들어간다.**

| 곳 | 프리뷰 | 프로덕션 |
| --- | --- | --- |
| Vercel 서버 프로젝트 환경변수 | Preview의 `PAYOUT_ACCOUNT_ENCRYPTION_KEY` | Production의 `PAYOUT_ACCOUNT_ENCRYPTION_KEY` |
| GitHub 리포지토리 시크릿(`seed.yml`, `payout-encrypt.yml`) | `PREVIEW_PAYOUT_ACCOUNT_ENCRYPTION_KEY` | `PROD_PAYOUT_ACCOUNT_ENCRYPTION_KEY` |

- 키가 없어도 서버는 뜬다. 다만 지급 계좌 등록, 계좌가 있는 사용자의 계좌 조회, 지급 작업이 실패한다. 서버는 키를 쓰는
  순간에 읽기 때문이다. 시드는 아무것도 지우기 전에 멈춘다.
- **키를 잃으면 저장된 계좌번호를 되살릴 수 없다.** 프리랜서가 계좌를 다시 등록해야 한다. 그래서 키 값은 Vercel·GitHub
  밖의 비밀 보관소에도 둔다.
- **처음 켤 때(평문 행 백필)**: 키를 Vercel과 GitHub에 넣고 서버를 다시 배포한다. 그다음 환경마다 한 번
  `gh workflow run payout-encrypt.yml -f environment=preview`(그다음 `production`)를 돌린다. 암호화 전에 저장된 행은 숫자
  그대로라 서버가 그대로 읽는다. 그래서 배포와 백필 사이에도 지급이 된다. 계좌를 다시 저장하거나 이 백필이 돌면 그 행이
  암호화된다. 백필은 여러 번 돌려도 안전하다. 로그 한 줄 `payout account numbers encrypted`의 `encrypted`가 0이 될 때까지
  다시 돌려 확인한다.
- **키 교체**: 저장 값에는 키 버전 접두어가 붙는다([DATABASE.md](DATABASE.md#지급-계좌번호-암호화)). 새 키는 새 버전(`v2`와
  그 변수)으로 코드에 추가하고, 새 쓰기를 그 버전으로 한다. 옛 버전은 읽기용으로 남긴 채 백필로 옛 행을 다시 암호화하고, 끝나면 옛 버전을 지운다. 지금 코드는
  `v1`만 안다.

## 백엔드

- 빌드 단계와 `dist/`가 없다. `workbridge-server/vercel.json`에 따라 `@vercel/node`가 `src/index.ts`를 서버리스 함수로 바로
  트랜스파일한다.
- 함수 리전은 `vercel.json`의 `regions: ["icn1"]`(서울)이다. DB(Supabase)가 서울 리전(ap-northeast-2)에 있기 때문이다. 함수가
  다른 리전(기본값 미국 동부 `iad1`)에서 돌면 쿼리마다 대륙 간 왕복 지연이 붙는다. 그러면 지원 수락처럼 쿼리가 많은
  트랜잭션이 Prisma 인터랙티브 트랜잭션의 기본 한도(5초)를 넘겨 500(`Transaction not found`)이 난다. DB 리전을 옮기면
  이 값도 같이 옮긴다.
- Prisma 클라이언트는 설치 단계에서 `package.json`의 `postinstall: prisma generate`가 만든다. 대시보드의 Build Command에도
  `npx prisma generate`가 있지만, `vercel.json`에 `builds`가 있으면 Vercel이 대시보드 빌드 설정을 무시한다. 실제로 동작하는
  것은 `postinstall`이다.
- 프로덕션(`NODE_ENV=production`)에서는 `app.listen()`도 작업 큐 워커도 시작하지 않는다.
- API 문서(`/api/docs`, `/api/openapi.json`)는 프리뷰와 로컬에서만 열리고 프로덕션에서는 404다. 내부 엔드포인트와 오류 메시지를
  드러내지 않기 위해서다. 정확한 조건은 `workbridge-server/src/controllers/docs.controller.ts` 머리 주석에 있다.

## 프론트엔드

- 브라우저는 같은 출처의 `/api/*`를 부르고, Next 라우트 핸들러(`app/api/[...path]`, `app/api/auth/*`)가 백엔드로 전달한다.
- 백엔드 주소는 서버 쪽(라우트 핸들러와 SSR)에서만 `src/lib/apiUrl.js`의 `getApiUrl()`이 정한다. 우선순위는 그 파일 머리
  주석에 있다.
- PR 프리뷰에서는 클라이언트 프리뷰가 같은 브랜치의 서버 프리뷰를 부른다. 이것은 Vercel Related Projects로 된다.
  - `workbridge-client/vercel.json`의 `relatedProjects`에 서버 프로젝트가 등록돼 있다. Vercel은 클라이언트를 배포할 때마다
    `VERCEL_RELATED_PROJECTS`에 서버의 프로덕션 주소와 같은 브랜치의 프리뷰 주소를 넣어 준다.
  - 클라이언트가 서버 프리뷰 주소를 직접 만들 수는 없다. 브랜치 이름이 길면 Vercel이 슬러그를 자르고 프로젝트마다 다른
    해시를 붙이기 때문이다. 그래서 이 값만 믿는다.
  - Preview 환경에는 `API_URL`을 넣지 않는다. 넣으면 Related Projects 값보다 먼저 쓰인다.
  - Related Projects는 같은 리포지토리의 Git 연동 배포에서만 채워진다. CLI로 배포하면 비어 있어서 `NEXT_PUBLIC_API_URL`로 간다.

## 배포 후 업데이트

- 백엔드 `CLIENT_URL` → 프론트엔드 Vercel URL **하나**. Google 로그인 리디렉션, 메일 링크, CORS의 기준 출처다. 커스텀
  도메인 같은 다른 출처는 `CORS_ORIGINS`에 넣는다. 잘못 넣었을 때의 증상은 `workbridge-server/.env.example`의 `CLIENT_URL`
  주석에 있다.
- 백엔드 `GOOGLE_CALLBACK_URL` → 프론트엔드 Vercel URL + `/api/auth/google/callback`
- 프론트엔드 `NEXT_PUBLIC_API_URL` → 백엔드 Vercel URL. Related Projects 값이 없는 CLI 배포에서 쓰인다.
- 결제 우회 플래그는 두 패키지 모두 `false`로 둔다(아래 "프로덕션 환경의 한계" 7번).

## Sentry

`SENTRY_DSN`을 설정하면 서버 오류를 Sentry로 보낸다. **비어 있으면 꺼져 있고** `@sentry/node`도 불러오지 않는다. 이때 모든 Sentry 호출은 바로 돌아온다.

- **보내는 것은 두 가지뿐이다.** 응답이 500으로 끝난 요청(`errorHandler`)과 최종 실패한 작업(`jobs/runner.ts`, 영구 실패나 재시도 소진)이다. 4xx와 다시 시도될 작업 실패는 보내지 않는다. 오류만 보내고 개인정보(IP·쿠키·요청 본문)는 붙이지 않는다(`src/lib/sentry.ts`).
- **서버리스에서는 응답 직후 함수가 멈출 수 있다.** 그래서 500 응답을 보내기 전과 작업 큐 실행이 끝날 때 짧게 `flush`한다. 시간 안에 못 보내면 `warn` 한 줄을 남기고 응답은 그대로 나간다. 그 이벤트는 잃을 수 있다.
- 기존 `error` 로그 한 줄은 그대로 남는다. Sentry 자체의 실패는 `warn`이다.

## 프로덕션 환경의 한계

로컬 개발에서는 다 동작하지만 프로덕션(Vercel)에서는 막혀 있거나 손이 필요한 것들이다. 각각 의도된 현재 상태이고, 바꾸는 것은 배포 결정과 함께 한다.

### 1. 작업 큐는 15분마다 돈다

Vercel에는 상주 프로세스가 없다. 그래서 개발 서버가 띄우는 작업 워커(`JOB_WORKER_ENABLED`)가 프로덕션에서는 돌지 않는다. 대신 **GitHub Actions(`.github/workflows/jobs.yml`)가 15분마다 프로덕션 서버의 `POST /api/internal/jobs/run`을 부른다.** Actions 화면에서 수동으로도 돌린다. Vercel Cron을 쓰지 않는 것은 Hobby 플랜에서 하루 한 번만 돌아 15분 주기를 맞출 수 없기 때문이다. 프리뷰와 로컬 DB는 이 스케줄의 대상이 아니다.

| 방법 | 설명 |
| --- | --- |
| `POST /api/internal/jobs/run` | 크론이 부르는 엔드포인트 |
| `npm run jobs:run` | 한 번 실행하는 CLI. 프로덕션 DB 연결 정보를 가진 곳에서 수동으로 돌린다 |
| `npm run jobs:worker` | 상주 워커 CLI. 상주 서버가 있을 때 쓴다 |

내부 엔드포인트와 크론의 동작:

- 프로덕션 서버의 `INTERNAL_JOB_TOKEN`을 `X-Internal-Token` 헤더로 보낸다. 워크플로는 같은 값을 리포지토리 시크릿 `PROD_INTERNAL_JOB_TOKEN`으로 가진다.
- 서버에 토큰이 비어 있으면 엔드포인트가 404로 숨는다.
- 본문 `limit`이 한 번에 실행할 작업 수를 제한한다. 워크플로는 서버리스 실행 시간 안에 끝나도록 작은 값(`JOBS_LIMIT`)을 보낸다.
- 응답이 2xx가 아니면 워크플로가 실패한다.

- 시각이 정해진 작업(자동 승인, 기한 알림, 주간 정산 배치 등)은 호출 간격만큼 늦게 돈다. 최대 15분이고, GitHub의 스케줄 지연이 더해질 수 있다.
- 함수 시간 초과로 끊긴 작업은 stale lock 회수(`STALE_LOCK_MS`, `jobs/runner.ts`)로 다시 시도된다.
- 리포지토리에 60일 동안 활동이 없으면 GitHub가 스케줄을 끈다.

**두 작업은 환경변수로 꺼 두었다.** 프로덕션 서버에서 플래그를 정확히 `true`로 켜기 전까지 아래 작업은 **일어나지 않는다**. 꺼져 있을 때 각 작업이 어떻게 남는지와 둘을 다르게 끈 이유는 [domain/jobs.md](domain/jobs.md#플래그로-꺼-둔-작업)에 있다. 로컬은 `.env.example`대로 둘 다 켠다. 로컬에서 지급은 로그 provider라 돈이 오가지 않고, 메일은 로그에만 쓴다.

| 작업 | 플래그 | 켜는 조건 |
| --- | --- | --- |
| `settlement.payout`(정산 지급) | `JOB_PAYOUT_ENABLED` | 실제 은행 이체 provider 연동. 지금 `LogPayoutProvider`는 돈을 보내지 않고 성공을 보고해 정산을 `PAID`로 만든다. 켜는 날 밀린 지급이 실행된다 |
| `notification.email`(알림 메일과 미확인 메시지 요약 메일) | `JOB_EMAIL_ENABLED` | 실제 메일 provider 연결과 로그 개인정보 문제 해결([#26](https://github.com/jonghoon24/workbridge/issues/26)). 아래 4번. 밀린 메일은 나가지 않는다 |

### 2. 요청 제한 카운터와 완료 작업 정리

요청 제한 카운터(`RateLimitCounter`) 중 만료된 행과 오래된 완료 작업은 매일 도는 `maintenance.cleanup` 작업이 지운다(일정은 `jobs/recurring.ts`). 프로덕션에서는 위 크론이 이 작업을 돌린다. 크론이 멈췄을 때는 직접 지운다.

```sql
DELETE FROM "RateLimitCounter" WHERE "expiresAt" <= now() AT TIME ZONE 'UTC';
```

### 3. 첨부 파일은 저장소로 직접 올린다

Vercel 서버리스 함수의 **요청 본문 한도는 4.5MB**다. 이 한도를 넘는 요청은 플랫폼이 앱의 오류 형식이 아닌 413으로 막는다. 브라우저 요청은 Next 프록시와 백엔드 두 함수를 거치므로 두 곳 모두에서 걸린다.

그래서 메시지와 마일스톤 결과물 첨부는 서버를 거치지 않는다.

1. 서버가 서명 업로드 URL을 준다.
2. 브라우저가 Supabase Storage의 **비공개 버킷**(`SUPABASE_ATTACHMENT_BUCKET`)에 파일을 직접 `PUT`한다.
3. 메시지·제출 요청에는 업로드 ID만 보낸다.
4. 읽고 내려받을 때는 짧게 사는 서명 URL을 준다.

정책과 이유는 [domain/messaging-notifications.md "첨부 파일"](domain/messaging-notifications.md#첨부-파일)에 있다([#22](https://github.com/jonghoon24/workbridge/issues/22), [#25](https://github.com/jonghoon24/workbridge/issues/25)).

남은 한계:

- 프로필 이미지(`PATCH /api/users/me`)와 포트폴리오 이미지는 여전히 multipart로 서버를 거친다. 서버의 크기 한도는 `src/middlewares/upload.ts`와 `src/middlewares/attachmentUpload.ts`에 있다. 그 한도 안이어도 4.5MB를 넘는 이미지는 프로덕션에서 플랫폼 413이다.
- 지운 메시지의 파일과, 메시지에 붙지 않고 만료된 업로드의 파일은 작업이 지운다. 그래서 1번의 지연만큼 늦게 사라진다(정리 작업의 일정은 `jobs/recurring.ts`). 그동안에도 그 파일의 서명 URL은 나가지 않는다.
- 버킷은 프리뷰·프로덕션 Supabase 프로젝트마다 따로 만든다. 만드는 법은 [ENV.md](ENV.md#supabase)에 있다.

**첨부 파일 저장소 이전(한 번).** 이 방식 전에 올린 첨부는 공개 버킷 `workbridge`에 있고, 행에는 공개 URL만 있다. 그대로 두어도 화면에서 보이지만(공개 URL을 그대로 내보낸다) 로그인 없이 받을 수 있는 상태가 남는다. 그 환경에 이 코드가 배포된 뒤 프리뷰 → 프로덕션 순서로 수동 워크플로 `attachments-migrate.yml`을 돌린다. 원격 DB 접속 문자열과 Supabase 키는 GitHub 시크릿 `*_DIRECT_URL`·`*_SUPABASE_URL`·`*_SUPABASE_SECRET_KEY`에만 있다.

```bash
gh workflow run attachments-migrate.yml -f environment=preview              # 건수만 센다(found/skipped)
gh workflow run attachments-migrate.yml -f environment=preview -f apply=true # 비공개 버킷의 같은 키로 복사하고 행을 storageKey로 바꾼다
```

워크플로는 `workbridge-server/scripts/migrate-legacy-attachments.ts`를 돌린다. 로컬에서 그 환경의 값을 넣고 `npx tsx scripts/migrate-legacy-attachments.ts [--apply]`로 돌려도 같다.

다시 돌려도 안전하다. 옮긴 행은 건너뛴다. `failed`가 비고 화면에서 예전 첨부가 열리는 것을 확인한 뒤, 공개 버킷의 `messages/`·`milestones/` 폴더를 Supabase 대시보드에서 지운다. `profiles/`·`portfolio/`는 지우지 않는다. 시드 데이터의 자리표시 이미지(`placehold.co`)는 건너뛴다(`skipped`).

### 4. 이메일은 로그로만 나간다

- **provider의 동작**: `MAIL_PROVIDER`는 비우거나 `log`만 지원한다. 이 provider는 메일을 보내지 않고, 받는 주소와 본문 전체를 `info` 로그 `mail.sent` 한 줄로 남긴다.
- **프로덕션에서 끈 이유**: 이 provider로 메일 작업을 돌리면 프로덕션 로그에 개인정보(이메일 주소와 알림 내용)가 남는다. 그래서 프로덕션에서는 `JOB_EMAIL_ENABLED`를 켜지 않는다(1번). 메일 작업은 발송 기록(delivery)을 `SKIPPED`로 끝내고, 메일은 로그에도 나가지 않는다. 실제 메일 provider와 발송 기록 보관 기간을 정한 뒤에 켠다([#26](https://github.com/jonghoon24/workbridge/issues/26)).
- **다른 값을 넣으면**: 서버가 시작할 때 경고 한 줄을 남기고, 모든 발송이 `FAILED`가 된다.

### 5. 클라이언트 IP

로그인 요청 제한과 접근 로그의 `ip`는 클라이언트 IP를 쓴다(`src/lib/clientIp.ts`). 프리뷰에서 확인한 Vercel의 동작(2026-11-08):

- 서버 함수의 소켓 주소와 `req.ip`는 **언제나 `127.0.0.1`**이다. `@vercel/node`가 Express를 로컬 소켓 뒤에서 돌리기 때문이다.
- 서버를 직접 부르면 Vercel 엣지가 `X-Forwarded-For`·`X-Real-IP`·`X-Vercel-Forwarded-For`를 실제 클라이언트 IP로 **덮어쓴다**. 클라이언트가 보낸 같은 헤더는 버려진다.
- Next 프록시를 거치면 같은 헤더가 **Next 함수의 송신 IP**(AWS 주소)가 된다. Next 함수 자신은 엣지가 덮어쓴 실제 브라우저 IP를 받는다.

그래서 클라이언트 IP는 이 순서로 정한다.

1. Next 프록시는 Vercel에서 브라우저 IP를 `X-Client-IP`에, 공유 비밀 `PROXY_SHARED_SECRET`을 `X-Proxy-Secret`에 담아 보낸다. 서버는 비밀이 같을 때만(상수 시간 비교) 이 IP를 쓴다. 두 프로젝트의 Production·Preview에 **같은 값**이 들어 있어야 한다. 비밀을 바꿀 때는 두 프로젝트를 함께 바꾸고 다시 배포한다. 값이 어긋난 동안에는 프록시를 거친 요청이 Next 함수의 주소로 세어진다.
2. Vercel(`VERCEL=1`)에서는 `X-Vercel-Forwarded-For`를 쓴다. 직접 호출의 실제 IP다.
3. 그 밖에는 `req.ip`를 쓴다. `TRUST_PROXY`가 설정되면 `X-Forwarded-For`에서 신뢰하는 프록시를 뺀 주소이고, 비어 있으면 소켓 주소다. 로컬은 `TRUST_PROXY=loopback`이고 `PROXY_SHARED_SECRET`은 비워 둔다.

**자체 호스팅**: `TRUST_PROXY=loopback`은 Next 포트에 신뢰하는 클라이언트만 닿을 때만 안전하다. 아니면 클라이언트가 헤더로 자기 IP를 골라 로그인 제한을 우회한다. 헤더를 다시 쓰는 프록시를 Next 앞에 두거나 `TRUST_PROXY`를 비운다. Next 프록시는 Vercel에서만 `X-Client-IP`를 보낸다.

### 6. Google 전용 계정의 재인증은 로그인 시각을 확인하지 못한다

Google로만 가입한 회원은 탈퇴 직전에 Google 로그인을 한 번 더 거친다([domain/accounts.md "Google 재인증"](domain/accounts.md#google-재인증)). 연결된 계정인지는 확인하지만, Google이 로그인 시각(`auth_time`)을 주지 않아 **이 브라우저에 Google 로그인이 살아 있으면 계정을 고르는 클릭만으로 통과한다**(서버 로그 `google reauth without auth_time`).

시각까지 확인하게 하는 법은 [ENV.md](ENV.md#google-oauth) "Google OAuth" 4번이다. Google 앱 쪽 조건 없이 `GOOGLE_REAUTH_REQUIRE_AUTH_TIME=true`만 켜면 Google 전용 회원은 탈퇴할 수 없다.

### 7. 그 밖에

- **결제 우회는 꺼 둔다.** 서버 `ALLOW_PAYMENT_BYPASS`와 클라이언트 `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS`는 프리뷰·프로덕션 모두 `false`다. 켜면 토스 결제창 없이 마일스톤을 결제 완료로 만드는 `POST /api/payments/dev-complete`가 열리고, 돈을 받지 않고 결제가 끝난다. 그래서 프리뷰에서도 결제는 토스페이먼츠 테스트 결제창으로 한다.
- **프로필·포트폴리오 이미지는 공개 버킷**(`workbridge`)에 추측하기 어려운 키로 저장되고 공개 URL로 나간다. 공개 프로필에 보이는 이미지라 의도된 것이다. 메시지·결과물 첨부는 3번의 비공개 버킷이다.
- **지급 계좌번호는 저장할 때 암호화**한다(위 "지급 계좌 암호화 키"). 응답·로그·정산에는 마스킹한 값만 나간다. 예금주는 프로필 이름과만 비교한다.
- 로그는 한 줄 JSON이고 `error`만 stderr로 간다. `LOG_LEVEL`로 기준을 정한다.
