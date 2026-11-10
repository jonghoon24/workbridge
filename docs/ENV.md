# 환경변수

환경(로컬, CI, 프리뷰, 운영)의 구분은 [DEPLOYMENT.md](DEPLOYMENT.md#환경)에 있다. 프리뷰와 운영은 Vercel의 Preview·Production 환경에 각각 값을 넣고, DB 변수는 각 환경의 Supabase 프로젝트를 가리킨다.

## 서버 (.env)

| 변수 | 설명 |
| --- | --- |
| `PORT` | 서버 포트 (기본 4000) |
| `DATABASE_URL` | PostgreSQL 연결 문자열 (Supabase Transaction mode 포트 6543 권장). Vercel(프리뷰·운영)에서는 끝에 `&connection_limit=3`을 붙인다(필요하면 `&pool_timeout=10`도). 없으면 Prisma가 함수 인스턴스마다 `CPU 수 × 2 + 1`개 연결을 열어, 인스턴스가 늘 때 Supavisor 연결 한도에 먼저 닿는다. `1`은 권하지 않는다: `Promise.all([findMany, count])`가 직렬화되고, 트랜잭션 안에서 루트 `prisma`를 쓰는 헬퍼가 있으면 풀을 기다리다 멈춘다. 로컬은 붙이지 않아도 된다 |
| `DIRECT_URL` | pgbouncer를 거치지 않는 직접 연결 문자열. `prisma migrate`가 쓴다(`schema.prisma`의 `directUrl`). 로컬에서는 `DATABASE_URL`과 같게 둔다 |
| `NODE_ENV` | `production`이면 `app.listen()`과 개발 작업 워커를 시작하지 않고(Vercel), CORS 기본 허용 목록에서 `http://localhost:3000`을 뺀다. `VERCEL_ENV`가 없을 때 `production`이면 API 문서도 끈다(아래 `VERCEL_ENV`). 테스트는 `test` |
| `JWT_ACCESS_SECRET` | Access Token 서명 시크릿 |
| `JWT_REFRESH_SECRET` | Refresh Token 서명 시크릿 |
| `JWT_ACCESS_EXPIRES_IN` | Access Token 만료 시간 (기본 15m) |
| `JWT_REFRESH_EXPIRES_IN` | Refresh Token 만료 시간 (기본 7d) |
| `GOOGLE_CLIENT_ID` | Google OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 클라이언트 시크릿 |
| `GOOGLE_CALLBACK_URL` | Google OAuth 콜백 URL. 프론트엔드 `/api/auth/google/callback` URL 사용 |
| `OPENAI_API_KEY` | OpenAI API 키. **모듈을 읽을 때 클라이언트를 만들므로 비어 있으면 서버가 뜨지 않는다**(테스트처럼 더미 값이면 된다) |
| `TOSS_SECRET_KEY` | 토스페이먼츠 시크릿 키 (test_sk_...) |
| `ALLOW_PAYMENT_BYPASS` | 로컬·E2E에서 `true`로 설정하면 토스 결제창 없이 결제 완료 처리 가능. 실제 운영 서비스에서는 `false` 유지 |
| `CLIENT_URL` | 프론트엔드 URL. CORS 허용 출처이자 OAuth 리디렉션 대상이다. CORS와 메일 링크는 쉼표 목록을 받지만, **OAuth 리디렉션은 값을 그대로 이어 붙인다**(`${CLIENT_URL}/auth/callback…`). 그래서 쉼표 목록이면 OAuth 리디렉션이 깨진다 — 여러 출처가 필요하면 `CLIENT_URL`은 하나로 두고 나머지는 `CORS_ORIGINS`에 둔다. 메일 본문 링크의 기준 주소는 **첫 항목**에서 끝의 `/`를 뗀 값이다(비어 있으면 `http://localhost:3000`). 비어 있으면 OAuth 리디렉션이 `undefined/…`가 된다. 단일 출처로 정리하고 값이 없을 때 분명한 오류를 내는 일은 [#49](https://github.com/jonghoon24/workbridge/issues/49) |
| `CORS_ORIGINS` | `CLIENT_URL` 외에 허용할 출처(쉼표 구분, 선택). 개발 환경에서는 `http://localhost:3000`이 항상 허용된다 |
| `SUPABASE_URL` | Supabase 프로젝트 URL. `OPENAI_API_KEY`처럼 모듈을 읽을 때 쓰이므로 서버를 띄우려면 필요하다(더미 값 가능) |
| `SUPABASE_SECRET_KEY` | Supabase Secret Key (sb_secret_...). 모듈을 읽을 때 쓰인다(위와 같음) |
| `PAYOUT_ACCOUNT_ENCRYPTION_KEY` | 지급 계좌번호를 저장할 때 쓰는 AES-256-GCM 키. **32바이트를 base64로** 넣는다(`openssl rand -base64 32`). 암호화·복호화할 때마다 읽으므로 없어도 서버는 뜨지만, 지급 계좌 등록, 계좌가 있는 사용자의 계좌 조회, 지급 작업이 500·작업 실패가 되고 시드(`npm run db:seed`)는 아무것도 지우기 전에 멈춘다. 환경마다 다른 키를 쓰고, 한 환경 안에서는 Vercel 서버와 GitHub 시크릿(`PREVIEW_`/`PROD_PAYOUT_ACCOUNT_ENCRYPTION_KEY`, `seed.yml`·`payout-encrypt.yml`)이 같은 값이어야 한다. **바꾸거나 잃으면 저장된 계좌번호를 읽지 못한다** — 교체 절차는 [DEPLOYMENT.md](DEPLOYMENT.md#지급-계좌-암호화-키). 테스트(`vitest.config.ts`)와 E2E(`scripts/e2e.sh`)는 고정된 더미 키를 쓴다 |
| `LOG_LEVEL` | 로그 레벨 `debug`/`info`/`warn`/`error`/`silent` (기본 `info`). JSON 한 줄씩 출력하며 `error`만 stderr로 간다. 테스트는 `error` |
| `TRUST_PROXY` | Express `trust proxy` 값. 설정하면 `X-Forwarded-For`에서 신뢰한 프록시를 뺀 주소를 클라이언트 IP(레이트 리밋 키)로 쓴다. 비우면 소켓 주소를 쓰고 `X-Forwarded-For`는 무시. Next.js 프록시는 받은 `X-Forwarded-For`를 그대로 넘기므로 `loopback`은 **Next 포트(:3000)에 신뢰하는 클라이언트만 닿을 때만 안전하다**. 그렇지 않으면 클라이언트가 헤더로 자기 IP를 골라 로그인 제한을 우회한다. 로컬 로그인은 어차피 전부 루프백 한 주소로 세어진다 |
| `PROXY_SHARED_SECRET` | Next.js 프록시와 함께 쓰는 비밀값. 클라이언트의 같은 이름 변수와 **같은 값**이어야 한다. 요청의 `X-Proxy-Secret`이 이 값과 같을 때만(상수 시간 비교) `X-Client-IP`를 클라이언트 IP로 믿는다(`src/lib/clientIp.ts`). 비우면 `X-Client-IP`를 언제나 무시하고, Vercel에서는 `X-Vercel-Forwarded-For`, 그 밖에는 `req.ip`(`TRUST_PROXY`)를 쓴다. 로컬은 비워 둔다. 값은 `python3 -c "import secrets;print(secrets.token_urlsafe(48))"`로 만든다 |
| `RATE_LIMIT_ENABLED` | `false`면 레이트 리밋(로그인, AI 단가 분석)을 끈다. 기본 켜짐. 요청마다 읽는다. 로컬에서 로그인을 여러 번 하는 수동 확인·스크립트는 `false`로 둔다(머신 전체가 15분에 20회를 나눠 쓴다) |
| `INTERNAL_JOB_TOKEN` | `POST /api/internal/jobs/run`의 `X-Internal-Token` 값. 비우면 엔드포인트가 404(존재를 숨김) |
| `JOB_PAYOUT_ENABLED` | 정확히 `true`일 때만 `settlement.payout`(정산 지급) 작업을 실행한다. 그 밖에는 러너가 이 작업을 가져가지 않아 `PENDING`으로 남는다(나중에 켜면 그때 지급된다). **기본 꺼짐.** 지금 있는 지급 provider(`LogPayoutProvider`)는 돈을 보내지 않고 정산을 `PAID`로 만들기 때문에, 실제 이체 provider를 연결하기 전에는 운영에서 켜지 않는다. 로컬은 `true`(`.env.example`). 러너가 돌 때마다 읽는다(`src/jobs/gates.ts`) |
| `JOB_EMAIL_ENABLED` | 정확히 `true`일 때만 `notification.email`(알림 메일과 미확인 메시지 요약 메일) 작업이 메일을 보낸다. 그 밖에는 작업이 delivery를 `SKIPPED`로 끝낸다(나중에 켜도 밀린 메일은 나가지 않는다). **기본 꺼짐.** 지금 메일 provider는 로그 전용이라 받는 주소와 본문 전체가 운영 로그에 남으므로([#26](https://github.com/jonghoon24/workbridge/issues/26)), 실제 메일 provider를 연결하기 전에는 운영에서 켜지 않는다. 로컬은 `true`(`.env.example`, 로그에만 쓴다). 발송마다 읽는다 |
| `JOB_WORKER_ENABLED` | `false`면 개발 서버(`npm run dev`)가 작업 큐 워커를 띄우지 않는다. 기본 켜짐. 운영과 테스트에서는 어차피 뜨지 않는다 |
| `JOB_POLL_INTERVAL_MS` | 개발 워커의 폴링 간격(ms, 기본 5000) |
| `MILESTONE_AUTO_APPROVE_DAYS` | 산출물 제출 후 자동 승인까지의 일수(양의 정수, 기본 7). 24시간 단위로 센다. 양의 정수가 아니면 7 |
| `MAIL_PROVIDER` | 이메일 발송 provider. 비우거나 `log`면 로그 provider로, 메일을 보내지 않고 받는 주소와 본문 전체를 `info` 로그 `mail.sent` 한 줄로 남긴다(개발용. 실제 provider는 미정: [#26](https://github.com/jonghoon24/workbridge/issues/26)). 실제 메일 서비스는 연결돼 있지 않다. 그 밖의 값은 지원하지 않아 서버·`jobs:run`·`jobs:worker` 시작 때 `warn` 한 줄을 남기고, 발송마다 해당 delivery가 `FAILED`가 된다. 발송할 때마다 읽는다 |
| `MAIL_FROM` | 이메일 발신자(기본 `WorkBridge <no-reply@workbridge.local>`). 메일 본문의 링크 기준 주소는 `CLIENT_URL`이다 |
| `SENTRY_DSN` | Sentry DSN(선택). 비우면 오류 보고가 꺼지고 `@sentry/node`를 아예 불러오지 않는다. 설정하면 500 응답과 최종 실패한 작업만 보낸다([DEPLOYMENT.md](DEPLOYMENT.md#sentry)). 호출마다 읽는다 |
| `SENTRY_ENVIRONMENT` | Sentry `environment`(선택). 비우면 `VERCEL_ENV` → `NODE_ENV` → `development` 순으로 정한다. `release`는 Vercel이 넣어 주는 `VERCEL_GIT_COMMIT_SHA`가 있으면 그 값이다 |
| `VERCEL_ENV` | Vercel이 넣는다(직접 넣지 않는다). API 문서(`GET /api/docs`, `GET /api/openapi.json`)는 허용 목록으로 켠다: `VERCEL_ENV`가 `preview`·`development`이거나, `VERCEL_ENV`가 없고 `NODE_ENV`가 `production`이 아닐 때(로컬·테스트)만 열린다. 그 밖(`production`, 모르는 값, `VERCEL_ENV` 없이 `NODE_ENV=production`)에서는 꺼져 경로가 없는 것처럼 404다. 문서에 내부 엔드포인트와 모든 오류 메시지가 있어서다. 요청마다 읽는다 |

작업 큐는 개발 서버 워커 외에 `npm run jobs:run`(한 번 실행)과 `npm run jobs:worker`(단독 워커)로도 돌릴 수 있다. 운영(Vercel)에는 상주 워커가 없고, GitHub Actions(`.github/workflows/jobs.yml`)가 15분마다 운영 서버의 `POST /api/internal/jobs/run`을 부른다. 이 워크플로는 리포지토리 시크릿 `PROD_INTERNAL_JOB_TOKEN`(운영 서버의 `INTERNAL_JOB_TOKEN`과 같은 값)을 쓴다([DEPLOYMENT.md](DEPLOYMENT.md#1-작업-큐는-15분마다-돈다)).

## 클라이언트 (.env.local)

| 변수 | 설명 |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | 백엔드 API URL (기본 http://localhost:4000) |
| `API_URL` | 서버 쪽(Next 프록시 라우트와 SSR)에서만 쓰는 백엔드 URL. 있으면 `NEXT_PUBLIC_API_URL`보다 먼저 쓴다(선택) |
| `PROXY_SHARED_SECRET` | 서버 쪽 전용(`NEXT_PUBLIC_` 아님). 서버의 같은 이름 변수와 같은 값. Vercel(`VERCEL=1`)에서 이 값이 있으면 Next 프록시가 브라우저 IP(Vercel 엣지가 덮어쓴 `X-Vercel-Forwarded-For`)를 `X-Client-IP`로, 이 값을 `X-Proxy-Secret`으로 백엔드에 보낸다. 로컬은 비워 둔다 |
| (프리뷰 백엔드 주소) | 프리뷰에서는 Vercel Related Projects(`workbridge-client/vercel.json`)가 넣어 주는 `VERCEL_RELATED_PROJECTS`로 같은 브랜치의 서버 프리뷰를 찾는다. 환경변수로 넣을 것은 없다. 우선순위는 `API_URL` 다음, `NEXT_PUBLIC_API_URL` 앞이다([DEPLOYMENT.md](DEPLOYMENT.md#프론트엔드)) |
| `NEXT_PUBLIC_TOSS_CLIENT_KEY` | 토스페이먼츠 클라이언트 키 (test_ck_...) |
| `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS` | 로컬·E2E에서 `true`로 설정하면 결제 페이지에 개발용 결제 완료 버튼 표시. 실제 운영 서비스에서는 `false` 유지 |

## E2E (`scripts/e2e.sh`)

`bash scripts/e2e.sh`는 서버·클라이언트 변수를 스크립트 안에서 직접 정하고(더미 키, 결제 우회 켬, 작업 워커와 요청 제한 끔) 호출한 셸의 `DATABASE_URL`은 읽지 않는다. 바꿀 수 있는 것은 아래뿐이고 모두 선택이다.

| 변수 | 설명 |
| --- | --- |
| `E2E_DB` | DB 이름 (기본 `workbridge_e2e`). **시드가 모든 테이블을 비우므로** 다른 DB를 가리키지 않는다 |
| `E2E_DATABASE_URL` | Postgres 전체 URL (기본 `postgresql://$USER@localhost:5432/$E2E_DB`). CI는 서비스 컨테이너 주소를 넣는다 |
| `E2E_SERVER_PORT` / `E2E_CLIENT_PORT` | API·클라이언트 포트 (기본 4002 / 3002) |
| `E2E_CLIENT_MODE` | `dev`(`next dev`) 또는 `prod`(`next build && next start`). 기본은 `CI=true`면 `prod`, 아니면 `dev` |
| `E2E_SKIP_SEED` | `1`이면 마이그레이션과 시드를 건너뛰고 지금 DB를 그대로 쓴다 |
| `E2E_LOG_DIR` | 서버·클라이언트 로그 위치 (기본 `workbridge-client/test-results/e2e-logs`) |
| `E2E_BASE_URL` | Playwright가 여는 클라이언트 주소. 스크립트가 `http://localhost:$E2E_CLIENT_PORT`로 정한다. 이미 떠 있는 앱에 `npm run e2e`(클라이언트)로 직접 돌릴 때만 넣는다 (기본 `http://localhost:3002`) |

## 외부 서비스 설정

### Supabase

1. 프로젝트 생성 후 Settings > API에서 URL과 Secret Key 복사
2. Storage에서 `workbridge` 버킷 생성 (Public으로 설정)
3. DATABASE_URL은 Settings > Database > Connection String에서 Transaction mode (포트 6543) 사용

### Google OAuth

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트 생성
2. APIs & Services > Credentials에서 OAuth 2.0 클라이언트 ID 생성
3. 승인된 리디렉션 URI에 `http://localhost:3000/api/auth/google/callback` 추가

### 토스페이먼츠

1. [토스페이먼츠 개발자센터](https://developers.tosspayments.com/)에서 테스트 키 발급
2. 클라이언트 키 (`test_ck_...`)와 시크릿 키 (`test_sk_...`) 확인

### 결제 우회 테스트

실제 결제창을 사용할 수 없는 로컬·E2E 환경에서는 서버 `.env`의 `ALLOW_PAYMENT_BYPASS=true`와 클라이언트 `.env.local`의 `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS=true`를 함께 설정합니다. 결제 페이지에서 "개발용 결제 완료 처리"를 누르면 서버가 그 마일스톤의 개발용 완료 결제 레코드를 만들고 마일스톤을 결제 완료(`FUNDED`)로 바꿉니다(`POST /api/payments/dev-complete`, 마일스톤 순서대로). 이후 프리랜서가 산출물을 제출하고 의뢰인이 승인하면, 마지막 마일스톤 승인 때 계약이 자동으로 완료되어 리뷰를 쓸 수 있습니다. 실제 운영 서비스에서는 두 값을 모두 `false`로 유지합니다.

### OpenAI

1. [OpenAI Platform](https://platform.openai.com/)에서 API 키 발급
