# 환경변수

변수마다 뜻, 형식, 예시 값은 각 패키지의 `.env.example` 주석에 있다(`workbridge-server/.env.example`,
`workbridge-client/.env.example`). 서버 코드가 값을 읽는 방식(필수 여부, 기본값)은 `workbridge-server/src/env.ts`가 정한다.
이 문서는 그 두 곳에 적을 수 없는 것만 다룬다. 값을 환경마다 어디에 넣는지와, 코드 밖에서 해야 하는 외부 서비스 설정이다.
환경(로컬, CI, 프리뷰, 프로덕션)의 구분은 [DEPLOYMENT.md](DEPLOYMENT.md#환경)에 있다.

## 어디에 넣나

**로컬.** 서버는 `workbridge-server/.env`, 클라이언트는 `workbridge-client/.env.local`에 넣는다. 각 패키지의
`.env.example`을 복사해 시작한다. 서버 테스트(`vitest.config.ts`)와 E2E(`scripts/e2e.sh`)는 DB 주소 같은 주요 값을
직접 정해 덮어쓴다. 서버는 시작할 때 `dotenv`로 `workbridge-server/.env`를 읽으므로, 테스트와 E2E가 덮어쓰지 않은 값은
그 파일의 값이 그대로 쓰인다.

**프리뷰·프로덕션.** Vercel의 서버 프로젝트와 클라이언트 프로젝트에 각각 넣는다. 한 프로젝트 안에서 Preview 환경과
Production 환경에 따로 넣는다. 프리뷰와 프로덕션은 서로 다른 Supabase 프로젝트를 쓰기 때문에, DB 연결 문자열과 Supabase 값과
지급 계좌 암호화 키는 환경마다 다르다. `PROXY_SHARED_SECRET`은 서버와 클라이언트 두 프로젝트에 같은 값을 넣는다.
배포한 뒤 주소에 맞춰 고칠 값은 [DEPLOYMENT.md "배포 후 업데이트"](DEPLOYMENT.md#배포-후-업데이트)에 있다.

**GitHub 리포지토리 시크릿.** 원격 DB나 비밀값이 필요한 워크플로가 쓴다. 환경은 `PREVIEW_`와 `PROD_` 접두어로 나눈다.
앱 변수를 옮겨 담은 시크릿은 그 환경의 Vercel 서버 값과 **같은 값**이어야 한다.

| 시크릿 | 쓰는 워크플로 | 같아야 하는 Vercel 서버 값 |
| --- | --- | --- |
| `PREVIEW_DIRECT_URL`, `PROD_DIRECT_URL` | `migrate.yml`, `seed.yml`, `payout-encrypt.yml`, `attachments-migrate.yml` | `DIRECT_URL` |
| `PREVIEW_PAYOUT_ACCOUNT_ENCRYPTION_KEY`, `PROD_PAYOUT_ACCOUNT_ENCRYPTION_KEY` | `seed.yml`, `payout-encrypt.yml` | `PAYOUT_ACCOUNT_ENCRYPTION_KEY` |
| `PREVIEW_SUPABASE_URL`, `PROD_SUPABASE_URL`, `PREVIEW_SUPABASE_SECRET_KEY`, `PROD_SUPABASE_SECRET_KEY` | `attachments-migrate.yml` | `SUPABASE_URL`, `SUPABASE_SECRET_KEY` |
| `PROD_INTERNAL_JOB_TOKEN` | `jobs.yml` | 프로덕션의 `INTERNAL_JOB_TOKEN` |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude.yml`, `claude-code-review.yml` | 없음. Claude Code 액션의 인증 토큰이다 |

## E2E

`bash scripts/e2e.sh`는 서버와 클라이언트의 변수를 스크립트 안에서 직접 정한다. 호출한 셸의 `DATABASE_URL`은 읽지 않는다.
바꿀 수 있는 `E2E_*` 변수는 스크립트 머리 주석에 있다. 스크립트는 대상 DB를 마이그레이션하고 시드하면서 **모든 테이블을
비운다.** 그래서 `E2E_DB`나 `E2E_DATABASE_URL`을 다른 용도의 DB로 가리키지 않는다. 이미 떠 있는 앱에 Playwright만 돌리는
`E2E_BASE_URL`은 [workbridge-client/e2e/README.md](../workbridge-client/e2e/README.md)에 있다.

## 외부 서비스 설정

### Supabase

프리뷰와 프로덕션 Supabase 프로젝트마다 한 번씩 한다.

1. 프로젝트 설정의 API 키 화면에서 프로젝트 URL과 Secret key(`sb_secret_`로 시작)를 복사해 `SUPABASE_URL`,
   `SUPABASE_SECRET_KEY`에 넣는다.
2. 연결 문자열 화면에서 Transaction pooler(포트 6543) 주소를 `DATABASE_URL`에, Session pooler(포트 5432) 주소를
   `DIRECT_URL`에 넣는다. 붙일 옵션은 `workbridge-server/.env.example`의 `DATABASE_URL` 주석을 따른다.
3. Storage에서 `workbridge` 버킷을 **Public**으로 만든다. 프로필 이미지와 포트폴리오 이미지를 둔다.
4. Storage에서 `workbridge-attachments` 버킷을 만들고 **Public은 끈다.** 메시지 첨부와 마일스톤 결과물 첨부를 둔다.
   다른 이름을 쓰면 그 이름을 `SUPABASE_ATTACHMENT_BUCKET`에 넣는다. 버킷 설정은 다음과 같이 둔다.
   - File size limit: `10 MB`
   - Allowed MIME types: `image/*`, `application/pdf`, `application/zip`, `application/x-zip-compressed`, `text/plain`,
     `application/msword`, `application/vnd.ms-excel`, `application/vnd.ms-powerpoint`,
     `application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
     `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
     `application/vnd.openxmlformats-officedocument.presentationml.presentation`, `application/x-hwp`

   이 목록은 `workbridge-server/src/lib/attachmentStorage.ts`의 허용 목록과 맞춘다. Supabase는 `image/*`처럼 하위
   유형 전체를 가리키는 와일드카드만 받는다. `…officedocument.*` 같은 부분 와일드카드는 거부하므로 Office 형식을 하나씩
   적는다. 서버도 같은 정책을 검사한다. 버킷 제한은 브라우저가 서명 URL로 직접 올리는 단계를 막는 두 번째 방어선이다.

   Storage 정책(RLS)은 추가하지 않는다. Secret key로 버킷에 접근하는 것은 서버뿐이고, 브라우저는 서버가 발급한 서명 URL로만
   올리고 내려받기 때문이다.

### Google OAuth

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트를 만든다.
2. APIs & Services > Credentials에서 OAuth 2.0 클라이언트 ID를 만든다. 값은 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`에
   넣는다.
3. 승인된 리디렉션 URI에 `GOOGLE_CALLBACK_URL`과 같은 값을 추가한다. 로컬은
   `http://localhost:3000/api/auth/google/callback`이고, 배포한 환경은 그 프론트엔드 주소의 같은 경로다.
4. (재인증의 로그인 시각) Google Auth Platform > Settings > Advanced Settings에서 **Session age claims**를 켠다. Google은
   앱이 게시되고(Audience가 In production) 인증된(Verification Center가 Verified) 경우에만 ID 토큰에 로그인 시각
   `auth_time`을 넣는다. 켠 뒤 실제 Google 왕복에서 `auth_time`이 오는 것을 확인하고 서버의
   `GOOGLE_REAUTH_REQUIRE_AUTH_TIME`을 `true`로 둔다. 프로덕션의 현재 상태는 [DEPLOYMENT.md "Google 전용 계정의 재인증은 로그인 시각을
   확인하지 못한다"](DEPLOYMENT.md#6-google-전용-계정의-재인증은-로그인-시각을-확인하지-못한다)에 있다.

### 토스페이먼츠

1. [토스페이먼츠 개발자센터](https://developers.tosspayments.com/)에서 테스트 키를 발급받는다.
2. 클라이언트 키(`test_ck_`로 시작)는 클라이언트의 `NEXT_PUBLIC_TOSS_CLIENT_KEY`에, 시크릿 키(`test_sk_`로 시작)는 서버의
   `TOSS_SECRET_KEY`에 넣는다.
