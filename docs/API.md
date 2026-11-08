# API 엔드포인트

`workbridge-server`의 HTTP API 전체 목록이다(라우트 76개 + `GET /health`). 동작의 기준은 영어로 쓴 [BEHAVIOR.md](BEHAVIOR.md)이고, 이 문서는 그 요약이다. 둘이 다르면 BEHAVIOR.md가 맞다. 괄호 속 `MS13`, `D12` 같은 표기는 BEHAVIOR.md의 규칙 번호다.

## 공통 규칙

### 인증 표기

| 표기 | 뜻 |
| --- | --- |
| 공개 | 토큰 없이 호출한다 |
| 로그인 | `Authorization: Bearer <accessToken>` 필요. 없거나 잘못되면 401 |
| 로그인·활성 | 로그인에 더해 사용자 row를 다시 읽어 소프트 삭제된 사용자면 **401** `Account is no longer active` (확장 라우트, 규칙 12) |
| CLIENT / FREELANCER | 역할 제한. 다른 역할이면 **403** `Insufficient permissions` |
| 완성 프로필 | 프로필 필수 항목이 비면 **403** `프로필을 먼저 완성해주세요` (규칙 4) |
| 내부 토큰 | JWT가 아니라 `X-Internal-Token` 헤더 |

- 액세스 토큰은 15분, 리프레시 토큰은 7일이며 리프레시 토큰은 `httpOnly` 쿠키 `refreshToken`에 있다.
- 토큰이 없으면 `Authentication required`, 형식이 틀리거나 만료되면 `Invalid or expired token` (둘 다 401).

### 응답과 오류

- 모든 오류 응답은 `{ "error": { "message": "..." } }` 하나뿐이다. 500만 error 로그를 남긴다.
- 모든 응답에 `X-Request-Id` 헤더가 붙는다. 요청에 `^[A-Za-z0-9._-]{1,128}$` 형식의 값을 주면 그대로 돌려준다.
- 매칭되지 않는 경로와 메서드는 Express 기본 HTML 404다(오류 형식 예외, Q10).
- 금액 컬럼은 DB에서 `Float`지만, 확장 도메인(마일스톤·결제·정산)은 항상 원 단위 정수를 쓴다.

### 확장 라우트의 공통 순서 (규칙 12)

마일스톤, 정산, 지급 계좌, 계약 목록, 대화, 포트폴리오, 경력, 추천, 알림 설정은 다음 순서로 검사한다.

`인증 → 활성 사용자 → 역할 → (업로드) → 검증 → 존재(404) → 소유(403) → 상태(409)`

- 검증 실패는 **400** `<필드 경로>: <메시지>` (첫 실패 하나, 예: `milestones.0.amount: Amount must be a whole number of won`). 검증이 존재 확인보다 먼저이므로 없는 id에도 400이 날 수 있다.
- 쿼리의 빈 값(`?limit=`)은 없는 것으로 본다. 반복(`?limit=1&limit=2`), 소수(`1.5`), 뒤에 문자(`2abc`)는 400.
- 목록 페이지네이션: `page` 기본 1(최대 1,000,000), `limit` 기본 20(50 초과는 50으로 자름). 응답 `meta`는 `{ total, page, limit, totalPages }`.
- 기존(확장 이전) 라우트는 손으로 쓴 검증을 그대로 쓰고, 검사 순서와 메시지가 라우트마다 다르다(Q12, Q13, Q15).

### 파일 업로드 (multipart/form-data)

| 정책 | 필드 | 개수 | 크기 | 허용 형식 | 쓰는 곳 |
| --- | --- | --- | --- | --- | --- |
| 첨부 | `files` | 0~5 | 개당 10MB | 이미지, PDF, ZIP, 텍스트, Word/Excel/PowerPoint, HWP | 마일스톤 제출, 메시지 |
| 이미지 | `image` | 0~1 | 5MB | `image/*` | 포트폴리오 |
| 프로필 이미지 | `profileImage` | 0~1 | 5MB | `image/*` | `PATCH /api/users/me` (기존 라우트, 오류가 500이 될 수 있음 D6) |

확장 라우트에서 너무 큰 파일은 **413**, 형식·개수·필드 이름 오류와 깨진 multipart는 **400**, 저장소(Supabase Storage) 실패는 **502**다. 저장 키는 `<폴더>/<uuid>.<확장자>`이고 원래 파일 이름은 DB의 `fileName`에만 남는다. 파일은 공개 URL로 돌려준다(Q21). 운영(Vercel)에서는 요청 본문이 4.5MB를 넘으면 플랫폼이 막는다([DEPLOYMENT.md](DEPLOYMENT.md)).

### 요청 제한 (규칙 10)

한도를 넘으면 **429** `Too many requests. Try again later.`와 `Retry-After`(초) 헤더. `RATE_LIMIT_ENABLED=false`면 모두 끈다.

| 대상 | 키 | 윈도 | 한도 |
| --- | --- | --- | --- |
| `POST /api/auth/login` | 클라이언트 IP | 15분 | 20회(결과와 무관하게 셈) |
| `POST /api/auth/login` 실패 | 이메일(소문자·trim) + IP | 15분 | `401 Invalid credentials` 5회, 성공하면 초기화 |
| `POST /api/projects/:id/analyze` | 사용자 | 1시간 / KST 하루 | 5회 / 20회 |

---

## 상태 확인

| Method | Endpoint | 인증 | 설명 |
| --- | --- | --- | --- |
| GET | `/health` | 공개 | `{ status: "ok" }` |

## 인증 — `/api/auth`

| Method | Endpoint | 인증 | 설명 |
| --- | --- | --- | --- |
| POST | `/api/auth/signup` | 공개 | 회원가입 |
| POST | `/api/auth/login` | 공개 | 로그인 (요청 제한) |
| POST | `/api/auth/logout` | 로그인 | 로그아웃 (리프레시 쿠키 삭제) |
| POST | `/api/auth/refresh` | 공개(쿠키) | 액세스 토큰 재발급 |
| POST | `/api/auth/select-role` | 로그인 | OAuth 첫 로그인 역할 선택 |
| GET | `/api/auth/google` | 공개 | Google OAuth 시작 (302) |
| GET | `/api/auth/google/callback` | 공개 | Google OAuth 콜백 (302) |

- **`POST /signup`** — 요청 `{ email, password, name, role }`. 응답 **201** `{ accessToken, user: { id, email, name, role } }` + `refreshToken` 쿠키. 오류: 하나라도 없으면 400 `All fields are required` → `role`이 `CLIENT`/`FREELANCER`가 아니면 400 `Role must be CLIENT or FREELANCER` → 이미 쓰는 이메일 409 `Email already in use`(소프트 삭제된 계정 포함).
- **`POST /login`** — 요청 `{ email, password }`. 응답 200 `{ accessToken, user }` + 쿠키. 오류: 요청 제한 429(필드 검사보다 먼저) → 400 `Email and password are required` → 없는 이메일·비밀번호 없는 OAuth 계정·틀린 비밀번호·소프트 삭제된 계정 모두 401 `Invalid credentials`.
- **`POST /logout`** — 응답 `{ message: "Logged out successfully" }`. 토큰은 상태가 없어 이미 발급한 액세스 토큰은 만료까지 유효하다(Q1).
- **`POST /refresh`** — 쿠키의 리프레시 토큰으로 `{ accessToken }`. 리프레시 토큰은 회전하지 않는다. 오류: 쿠키 없음 401 `Refresh token not found` → 서명·만료 오류 401 `Invalid or expired refresh token` → 사용자가 없거나 삭제됨 401 `User not found`.
- **`POST /select-role`** — 요청 `{ role }`. 응답 `{ accessToken, user }`(새 역할이 담긴 토큰, 쿠키도 재발급). 오류: 400 `Role must be CLIENT or FREELANCER` → 404 `User not found` → 이미 선택함 400 `Role has already been selected`.
- **`GET /google`** — Google 동의 화면으로 302. Google 환경변수가 없으면 500(서버는 계속 돈다).
- **`GET /google/callback`** — 성공하면 `${CLIENT_URL}/auth/callback?token=…&needsRoleSelection=…`으로, 어떤 실패든 `${CLIENT_URL}/login?error=oauth_failed`로 302. 같은 이메일의 비밀번호 계정에 Google 계정을 연결한다(D5).

## 사용자 — `/api/users`

| Method | Endpoint | 인증 | 설명 |
| --- | --- | --- | --- |
| GET | `/api/users/me` | 로그인 | 내 프로필 (email 포함) |
| PATCH | `/api/users/me` | 로그인 | 내 프로필 수정 (multipart) |
| GET | `/api/users/me/applications` | 로그인 | 내 지원 목록. 프리랜서가 아니면 핸들러가 403 `Only freelancers can view their applications` |
| GET | `/api/users/me/bookmarks` | 로그인 | 내 북마크. 프리랜서가 아니면 핸들러가 403 `Only freelancers can view their bookmarks` |
| GET | `/api/users/me/projects` | 로그인 | 내 프로젝트. 의뢰인이 아니면 핸들러가 403 `Only clients can view their projects` |
| GET | `/api/users/me/payout-account` | 로그인·활성, FREELANCER | 지급 계좌 조회 |
| PUT | `/api/users/me/payout-account` | 로그인·활성, FREELANCER | 지급 계좌 등록·변경 |
| DELETE | `/api/users/me/payout-account` | 로그인·활성, FREELANCER | 지급 계좌 삭제 |
| GET | `/api/users/me/profile-completion` | 로그인·활성 | 프로필 완성도 |
| GET | `/api/users/me/recommended-projects` | 로그인·활성, FREELANCER, 완성 프로필 | 추천 프로젝트 |
| POST | `/api/users/me/portfolio` | 로그인·활성, FREELANCER | 포트폴리오 추가 (multipart 또는 JSON) |
| PUT | `/api/users/me/portfolio/order` | 로그인·활성, FREELANCER | 포트폴리오 순서 변경 |
| PATCH | `/api/users/me/portfolio/:itemId` | 로그인·활성, FREELANCER | 포트폴리오 수정 |
| DELETE | `/api/users/me/portfolio/:itemId` | 로그인·활성, FREELANCER | 포트폴리오 삭제 |
| POST | `/api/users/me/careers` | 로그인·활성, FREELANCER | 경력 추가 |
| PATCH | `/api/users/me/careers/:careerId` | 로그인·활성, FREELANCER | 경력 수정 |
| DELETE | `/api/users/me/careers/:careerId` | 로그인·활성, FREELANCER | 경력 삭제 |
| GET | `/api/users/:id` | 공개 | 공개 프로필 |
| GET | `/api/users/:id/reviews` | 공개 | 받은 리뷰 (`GET /api/reviews/users/:id`와 같음) |
| GET | `/api/users/:id/portfolio` | 공개 | 포트폴리오 목록 |
| GET | `/api/users/:id/careers` | 공개 | 경력 목록과 합계 |

`/api/users`에는 라우터 두 개가 이 순서로 붙는다: 기존 `users.routes.ts`(내 정보, 지급 계좌, 공개 프로필) 다음 `profile.routes.ts`(포트폴리오, 경력, 완성도, 추천 프로젝트). `GET /api/users/me/portfolio`나 `/me/careers`는 따로 없고, 공개 라우트에 id `me`를 준 것으로 처리돼 404 `User not found`다(PF19). 편집 화면도 자기 id로 공개 라우트를 읽는다.

### 기존 라우트

- **`GET /me`** — `{ id, email, name, role, profileImage, bio, companyName, businessField, website, skills, activityCategory, experienceYears, hourlyRate, portfolioUrl, createdAt }`. 없거나 삭제된 사용자 404 `User not found`.
- **`PATCH /me`** — multipart. 공통 `name`, `bio`, `profileImage`(파일). CLIENT는 `companyName`, `businessField`, `website`, FREELANCER는 `skills`(반복 필드 또는 쉼표 문자열, 별칭 정규화), `activityCategory`, `experienceYears`, `hourlyRate`, `portfolioUrl`. 다른 역할의 필드는 조용히 무시한다(Q2). 보낸 필드만 바뀐다. 응답은 `GET /me`와 같은 모양. `experienceYears`는 0 이상의 정수, `hourlyRate`는 유한한 숫자다. 범위를 벗어나거나 숫자가 아닌 값은 400이어야 하지만 지금은 숫자가 아니면 null로 저장되고 음수는 그대로, 소수는 잘라서 저장된다(D3), 업로드 오류는 500(D6), 소프트 삭제된 사용자도 쓸 수 있다(D12).
- **`GET /me/applications`** — 지연 스윕 후 내 지원을 최신순으로. 각 항목에 `project`(의뢰인 포함)와 `contract { id, status }`. 프리랜서가 아니면 403(문구가 미들웨어와 다름, Q14).
- **`GET /me/bookmarks`** — 북마크한 프로젝트 객체 + `isBookmarked: true`, `bookmarkedAt`. 삭제된 프로젝트는 뺀다. 프리랜서가 아니면 403.
- **`GET /me/projects`** — 지연 스윕 후 내 프로젝트(삭제 제외) 최신순, 각 `_count.applications`. 의뢰인이 아니면 403.
- **`GET /:id`** — 공개 필드(email 제외) + `receivedReviews`(최신순, 작성자 `{ id, name, profileImage }`), `avgRating`(리뷰 없으면 null), `reviewCount`, `portfolioItems`, `careers`, `careerSummary`. 없거나 삭제된 사용자 404 `User not found`.
- **`GET /:id/reviews`** — 받은 리뷰 배열(최신순, 작성자 요약). 모르는 id면 `[]`(404 아님).

### 지급 계좌 (PA1–PA7)

계좌 객체: `{ bankCode, bankName, accountNumberMasked, holderName, createdAt, updatedAt }`. 계좌번호 원문은 어떤 응답·로그에도 나오지 않는다(평문 저장, Q22).

- **`GET`** — 200 `{ payoutAccount }` (없으면 `null`).
- **`PUT`** — 요청 `{ bankCode, accountNumber, holderName }`. 은행 코드는 `004` KB국민, `088` 신한, `020` 우리, `081` 하나, `011` NH농협, `003` IBK기업, `090` 카카오뱅크, `092` 토스뱅크, `089` 케이뱅크, `023` SC제일, `031` 대구, `032` 부산. 응답 200 `{ payoutAccount, rescheduledCount }` — 보류(`ON_HOLD`)였던 내 정산이 모두 다음 수요일 10:00 지급으로 다시 잡히고 그 개수가 `rescheduledCount`다. 오류 순서:
  1. 400 `bankCode: Unknown bank code` / `accountNumber: Account number must be 10 to 14 digits`(하이픈·공백 제거 후) / `holderName: Account holder is required`
  2. 400 `Account holder must match your name` (공백·대소문자 무시하고 내 이름과 비교)
  3. 409 `Payout account cannot be changed while a payout is processing` (`PROCESSING` 정산이 있을 때)
- **`DELETE`** — 200 `{ payoutAccount: null }`, 계좌가 없어도 200. `PROCESSING` 정산이 있으면 PUT과 같은 409.

### 프로필 완성도와 추천 프로젝트

- **`GET /me/profile-completion`** — 200 `{ isComplete, percent, items: [{ key, weight, done }] }`. `isComplete`는 프로젝트 등록·지원 게이트(규칙 4)와 같고 `percent`와는 독립이다. 항목 — FREELANCER: `skills` 15, `activityCategory` 10, `experienceYears` 10, `hourlyRate` 10, `bio` 10, `profileImage` 10, `portfolio` 15, `portfolioThree` 5, `career` 10, `payoutAccount` 5. CLIENT: `companyName` 25, `businessField` 25, `bio` 15, `profileImage` 15, `website` 20. 한국어 라벨은 클라이언트가 붙인다.
- **`GET /me/recommended-projects`** — 쿼리 `limit`(기본 10, 20 초과는 20). 응답 200 `{ projects: [{ id, title, category, budget, deadline, requiredSkills, status, createdAt, client: { id, name, companyName }, score, matchedSkills }] }`. 후보는 `OPEN`, 마감 전, 삭제 안 됨, 내가 지원하지 않음, 스킬이 겹치거나 카테고리가 같은 프로젝트. 점수(100점): 스킬 커버리지 50 + 내 스킬 활용도 10 + 카테고리 20 + 최신성 10(7일까지 10, 30일에 0) + 마감 여유 10(3일 이상). 읽기 전용(지연 스윕 없음). 오류 순서: 역할 403 → 완성 프로필 403 → `limit` 400.

### 포트폴리오 (PF1–PF12)

항목 객체: `{ id, userId, title, description, url, imageUrl, role, skills, startedAt, endedAt, sortOrder, createdAt, updatedAt }`. 월 값은 `YYYY-MM` 문자열(KST 그 달 1일로 저장). 정렬: `sortOrder` 오름차순 → `createdAt` 내림차순 → `id`.

- **`POST /me/portfolio`** — multipart(`image` 파일 선택) 또는 JSON. 필드 `title`(필수, 1~100), `description`(≤2,000), `url`(http/https, ≤2,000), `role`(≤100), `skills`(최대 10개, 각 ≤50, 별칭 정규화), `startedAt`, `endedAt`(`YYYY-MM`, 이번 달 이후 불가, 끝 ≥ 시작, 끝만 있으면 400). 응답 **201** `{ item }`(맨 뒤 `sortOrder`). 오류: 업로드 413/400 → 검증 400(예 `title: Title is required`, `url: URL must be an http or https URL`, `skills: At most 10 skills are allowed`, `startedAt: Month cannot be in the future`, `endedAt: Start month is required with an end month`) → 20개 초과 409 `Portfolio is limited to 20 items` → 이미지 저장 실패 502.
- **`PATCH /me/portfolio/:itemId`** — 같은 필드 모두 선택, 보낸 필드만 바뀌고 빈 값은 `null`(제목은 지울 수 없음). 새 `image`는 교체, `removeImage=true`는 이미지 삭제, 둘 다면 400 `removeImage: Cannot upload and remove an image at once`. 응답 200 `{ item }`. 오류: 검증 400 → 404 `Portfolio item not found` → 남의 항목 403 `Not authorized` → 저장된 값과 합친 월 순서 400.
- **`DELETE /me/portfolio/:itemId`** — 하드 삭제. 200 `{ id, deleted: true }`. 404 → 403. 다른 항목의 `sortOrder`는 그대로, 이미지 파일은 지우지 않는다.
- **`PUT /me/portfolio/order`** — 요청 `{ ids: string[] }`. 내 항목을 빠짐없이 한 번씩 나열해야 하며 아니면 400 `ids: Must list each of your portfolio items exactly once`. 응답 200 `{ items }`(새 순서, `sortOrder` = 0부터의 위치).
- **`GET /:id/portfolio`** (공개) — 200 `{ items }`(최대 20, 페이지 없음). 없거나 삭제된 사용자 404 `User not found`. 의뢰인은 `[]`.

### 경력 (PF13–PF17)

경력 객체: `{ id, userId, company, position, employmentType, startDate, endDate, description, createdAt, updatedAt }`. `endDate: null`은 재직 중. `employmentType`은 `FULL_TIME`/`CONTRACT`/`FREELANCE`/`INTERN`. 정렬: 시작 달 내림차순 → 재직 중 먼저 → 끝 달 내림차순.

- **`POST /me/careers`** — JSON `{ company, position, employmentType, startDate, endDate?, description? }`. 응답 **201** `{ career }`. 오류: 검증 400(`company: Company is required`, `position: Position must be at most 100 characters`, `startDate: Month must be a YYYY-MM month`, `endDate: End month must not be before start month` 등) → 30개 초과 409 `Careers are limited to 30 entries`.
- **`PATCH /me/careers/:careerId`** — 모든 필드 선택, `endDate: null` 또는 `''`이면 재직 중. 200 `{ career }`. 검증 400 → 404 `Career not found` → 403 → 합친 월 순서 400.
- **`DELETE /me/careers/:careerId`** — 하드 삭제. 200 `{ id, deleted: true }`.
- **`GET /:id/careers`** (공개) — 200 `{ careers, careerSummary: { totalMonths, years, months } }`. 합계는 겹치거나 맞닿은 기간을 합치고 양끝 달을 포함해 센다(표시용, `experienceYears`와 무관).

## 프로젝트 — `/api/projects`

| Method | Endpoint | 인증 | 설명 |
| --- | --- | --- | --- |
| GET | `/api/projects` | 공개 | 목록 (검색/필터/정렬/페이징, 지연 스윕) |
| POST | `/api/projects` | 로그인, CLIENT, 완성 프로필 | 등록 |
| GET | `/api/projects/:id` | 공개 | 상세 (지연 스윕) |
| PATCH | `/api/projects/:id` | 로그인, CLIENT | 수정 |
| DELETE | `/api/projects/:id` | 로그인, CLIENT | 소프트 삭제 |
| PATCH | `/api/projects/:id/status` | 로그인, CLIENT | 상태 변경 |
| POST | `/api/projects/:id/analyze` | 로그인, CLIENT | AI 단가 분석 (요청 제한) |
| GET | `/api/projects/:id/bookmark` | 로그인, FREELANCER | 북마크 여부 |
| POST | `/api/projects/:id/bookmark` | 로그인, FREELANCER | 북마크 추가 |
| DELETE | `/api/projects/:id/bookmark` | 로그인, FREELANCER | 북마크 해제 |
| GET | `/api/projects/:id/recommended-freelancers` | 로그인·활성, CLIENT | 추천 프리랜서 |

**`GET /api/projects`와 `GET /api/projects/:id`는 DB에 쓴다.** 읽기 전에 마감일이 지난 `UPCOMING`/`OPEN` 프로젝트를 `CLOSED`로 바꾸고, 모집 시작일이 된 `UPCOMING`을 `OPEN`으로 바꾸고, 마감된 프로젝트의 대기 지원을 거절한다(규칙 7).

- **`GET /`** — 쿼리 `search`(제목·설명 부분 일치), `category`, `minBudget`, `maxBudget`, `skills`(별칭 확장, 하나라도 겹치면), `status`(기본 `OPEN`, `ALL|UPCOMING|OPEN|CLOSED`), `sort`(기본 `latest`, `latest|deadline|budget`), `page`(기본 1), `limit`(기본 10, 최대 50). 응답 `{ projects, meta: { total, page, limit, totalPages } }`, 각 프로젝트에 `client { id, name, companyName, profileImage }`와 `_count.applications`. 오류 400: `sort must be latest, deadline, or budget`, `status must be ALL, UPCOMING, OPEN, or CLOSED`, `page must be a positive integer`, `minBudget must be a non-negative number`, `minBudget cannot be greater than maxBudget`.
- **`POST /`** — 요청 `{ title, description, category, budget, deadline, recruitmentStartDate?, requiredSkills? }`. 모집 시작일 기본은 지금, 시작이 미래면 `UPCOMING` 아니면 `OPEN`. 응답 **201** 프로젝트. 오류 400: `All fields are required`(`budget: 0`도 여기 걸림, D15) → `deadline must be a valid date` → `recruitmentStartDate must be a valid date` → `budget must be a non-negative number` → `recruitmentStartDate cannot be after deadline`.
- **`GET /:id`** — 프로젝트 + `client`(`businessField` 포함) + `_count.applications` + `pricingAnalysis`. 없거나 삭제됨 404 `Project not found`.
- **`PATCH /:id`** — `title`, `description`, `category`, `requiredSkills`는 언제나 수정 가능. 지원이 하나라도 있으면 `budget`, `recruitmentStartDate`, `deadline` 변경은 400 `Cannot change budget or recruitment dates after applications have been submitted`. 응답 수정된 프로젝트. 404 → 403 `Not authorized`.
- **`DELETE /:id`** — 소프트 삭제, `{ message: "Project deleted successfully" }`. 404 → 403. 진행 중 계약이 있으면 409여야 하지만 지금은 지워진다(D11).
- **`PATCH /:id/status`** — 요청 `{ status }`. 허용 전이: `UPCOMING`→`OPEN|CANCELLED|CLOSED`, `OPEN`→`CANCELLED|CLOSED`, `IN_PROGRESS`→`COMPLETED|CANCELLED`(아무도 `IN_PROGRESS`를 쓰지 않음, Q5). 그 밖은 400 `Cannot transition from X to Y`. `CLOSED`로 바꾸면 한 트랜잭션에서 대기 지원을 거절하고 지원자마다 `PROJECT_STATUS_CHANGED` 알림. 404 → 403 → 400.
- **`POST /:id/analyze`** — OpenAI `gpt-4o-mini`로 기능별 단가를 추정해 `PricingAnalysis`를 upsert하고 그 row를 돌려준다(`{ features: [{ name, description, estimatedCost, rationale, duration }], totalAmount, summary, marketReference }`, `totalAmount`는 남은 기능의 합). 오류 순서: 역할 403 `Insufficient permissions`(`requireRole`이 제한기 앞) → 요청 제한 429 → 404 → 소유권 403 → 502 `AI analysis did not return a response` / `AI analysis did not return valid feature pricing`.
- **북마크** — `GET` `{ bookmarked }`, `POST` **201** `{ bookmarked: true }`(멱등, 프로젝트가 없거나 삭제되면 404 `Project not found`), `DELETE` `{ bookmarked: false }`(멱등). `GET`/`DELETE`는 프로젝트를 확인하지 않아서 삭제된 프로젝트에도 그대로 동작하고(D19), 처음부터 없던 ID를 404로 할지는 정하지 않았다(Q6).
- **`GET /:id/recommended-freelancers`** (RC3–RC5) — 쿼리 `limit`(기본 10, 최대 20). 응답 200 `{ freelancers: [{ id, name, profileImage, activityCategory, experienceYears, hourlyRate, skills, score, matchedSkills, avgRating, reviewCount, portfolioPreview: [{ id, title, imageUrl }] }] }`. 후보는 프로필을 완성했고 이 프로젝트에 지원한 적 없는 활성 프리랜서 중 요구 스킬이 겹치는 사람(요구 스킬이 없으면 전부). 점수(100점): 스킬 50 + 포트폴리오 스킬 10 + 카테고리 15 + 평점 15(리뷰 없으면 9) + 경력 연수 10. 프로젝트 상태와 무관하게 쓸 수 있고 읽기 전용이다. 오류 순서: 역할 403 → `limit` 400 → 404 `Project not found` → 남의 프로젝트 403 `Not authorized`.

## 지원 — `/api/projects` (중첩)

| Method | Endpoint | 인증 | 설명 |
| --- | --- | --- | --- |
| POST | `/api/projects/:id/applications` | 로그인, FREELANCER, 완성 프로필 | 지원 |
| GET | `/api/projects/:id/applications` | 로그인, CLIENT | 지원자 목록 |
| PATCH | `/api/projects/:projectId/applications/:appId` | 로그인, CLIENT | 수락/거절 |

- **`POST /:id/applications`** — 요청 `{ coverLetter, expectedRate, expectedDuration }`. 한 트랜잭션에서 `PENDING` 지원을 만들고 의뢰인에게 `APPLICATION_CREATED`. 응답 **201** 지원 row. 오류 순서: 400 `All fields are required` → 400 `expectedRate must be a positive number` → 400 `expectedRate must be at least 1` → 404 `Project not found` → 400 `Project is not accepting applications` → 중복 409 `You have already applied to this project`.
- **`GET /:id/applications`** — 최신순 배열, 각 `freelancer`(공개 프로필 필드), `contract { id, status }`, `project { budget }`. 페이지 없음(Q7). 404 → 403.
- **`PATCH /:projectId/applications/:appId`** — 요청 `{ status: "ACCEPTED" | "REJECTED" }`. 오류 순서: 400 `Status must be ACCEPTED or REJECTED` → 404 `Project not found` → 403 → 404 `Application not found` → 이미 처리됨 409 `This application has already been processed` → 계약 충돌 409 `A contract already exists for this project`.
  - `ACCEPTED`: 한 트랜잭션에서 지원 수락, 다른 대기 지원 거절, 계약 생성(`PENDING`, 금액 = `expectedRate`), 기본 마일스톤 1개(`전체 작업`, 금액 = 반올림한 계약 금액, 기한 = 수락일 + 30일), 프로젝트 `CLOSED`, 알림(수락 1, 거절 각자), 대화방·참여자 2명·`CONTRACT_CREATED` 시스템 메시지. 응답 `{ application, contract }`.
  - `REJECTED`: 지원 거절 + `APPLICATION_REJECTED` 알림. 응답 지원 row.

## 계약 — `/api/contracts`

| Method | Endpoint | 인증 | 설명 |
| --- | --- | --- | --- |
| GET | `/api/contracts` | 로그인·활성 | 내 계약 목록 (양쪽 역할) |
| GET | `/api/contracts/:id` | 로그인 | 계약서 조회 (당사자) |
| POST | `/api/contracts/:id/sign` | 로그인 | 서명 (당사자) |
| PATCH | `/api/contracts/:id` | 로그인 | 항상 410 (완료는 자동) |
| GET | `/api/contracts/:id/milestones` | 로그인·활성 | 마일스톤 계획 (당사자) |
| PUT | `/api/contracts/:id/milestones` | 로그인·활성, CLIENT | 마일스톤 계획 교체 (의뢰인) |
| GET | `/api/contracts/:id/conversation` | 로그인·활성 | 계약의 대화방 id와 안 읽은 수 |

계약 상태: `PENDING`(서명 대기) → `ACTIVE`(양측 서명) → `COMPLETED`(마지막 마일스톤 승인 시 자동). 다른 전이와 수동 완료는 없다. `GET /:id`, `POST /:id/sign`, `PATCH /:id`는 기존 라우트라 활성 사용자 확인과 삭제된 프로젝트 필터가 없다(D12, D21).

`milestoneSummary`: `{ count, contractAmount, fundedAmount, approvedAmount, approvedCount }` — `contractAmount`는 원 단위로 반올림한 계약 금액(계획 합계가 맞아야 하는 값), `fundedAmount`는 결제된(FUNDED 이후) 마일스톤 금액 합, `approved*`는 승인된 마일스톤만.

- **`GET /`** (CT1–CT3, MG19) — 쿼리 `status`(`PENDING|ACTIVE|COMPLETED`), `page`, `limit`. 응답 `{ contracts, meta }`, 각 `{ id, status, amount, startDate, endDate, completedAt, clientSigned, freelancerSigned, createdAt, myRole, project: { id, title, status }, counterpart: { id, name, profileImage }, milestoneSummary, unreadMessageCount }`. 프로젝트가 삭제된 계약은 뺀다. 최신순.
- **`GET /:id`** (CT4–CT6) — 계약 + `project`, `client`, `freelancer`(양쪽 email 포함, Q9), `milestones`(순서대로, 마일스톤 객체), `milestoneSummary`, `reviews`(최신순). `payment` 키는 없다. 404 `Contract not found` → 403 `Not authorized`.
- **`POST /:id/sign`** (CT7–CT10) — 본문 없음. 내 쪽 서명을 기록하고, 두 서명이 모이면 한 번만 `ACTIVE`가 되며 같은 트랜잭션에서 양쪽에 `CONTRACT_ACTIVATED`와 시스템 메시지. 다시 서명해도 멱등. 응답 `GET /:id`와 같은 모양. 오류 순서: 404 → 403 → 400 `A completed contract cannot be signed again` → (`PENDING`일 때만) 계획이 유효하지 않으면 400 `Cannot sign a contract without a valid milestone plan`(서명 기록 안 함).
- **`PATCH /:id`** (CT11) — 본문·id·호출자와 무관하게 410 `Contracts are completed automatically when every milestone is approved`. 아무것도 쓰지 않는다.
- **`GET /:id/milestones`** (MS6) — 200 `{ milestones, milestoneSummary }`. 404 `Contract not found`(프로젝트 삭제 포함) → 403.
- **`PUT /:id/milestones`** (MS7–MS10) — 계획 전체 교체. 요청 `{ milestones: [{ title, description?, amount, dueDate }] }`, 배열 순서가 `sequence`. 성공하면 한 트랜잭션에서 두 서명을 초기화하고 `endDate`를 마지막 기한으로, 기존 마일스톤을 지우고 새로 만들며, 교체 전에 서명이 있었으면 프리랜서에게 `MILESTONE_PLAN_UPDATED`. 시스템 메시지는 매번 남는다. 응답 200 `{ contract: { id, status, amount, endDate, clientSigned, freelancerSigned }, milestones }`. 오류 순서:
  1. 400 `milestones: A contract must have between 1 and 10 milestones`, `milestones.<i>.title: Title is required` / `…must be at most 100 characters`, `…description: Description must be at most 2000 characters`, `…amount: Amount must be a whole number of won` / `…Amount must be at least 10000`, `…dueDate: Due date must be a YYYY-MM-DD date` / `…Due date cannot be in the past`(KST 오늘은 허용) / `…Due dates must not decrease`
  2. 404 `Contract not found` → 3. 403 `Not authorized` → 4. `PENDING`이 아니면 409 `Milestone plan is locked once the contract is active`
  5. 합계가 다르면 400 `Milestone amounts must add up to the contract amount (N)`
- **`GET /:id/conversation`** (MG18) — 200 `{ id, unreadCount }`. 404 `Contract not found` → 403 → 대화방 없음 404 `Conversation not found`.

## 마일스톤 — `/api/milestones`

| Method | Endpoint | 인증 | 설명 |
| --- | --- | --- | --- |
| GET | `/api/milestones/:id` | 로그인·활성 | 마일스톤 상세 (당사자) |
| POST | `/api/milestones/:id/submissions` | 로그인·활성, FREELANCER | 산출물 제출 (multipart 또는 JSON) |
| POST | `/api/milestones/:id/approve` | 로그인·활성, CLIENT | 승인 |
| POST | `/api/milestones/:id/reject` | 로그인·활성, CLIENT | 반려 (수정 요청) |

마일스톤 상태: `PENDING` → (결제) `FUNDED` → (제출) `SUBMITTED` → (승인) `APPROVED` 또는 (반려) `REVISION_REQUESTED` → (재제출) `SUBMITTED`. 제출 후 7일(`MILESTONE_AUTO_APPROVE_DAYS`) 안에 승인도 반려도 없으면 작업 큐가 자동 승인한다. 마지막 마일스톤이 승인되면 계약과 프로젝트가 `COMPLETED`가 된다.

**마일스톤 객체** (MS1): `{ id, contractId, sequence, title, description, amount, dueDate, status, fundedAt, submittedAt, autoApproveAt, approvedAt, approvalType, revisionCount, createdAt, updatedAt, payment, latestSubmission, payoutPreview: { gross, fee, vat, net } }`. **제출 객체** (MS2): `{ id, milestoneId, round, message, links, decision, decisionReason, decidedAt, decidedById, autoDecided, submittedAt, attachments: [{ id, url, fileName, mimeType, size, createdAt }] }`.

공통 오류: 마일스톤이 없거나 프로젝트가 삭제됨 404 `Milestone not found`, 당사자가 아니면 403 `Not authorized`.

- **`GET /:id`** (MS11) — 마일스톤 객체 + `submissions`(회차 내림차순) + `contract { id, status, amount, clientId, freelancerId, project: { id, title } }`.
- **`POST /:id/submissions`** (MS12–MS14) — multipart `message`, `links`(반복), `files`(첨부 정책), 파일이 없으면 JSON `{ message, links }`도 받는다. 성공하면 `SUBMITTED`, 자동 승인 시각 설정, 자동 승인·리마인더 작업 예약, 의뢰인에게 `MILESTONE_SUBMITTED`. 응답 **201** `{ milestone, submission }`. 기한이 지나도 제출할 수 있다. 오류 순서: 역할 403 → 업로드 413/400 → 400 `message: Message is required` / `…at most 5000 characters` / `links: At most 5 links are allowed` / `links.<i>: Links must be http or https URLs` → 404 → 프리랜서 본인이 아니면 403 → `FUNDED`나 `REVISION_REQUESTED`가 아니면 409 `Milestone is not awaiting a submission` → 저장 실패 502.
- **`POST /:id/approve`** (MS15–MS17) — 본문 없음. 승인, 제출 결정 기록, 정산 항목 생성, 프리랜서에게 `MILESTONE_APPROVED`, 마지막이면 계약 완료와 양쪽 `CONTRACT_COMPLETED`. 응답 200 `{ milestone, contract: { id, status, completedAt } }`. 오류: 404 → 403 → `SUBMITTED`가 아니면 409 `Milestone is not awaiting review`.
- **`POST /:id/reject`** (MS18–MS19) — 요청 `{ reason }`(trim 후 10~2,000자). `REVISION_REQUESTED`, `revisionCount` +1, 자동 승인 해제, 프리랜서에게 `MILESTONE_REVISION_REQUESTED`. 응답 200 `{ milestone }`. 오류 순서: 400 `reason: Reason must be at least 10 characters` / `…at most 2000 characters` → 404 → 403 → 409 `Milestone is not awaiting review`.

## 결제 — `/api/payments`

| Method | Endpoint | 인증 | 설명 |
| --- | --- | --- | --- |
| POST | `/api/payments` | 로그인 | 마일스톤 결제 생성·재개 (의뢰인) |
| POST | `/api/payments/confirm` | 로그인 | 결제 승인 (토스 검증) |
| POST | `/api/payments/dev-complete` | 로그인 | 개발용 결제 완료 (`ALLOW_PAYMENT_BYPASS=true`일 때만) |
| GET | `/api/payments` | 로그인 | 내 결제 내역 |

**결제는 마일스톤 단위다.** 계약 하나에 결제가 여러 건이고(`Payment.milestoneId` unique), 마일스톤은 `sequence` 순서대로만 결제할 수 있다. 금액은 항상 마일스톤 금액이다. 기존 라우트라 활성 사용자 확인이 없다(D12).

- **`POST /`** (PY1–PY4) — 요청 `{ milestoneId }`(`contractId`는 무시). 응답 `{ orderId, amount, paymentId }` — 새로 만들면 **201**, 기존 `PENDING`을 이어가면 200, `FAILED`를 새 `orderId`로 되살리면 200. 오류 순서: 400 `Milestone ID is required` → 404 `Milestone not found` → 의뢰인 아님 403 `Not authorized` → 400 `Contract must be active to proceed with payment` → 400 `Earlier milestones must be funded first` → 409 `Milestone is already funded` → 409 `Payment already completed for this milestone` / `Payment cannot be created for this milestone`(환불됨). 동시 생성은 500이 날 수 있다(D13).
- **`POST /confirm`** (PY5–PY9) — 요청 `{ paymentKey, orderId, amount }`. 토스에 승인을 요청해 `DONE`과 금액 일치를 확인한 뒤, 한 트랜잭션에서 결제 `COMPLETED`와 마일스톤 `FUNDED`(프리랜서에게 `MILESTONE_FUNDED`, 기한 알림 작업 예약, 시스템 메시지). 응답 200 결제 row. 오류 순서: 400 `paymentKey, orderId, and amount are required` → 400 `Invalid payment amount` → 404 `Payment not found`(프로젝트 삭제 포함) → 403 → 409 `Payment has already been processed` → 400 `Payment amount does not match the contract amount` → 검증 실패 400 `Payment verification failed`(결제를 `FAILED`로, 원인 구분 없음 D8 — 원인은 `warn`으로 남겨야 한다).
- **`POST /dev-complete`** (PY10–PY11) — 요청 `{ milestoneId }`. 토스를 거치지 않고 결제를 `COMPLETED`(`paymentKey: dev_bypass_<milestoneId>`)로 만들고 마일스톤을 결제 처리한다. 응답 새 결제면 **201**, 기존 row를 고치면 200, 이미 완료된 재요청도 200(멱등). 오류 순서: 우회가 꺼져 있으면 403 `Payment bypass is disabled`(가장 먼저) → 400 `Milestone ID is required` → 404 → 403 → 400 `Contract must be active…` → 400 `Earlier milestones…` → 409 `Milestone is already funded` → 409 `Payment cannot be completed for a refunded milestone`.
- **`GET /`** (PY12) — 내가 낸 결제를 최신순으로. 각 `contract { …, project { id, title }, freelancer { id, name } }`, `milestone { id, sequence, title }`. 페이지 없음.

## 정산 — `/api/settlements`

| Method | Endpoint | 인증 | 설명 |
| --- | --- | --- | --- |
| GET | `/api/settlements` | 로그인·활성, FREELANCER | 내 정산 목록 |
| GET | `/api/settlements/summary` | 로그인·활성, FREELANCER | 정산 요약 |
| GET | `/api/settlements/:id` | 로그인·활성, FREELANCER | 정산 상세와 항목 |

승인된 마일스톤마다 정산 항목(`gross`, 수수료 10%, 수수료 부가세 10%, `net`, 원 단위 절사)이 생기고, 매주 월요일 03:00(KST) 배치가 지난주 항목을 프리랜서별 정산 하나로 묶어 수요일 10:00에 지급한다. 상태: `SCHEDULED` → `PROCESSING` → `PAID`, 계좌가 없으면 `ON_HOLD`(계좌 등록 시 다시 `SCHEDULED`), 이체 실패는 `FAILED`(24시간 뒤 재시도, 총 3회). 배치와 지급은 작업 큐가 돌 때만 진행된다.

**정산 객체** (S13): `{ id, freelancerId, periodStart, periodEnd, scheduledPayoutAt, status, itemCount, grossAmount, feeAmount, feeVatAmount, netAmount, payoutAttempts, bankName, accountNumberMasked, accountHolder, providerReference, failureReason, paidAt, createdAt, updatedAt }`.

- **`GET /`** (S14) — 쿼리 `status`(5개 상태 중 하나), `page`, `limit`. 응답 `{ settlements, meta }`, `periodStart` 내림차순, 항목 없이.
- **`GET /summary`** (S15) — 200 `{ unsettled: { count, gross, fee, vat, net }, scheduled: { count, net }, onHold: { count, net }, failed: { count, net }, paidTotal, nextBatchAt, nextPayoutAt, hasPayoutAccount }`. `scheduled`는 `SCHEDULED`·`PROCESSING`·재시도가 남은 `FAILED`, `failed`는 재시도가 끝난 `FAILED`.
- **`GET /:id`** (S16) — 정산 객체 + `items: [{ id, milestoneId, milestoneTitle, milestoneSequence, contractId, projectId, projectTitle, projectDeleted, grossAmount, feeRateBps, feeAmount, feeVatAmount, netAmount, approvedAt }]`(승인 순). 404 `Settlement not found` → 남의 정산 403 `Not authorized`. 프로젝트가 삭제돼도 정산은 그대로 보이고 지급된다.

## 대화 — `/api/conversations`

| Method | Endpoint | 인증 | 설명 |
| --- | --- | --- | --- |
| GET | `/api/conversations` | 로그인·활성 | 내 대화방 목록 |
| GET | `/api/conversations/unread-count` | 로그인·활성 | 안 읽은 메시지 총수 |
| GET | `/api/conversations/:id` | 로그인·활성 | 대화방 상세 (참여자) |
| GET | `/api/conversations/:id/messages` | 로그인·활성 | 메시지 목록 (커서) |
| POST | `/api/conversations/:id/messages` | 로그인·활성 | 메시지 보내기 (multipart 또는 JSON) |
| POST | `/api/conversations/:id/read` | 로그인·활성 | 읽음 처리 |
| DELETE | `/api/conversations/:id/messages/:messageId` | 로그인·활성 | 내 메시지 삭제 (5분 이내) |

계약마다 대화방이 하나 있고 참여자는 계약 당사자 둘뿐이다. 실시간 채널은 없고 클라이언트가 폴링한다(열린 대화 5초, 배지 30초). 이 절의 GET은 DB에 쓰지 않는다. 계약·마일스톤 이벤트는 시스템 메시지(`kind: SYSTEM`, `systemEvent`)로 남는다. 메시지는 인앱 알림을 만들지 않고, 10분 넘게 안 읽으면 미확인 메시지 요약 메일이 간다(대화방·수신자마다 60분에 최대 1통).

**메시지 객체** (MG4): `{ id, conversationId, kind, systemEvent, sender: { id, name, profileImage } | null, body, deleted, attachments, createdAt, readByCounterpart }`. 삭제된 메시지는 `body: ''`, `attachments: []`. `readByCounterpart`는 내가 보낸 텍스트 메시지에만 boolean이다.

**대화방 객체** (MG5): `{ id, contractId, myRole, contract: { id, status, completedAt }, project: { id, title }, counterpart: { id, name, profileImage }, lastMessageAt, createdAt, unreadCount, myLastReadAt, counterpartLastReadAt, canSend, closedReason, closesAt }`. 계약 완료 30×24시간 뒤부터 `canSend: false`, `closedReason: "CONTRACT_CLOSED"`. 상대가 탈퇴했으면 `COUNTERPART_INACTIVE`.

공통 오류(`/:id` 라우트): 없거나 프로젝트가 삭제됨 404 `Conversation not found` → 참여자가 아니면 403 `Not authorized`.

- **`GET /`** (MG11) — 쿼리 `page`, `limit`. 응답 `{ conversations, meta }`, 각 대화방 객체 + `lastMessage`. 최근 메시지순(메시지 없는 방은 뒤).
- **`GET /unread-count`** (MG12) — `{ unreadCount }`. 상대가 보낸 삭제되지 않은 텍스트 메시지 중 내 읽음 시각 이후 것.
- **`GET /:id`** (MG13) — `{ conversation }`.
- **`GET /:id/messages`** (MG14) — 쿼리 `before` 또는 `after`(메시지 id, 둘 중 하나), `limit`(기본 30, 최대 100). 응답 `{ messages, hasMore }`, 항상 오래된 순. 커서 없음 = 최신 `limit`개, `before` = 그보다 오래된 것, `after` = 그보다 새것(폴링). 읽음 처리는 하지 않는다. 오류 순서: 둘 다 주면 400 `before: Use either before or after, not both` → 404 → 403 → 이 방 메시지가 아닌 커서 400 `before: Message not found in this conversation`.
- **`POST /:id/messages`** (MG15) — multipart `body` + `files`(첨부 정책), 파일이 없으면 JSON `{ body }`. 응답 **201** `{ message }`. 오류 순서: 업로드 413/400 → 400 `body: Message must be at most 5000 characters` / `body: Message or attachment is required` → 404 → 403 → 409 `This conversation is closed` → 409 `The other participant is no longer active` → 저장 실패 502.
- **`POST /:id/read`** (MG16) — 본문 없음. 내 읽음 시각을 상대가 보낸 가장 최근 메시지 시각까지 올린다(뒤로 가지 않음). 응답 200 `{ lastReadAt, unreadCount }`.
- **`DELETE /:id/messages/:messageId`** (MG17) — 응답 200 `{ message }`(삭제 표시된 메시지). 이미 삭제됐으면 200(멱등). 오류 순서: 404 → 403 → 404 `Message not found` → 시스템 메시지나 상대 메시지 403 `Not authorized` → 보낸 지 5분이 지났으면 409 `Messages can only be deleted within 5 minutes`. 첨부 파일은 저장소에서 지우지 않는다. 수정 기능은 없다.

## 리뷰 — `/api/reviews`

| Method | Endpoint | 인증 | 설명 |
| --- | --- | --- | --- |
| POST | `/api/reviews` | 로그인 | 리뷰 작성 (계약 당사자) |
| GET | `/api/reviews/users/:id` | 공개 | 받은 리뷰 (`GET /api/users/:id/reviews`와 같음) |

- **`POST /`** — 요청 `{ contractId, revieweeId, rating, content, tags? }`. 응답 **201** 리뷰. 오류 순서: 400 `All fields are required`(`rating: 0` 포함) → 400 `Rating must be between 1 and 5`(숫자가 아니면 500, D9) → 404 `Contract not found` → 403 `Not authorized` → 400 `Reviews can only be written after project completion` → 상대방이 아니면 400 `Invalid reviewee` → 409 `You have already reviewed this contract`.

## 알림 — `/api/notifications`

| Method | Endpoint | 인증 | 설명 |
| --- | --- | --- | --- |
| GET | `/api/notifications` | 로그인 | 내 알림 목록 |
| GET | `/api/notifications/unread-count` | 로그인 | 안 읽은 알림 수 |
| PATCH | `/api/notifications/read-all` | 로그인 | 모두 읽음 |
| PATCH | `/api/notifications/:id/read` | 로그인 | 하나 읽음 |
| GET | `/api/notifications/preferences` | 로그인·활성 | 알림 설정 조회 |
| PUT | `/api/notifications/preferences` | 로그인·활성 | 알림 설정 변경 (부분 갱신) |

인앱 알림 type은 19종이고(`APPLICATION_*` 3, `PROJECT_STATUS_CHANGED`, `CONTRACT_ACTIVATED`, `CONTRACT_COMPLETED`, `MILESTONE_*` 9, `SETTLEMENT_*` 4), 이메일 전용 `MESSAGE_UNREAD_DIGEST`까지 20종이다. 모든 알림은 `notify()`가 type별 정책과 사용자 설정을 보고 인앱 row와 이메일 발송 기록을 만든다. 표와 `href`는 BEHAVIOR.md "Notifications"와 NC2에 있다.

- **`GET /`** — 쿼리 `limit`(기본 20, 최대 50, 양의 정수 아니면 400 `limit must be a positive integer`). 응답 `{ notifications: [{ id, userId, type, title, message, href, readAt, createdAt }], unreadCount }`(최신순, `unreadCount`는 전체 기준).
- **`GET /unread-count`** — `{ unreadCount }`.
- **`PATCH /read-all`** — `{ message: "Notifications marked as read" }`. 이미 읽은 것의 `readAt`은 그대로.
- **`PATCH /:id/read`** — 읽은 알림 row. 없거나 남의 알림이면 404 `Notification not found`(구분하지 않음). 다시 읽어도 처음 `readAt` 유지.
- **`GET /preferences`** (NC5) — 200 `{ preferences: [{ type, category, inApp, email, inAppLocked, emailLocked }] }`. 내 역할(DB 기준)이 받는 type만, CLIENT 8개·FREELANCER 17개. 잠긴 채널은 바꿀 수 없다(거래·돈 알림의 인앱, 자동 승인 임박·지급 보류·지급 실패의 이메일). 다이제스트의 인앱은 항상 꺼짐·잠김.
- **`PUT /preferences`** (NC6–NC8) — 요청 `{ preferences: [{ type, inApp?, email? }] }`(1~20개). 나열하지 않은 type과 채널은 그대로다. 응답 GET과 같은 본문. 실패하면 하나도 쓰지 않는다. 오류(모두 400) — 모양: `preferences: Expected 1 to 20 entries`, `preferences.<i>: Expected an object`, `preferences.<i>.type: Unknown notification type`, `preferences.<i>.inApp: Expected a boolean` → 항목 규칙: `preferences.<i>: Specify inApp or email`, `preferences.<i>.type: Duplicate notification type`, `preferences.<i>.inApp: MESSAGE_UNREAD_DIGEST has no in-app notifications`, `preferences.<i>.inApp: <type> in-app notifications cannot be disabled`, `preferences.<i>.email: <type> email notifications cannot be disabled`. 잠긴 채널을 원래 값으로 보내는 것은 통과한다.

## 내부 — `/api/internal`

| Method | Endpoint | 인증 | 설명 |
| --- | --- | --- | --- |
| POST | `/api/internal/jobs/run` | 내부 토큰 | 작업 큐 한 번 실행 |

- 외부 스케줄러가 부를 엔드포인트다(운영에서 무엇이 부를지는 아직 정하지 않았다, [DEPLOYMENT.md](DEPLOYMENT.md)).
- `INTERNAL_JOB_TOKEN`이 비어 있으면 존재하지 않는 경로와 똑같이 HTML 404.
- `X-Internal-Token`이 없거나 다르면 403 `Invalid internal token`(상수 시간 비교) → 요청 `{ limit? }`(1~500 정수, 기본 50) 검증 400.
- 반복 작업 예약 → 멈춘 작업 회수 → 만기 작업 실행 후 200 `{ claimed, succeeded, retried, failed, skipped }`.
