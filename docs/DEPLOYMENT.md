# 배포 (Vercel)

## 백엔드

- `vercel.json`이 이미 설정되어 있음
- Vercel 대시보드에서 환경변수 설정
- Build Command: `npx prisma generate`

## 프론트엔드

- GitHub 연동 시 Next.js 자동 감지
- `NEXT_PUBLIC_API_URL`을 백엔드 배포 URL로 설정

## 배포 후 업데이트

- 백엔드 `CLIENT_URL` → 프론트엔드 Vercel URL
- 백엔드 `GOOGLE_CALLBACK_URL` → 프론트엔드 Vercel URL + `/api/auth/google/callback`
- 프론트엔드 `NEXT_PUBLIC_API_URL` → 백엔드 Vercel URL
