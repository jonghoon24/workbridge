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
| `GOOGLE_CALLBACK_URL` | Google OAuth 콜백 URL |
| `OPENAI_API_KEY` | OpenAI API 키 |
| `TOSS_SECRET_KEY` | 토스페이먼츠 시크릿 키 (test_sk_...) |
| `CLIENT_URL` | 프론트엔드 URL (기본 http://localhost:3000) |
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_SECRET_KEY` | Supabase Secret Key (sb_secret_...) |

## 클라이언트 (.env.local)

| 변수 | 설명 |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | 백엔드 API URL (기본 http://localhost:4000) |
| `NEXT_PUBLIC_TOSS_CLIENT_KEY` | 토스페이먼츠 클라이언트 키 (test_ck_...) |

## 외부 서비스 설정

### Supabase

1. 프로젝트 생성 후 Settings > API에서 URL과 Secret Key 복사
2. Storage에서 `workbridge` 버킷 생성 (Public으로 설정)
3. DATABASE_URL은 Settings > Database > Connection String에서 Transaction mode (포트 6543) 사용

### Google OAuth

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트 생성
2. APIs & Services > Credentials에서 OAuth 2.0 클라이언트 ID 생성
3. 승인된 리디렉션 URI에 `http://localhost:4000/api/auth/google/callback` 추가

### 토스페이먼츠

1. [토스페이먼츠 개발자센터](https://developers.tosspayments.com/)에서 테스트 키 발급
2. 클라이언트 키 (`test_ck_...`)와 시크릿 키 (`test_sk_...`) 확인

### OpenAI

1. [OpenAI Platform](https://platform.openai.com/)에서 API 키 발급
