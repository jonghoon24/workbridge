# 환경변수

환경(로컬, CI, 프리뷰, 운영)의 구분은 [DEPLOYMENT.md](DEPLOYMENT.md#환경)에 있다. 기본값과 로컬 예시 값은 `.env.example`
(서버 `workbridge-server/`, 클라이언트 `workbridge-client/`)과 `workbridge-server/src/env.ts`가 원본이다.

어디에 넣나:

- **로컬**: 서버 `workbridge-server/.env`, 클라이언트 `workbridge-client/.env.local`(각 `.env.example`을 복사). 테스트는
  `vitest.config.ts`가, E2E는 `scripts/e2e.sh`가 값을 직접 정한다.
- **프리뷰·운영**: Vercel 서버·클라이언트 프로젝트의 Preview·Production 환경에 각각 넣는다. 프리뷰와 운영은 서로 다른
  Supabase 프로젝트라 DB·Supabase 변수와 암호화 키가 환경마다 다르다.
- **GitHub 리포지토리 시크릿**: 원격 DB와 비밀값이 필요한 워크플로가 쓴다. `PREVIEW_`/`PROD_` 접두어로 환경을 나눈다 —
  `*_DIRECT_URL`(`migrate.yml`, `seed.yml`, `payout-encrypt.yml`, `attachments-migrate.yml`),
  `*_PAYOUT_ACCOUNT_ENCRYPTION_KEY`(`seed.yml`, `payout-encrypt.yml`), `*_SUPABASE_URL`·`*_SUPABASE_SECRET_KEY`
  (`attachments-migrate.yml`), `PROD_INTERNAL_JOB_TOKEN`(`jobs.yml`). 그 환경의 Vercel 서버 값과 **같은 값**이어야 한다
  (예: `PROD_INTERNAL_JOB_TOKEN` = 운영 `INTERNAL_JOB_TOKEN`).

## 서버 (.env)

| 변수 | 설명 |
| --- | --- |
| `PORT` | 서버 포트 |
| `DATABASE_URL` | PostgreSQL 연결 문자열(Supabase는 Transaction mode 6543). Vercel(프리뷰·운영)에서는 끝에 `&connection_limit=3`을 붙인다(필요하면 `&pool_timeout=10`도). 없으면 Prisma가 함수 인스턴스마다 `CPU 수 × 2 + 1`개 연결을 열어, 인스턴스가 늘 때 Supavisor 연결 한도에 먼저 닿는다. `1`은 권하지 않는다: `Promise.all([findMany, count])`가 직렬화되고, 트랜잭션 안에서 루트 `prisma`를 쓰는 헬퍼가 있으면 풀을 기다리다 멈춘다. 로컬은 붙이지 않아도 된다 |
| `DIRECT_URL` | pgbouncer를 거치지 않는 직접 연결(Supabase Session mode 5432). `prisma migrate`가 쓴다(`schema.prisma`의 `directUrl`). 로컬에서는 `DATABASE_URL`과 같게 둔다 |
| `NODE_ENV` | `production`이면 `app.listen()`과 개발 작업 워커를 시작하지 않고(Vercel), CORS 기본 허용 목록에서 `http://localhost:3000`을 뺀다. API 문서 게이트에도 쓰인다(아래 `VERCEL_ENV`) |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | 액세스·리프레시 토큰 서명 시크릿 |
| `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` | 토큰 만료 시간 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth 클라이언트 |
| `GOOGLE_CALLBACK_URL` | Google OAuth 콜백. 백엔드가 아니라 **프론트엔드**의 `/api/auth/google/callback` URL이다(Next 프록시가 받아 서버로 넘긴다) |
| `OPENAI_API_KEY` | OpenAI API 키. **모듈을 읽을 때 클라이언트를 만들므로 비어 있으면 서버가 뜨지 않는다**(테스트처럼 더미 값이면 된다) |
| `TOSS_SECRET_KEY` | 토스페이먼츠 시크릿 키(`test_sk_...`) |
| `ALLOW_PAYMENT_BYPASS` | `true`면 토스 결제창 없이 결제 완료 처리(`POST /api/payments/dev-complete`). 로컬·E2E 전용이고 **프리뷰·운영에서는 반드시 `false`**(아래 "결제 우회") |
| `CLIENT_URL` | 프론트엔드 **출처 하나**(끝의 `/`는 괜찮다). Google 로그인 리디렉션, 메일 본문 링크, CORS 허용 출처가 모두 이 값을 쓴다(`src/lib/clientUrl.ts`). 목록·경로·스킴 없는 값은 받지 않는다. 비었거나 이런 형태면 서버는 뜨지만 시작 때 `warn`을 남기고, 브라우저 요청이 CORS로 막히며, Google 로그인은 500, 메일은 발송 기록이 `FAILED`가 된다 |
| `CORS_ORIGINS` | `CLIENT_URL` 외에 허용할 출처(쉼표 구분, 선택). 추가 출처(예: 커스텀 도메인)는 `CLIENT_URL`이 아니라 여기에 둔다 |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Supabase 프로젝트 URL과 Secret Key(`sb_secret_...`). 모듈을 읽을 때 쓰이므로 서버를 띄우려면 필요하다(더미 값 가능). 비공개 첨부 버킷의 서명 URL 발급과 파일 확인·삭제에도 쓴다 |
| `SUPABASE_ATTACHMENT_BUCKET` | 메시지·결과물 첨부를 두는 **비공개** Storage 버킷 이름. 기본 이름으로 버킷을 만들면 넣지 않아도 된다. 프로필·포트폴리오 이미지는 공개 버킷 `workbridge`에 둔다(아래 "Supabase") |
| `PAYOUT_ACCOUNT_ENCRYPTION_KEY` | 지급 계좌번호 암호화 키(32바이트 base64, `openssl rand -base64 32`). 없어도 서버는 뜨지만 지급 계좌 등록·조회와 지급 작업이 실패하고, 시드는 아무것도 지우기 전에 멈춘다. 환경마다 다른 키이고 Vercel 서버와 GitHub 시크릿이 같은 값이어야 한다. **바꾸거나 잃으면 저장된 계좌번호를 읽지 못한다** — 교체 절차는 [DEPLOYMENT.md](DEPLOYMENT.md#지급-계좌-암호화-키) |
| `LOG_LEVEL` | 로그 레벨(`debug`/`info`/`warn`/`error`/`silent`). 테스트는 `error` |
| `TRUST_PROXY` | Express `trust proxy` 값. 설정하면 `X-Forwarded-For`에서 신뢰한 프록시를 뺀 주소를 클라이언트 IP(요청 제한 키)로 쓴다. 로컬은 `loopback`. `loopback`이 안전한 조건은 [DEPLOYMENT.md](DEPLOYMENT.md#5-클라이언트-ip) 5번 |
| `PROXY_SHARED_SECRET` | Next 프록시가 보낸 `X-Client-IP`를 믿기 위한 공유 비밀. 클라이언트의 같은 이름 변수와 **같은 값**이어야 한다. 비우면 `X-Client-IP`를 무시한다. 로컬은 비워 둔다. 값은 `python3 -c "import secrets;print(secrets.token_urlsafe(48))"`로 만든다([DEPLOYMENT.md](DEPLOYMENT.md#5-클라이언트-ip) 5번) |
| `RATE_LIMIT_ENABLED` | `false`면 요청 제한(로그인, AI 단가 분석)을 끈다. 로컬에서는 모든 로그인이 루프백 한 주소로 세어져 한도를 나눠 쓰므로, 로그인을 반복하는 수동 확인·스크립트는 `false`로 둔다 |
| `INTERNAL_JOB_TOKEN` | `POST /api/internal/jobs/run`의 `X-Internal-Token` 값. 비우면 엔드포인트가 404(존재를 숨김). 운영 값은 GitHub 시크릿 `PROD_INTERNAL_JOB_TOKEN`과 같아야 크론(`jobs.yml`)이 돈다 |
| `JOB_PAYOUT_ENABLED` | 정확히 `true`일 때만 `settlement.payout`(정산 지급) 작업을 실행한다. **운영에서는 꺼 둔다**(지금 지급 provider는 돈을 보내지 않고 정산을 `PAID`로 만든다). 로컬은 켠다. 꺼졌을 때의 동작과 켜는 조건은 [DEPLOYMENT.md](DEPLOYMENT.md#1-작업-큐는-15분마다-돈다) |
| `JOB_EMAIL_ENABLED` | 정확히 `true`일 때만 `notification.email` 작업이 메일을 보낸다. **운영에서는 꺼 둔다**(로그 provider가 주소와 본문을 운영 로그에 남긴다, [#26](https://github.com/jonghoon24/workbridge/issues/26)). 로컬은 켠다. 위와 같은 절 참고 |
| `JOB_WORKER_ENABLED` | `false`면 개발 서버(`npm run dev`)가 작업 큐 워커를 띄우지 않는다. 운영과 테스트에서는 어차피 뜨지 않는다 |
| `JOB_POLL_INTERVAL_MS` | 개발 워커의 폴링 간격(ms) |
| `MILESTONE_AUTO_APPROVE_DAYS` | 산출물 제출 후 자동 승인까지의 일수(양의 정수, 24시간 단위). 양의 정수가 아니면 기본값 |
| `MAIL_PROVIDER` | 이메일 provider. 비우거나 `log`면 메일을 보내지 않고 받는 주소와 본문을 `mail.sent` 로그로 남긴다. 실제 메일 서비스는 연결돼 있지 않다([DEPLOYMENT.md](DEPLOYMENT.md#4-이메일은-로그로만-나간다) 4번). 그 밖의 값은 시작 때 `warn`을 남기고 모든 발송이 `FAILED`가 된다 |
| `MAIL_FROM` | 이메일 발신자. 메일 본문의 링크 기준 주소는 `CLIENT_URL`이다 |
| `SENTRY_DSN` | Sentry DSN(선택). 비우면 오류 보고가 꺼지고 `@sentry/node`를 불러오지 않는다([DEPLOYMENT.md](DEPLOYMENT.md#sentry)) |
| `SENTRY_ENVIRONMENT` | Sentry `environment`(선택). 비우면 `VERCEL_ENV` → `NODE_ENV` → `development` 순 |
| `VERCEL_ENV` | Vercel이 넣는다(직접 넣지 않는다). API 문서(`GET /api/docs`, `GET /api/openapi.json`)는 허용 목록으로 켠다: `VERCEL_ENV`가 `preview`·`development`이거나, `VERCEL_ENV`가 없고 `NODE_ENV`가 `production`이 아닐 때(로컬·테스트)만 열린다. 그 밖(`production`, 모르는 값, `VERCEL_ENV` 없이 `NODE_ENV=production`)에서는 경로가 없는 것처럼 404다. 문서에 내부 엔드포인트와 모든 오류 메시지가 있어서다 |

## 클라이언트 (.env.local)

| 변수 | 설명 |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | 백엔드 API URL. `API_URL`도 Related Projects 값도 없을 때(로컬, CLI 배포) 쓰인다(우선순위는 `src/lib/apiUrl.js` 머리 주석) |
| `API_URL` | 서버 쪽 전용 백엔드 URL(선택). 있으면 다른 후보보다 먼저 쓴다. **프리뷰에는 넣지 않는다** — 넣으면 같은 브랜치의 서버 프리뷰를 찾는 Related Projects보다 먼저 쓰인다([DEPLOYMENT.md](DEPLOYMENT.md#프론트엔드)) |
| `PROXY_SHARED_SECRET` | 서버 쪽 전용(`NEXT_PUBLIC_` 아님). 서버의 같은 이름 변수와 같은 값. Vercel(`VERCEL=1`)에서만 Next 프록시가 브라우저 IP를 `X-Client-IP`로, 이 값을 `X-Proxy-Secret`으로 백엔드에 보낸다. 로컬은 비워 둔다 |
| `NEXT_PUBLIC_TOSS_CLIENT_KEY` | 토스페이먼츠 클라이언트 키(`test_ck_...`) |
| `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS` | `true`면 결제 페이지에 개발용 결제 완료 버튼을 보인다. 서버의 `ALLOW_PAYMENT_BYPASS`와 짝이고, **프리뷰·운영에서는 반드시 `false`** |

## E2E

`bash scripts/e2e.sh`는 서버·클라이언트 변수를 스크립트 안에서 직접 정하고 호출한 셸의 `DATABASE_URL`은 읽지 않는다.
바꿀 수 있는 `E2E_*` 변수는 스크립트 머리 주석에 있다. 스크립트는 그 DB를 마이그레이션하고 시드하므로(**모든 테이블을 비운다**)
`E2E_DB`·`E2E_DATABASE_URL`을 다른 DB로 가리키지 않는다. 이미 떠 있는 앱에 Playwright만 돌리는 `E2E_BASE_URL`은
`workbridge-client/e2e/README.md`에 있다.

## 외부 서비스 설정

### Supabase

1. 프로젝트 생성 후 Settings > API에서 URL과 Secret Key 복사
2. Storage에서 `workbridge` 버킷 생성 (Public으로 설정) — 프로필·포트폴리오 이미지
3. Storage에서 `workbridge-attachments` 버킷 생성 — 메시지·결과물 첨부. **Public은 끈다.** 버킷 설정에서
   File size limit `10 MB`, Allowed MIME types는 `image/*`, `application/pdf`, `application/zip`,
   `application/x-zip-compressed`, `text/plain`, `application/msword`, `application/vnd.ms-excel`,
   `application/vnd.ms-powerpoint`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
   `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
   `application/vnd.openxmlformats-officedocument.presentationml.presentation`, `application/x-hwp`로 둔다
   (Supabase는 `image/*` 같은 하위 유형 전체 와일드카드만 받고 `…officedocument.*` 같은 부분 와일드카드는 거부한다.
   목록은 `src/lib/attachmentStorage.ts`의 허용 목록과 맞춘다. 서버도 같은 정책을 검사하고, 버킷 제한은 서명 URL로 올리는
   단계의 두 번째 방어선이다). Storage 정책(RLS)은 추가하지 않는다: 서버만 Secret Key로 접근하고, 브라우저는 서버가 발급한
   서명 URL로만 올리고 내려받는다. 다른 이름을 쓰면 `SUPABASE_ATTACHMENT_BUCKET`에 넣는다
4. DATABASE_URL은 Settings > Database > Connection String에서 Transaction mode (포트 6543) 사용

### Google OAuth

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트 생성
2. APIs & Services > Credentials에서 OAuth 2.0 클라이언트 ID 생성
3. 승인된 리디렉션 URI에 `http://localhost:3000/api/auth/google/callback` 추가

### 토스페이먼츠

1. [토스페이먼츠 개발자센터](https://developers.tosspayments.com/)에서 테스트 키 발급
2. 클라이언트 키 (`test_ck_...`)와 시크릿 키 (`test_sk_...`) 확인

### 결제 우회

실제 결제창을 쓸 수 없는 로컬·E2E에서는 서버 `ALLOW_PAYMENT_BYPASS=true`와 클라이언트 `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS=true`를
함께 둔다. 결제 페이지의 "개발용 결제 완료 처리"가 토스 승인 없이 그 마일스톤을 결제 완료(`FUNDED`)로 만든다. 돈을 받지 않고
결제를 완료시키는 경로라서 프리뷰·운영에서는 두 값 모두 `false`다.

### OpenAI

1. [OpenAI Platform](https://platform.openai.com/)에서 API 키 발급
