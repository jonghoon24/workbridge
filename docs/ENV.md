# 환경변수

## 서버 (.env)

| 변수 | 설명 |
| --- | --- |
| `PORT` | 서버 포트 (기본 4000) |
| `DATABASE_URL` | PostgreSQL 연결 문자열 (Supabase Transaction mode 포트 6543 권장) |
| `JWT_ACCESS_SECRET` | Access Token 서명 시크릿 |
| `JWT_REFRESH_SECRET` | Refresh Token 서명 시크릿 |
| `JWT_ACCESS_EXPIRES_IN` | Access Token 만료 시간 (기본 15m) |
| `JWT_REFRESH_EXPIRES_IN` | Refresh Token 만료 시간 (기본 7d) |
| `GOOGLE_CLIENT_ID` | Google OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 클라이언트 시크릿 |
| `GOOGLE_CALLBACK_URL` | Google OAuth 콜백 URL. 프론트엔드 `/api/auth/google/callback` URL 사용 |
| `OPENAI_API_KEY` | OpenAI API 키 |
| `TOSS_SECRET_KEY` | 토스페이먼츠 시크릿 키 (test_sk_...) |
| `ALLOW_PAYMENT_BYPASS` | 데모/로컬에서 `true`로 설정하면 토스 결제창 없이 결제 완료 처리 가능. 실제 운영 서비스에서는 `false` 유지 |
| `CLIENT_URL` | 프론트엔드 URL (기본 http://localhost:3000) |
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_SECRET_KEY` | Supabase Secret Key (sb_secret_...) |

## 클라이언트 (.env.local)

| 변수 | 설명 |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | 백엔드 API URL (기본 http://localhost:4000) |
| `NEXT_PUBLIC_TOSS_CLIENT_KEY` | 토스페이먼츠 클라이언트 키 (test_ck_...) |
| `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS` | 데모/로컬에서 `true`로 설정하면 결제 페이지에 개발용 결제 완료 버튼 표시. 실제 운영 서비스에서는 `false` 유지 |

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

실제 결제창을 사용할 수 없는 데모/로컬 환경에서는 서버 `.env`의 `ALLOW_PAYMENT_BYPASS=true`와 클라이언트 `.env.local`의 `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS=true`를 함께 설정합니다. 결제 페이지에서 "개발용 결제 완료 처리"를 누르면 서버가 개발용 완료 결제 레코드를 만들고, 이후 계약 상세 화면에서 기존 "프로젝트 완료 처리" 버튼을 눌러 리뷰 작성 플로우를 확인할 수 있습니다. 실제 운영 서비스에서는 두 값을 모두 `false`로 유지합니다.

### OpenAI

1. [OpenAI Platform](https://platform.openai.com/)에서 API 키 발급
