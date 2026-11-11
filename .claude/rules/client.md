---
paths:
  - "workbridge-client/**"
---

# 클라이언트 (Next.js 14 App Router, JSX)

- **TypeScript가 아니라 JSX.** `.ts/.tsx` 파일이나 TS 설정을 추가하지 않는다.
- 백엔드 호출은 `src/lib/api.js`를 거친다. 컴포넌트에서 `axios`/`fetch`를 직접 쓰지 않는다.
  예외: `src/lib/authApi.js`(login, signup, select-role, logout) — 갱신 인터셉터가 없어서 로그인
  실패가 갱신 루프를 일으키지 않는다.
- 첨부 파일의 저장소 업로드는 `src/lib/attachments.js`가 Supabase로 직접 보내는 `PUT`이다. 여기에 액세스 토큰을
  붙이지 않는다. 컴포넌트는 `uploadAttachments()`와 `AttachmentLink`만 쓴다.
- 백엔드 주소는 `src/lib/apiUrl.js`의 `getApiUrl()`로만 정하고, 서버 쪽(라우트 핸들러, SSR)에서만 부른다.
  브라우저 코드는 같은 출처 `/api/*`를 부른다.
- 로그인이 필요한 페이지를 추가하면 그 경로 접두사를 `src/middleware.js`의 `protectedRoutes`에 넣는다.
  이 미들웨어는 쿠키가 있는지만 보므로 권한 검사는 서버에 둔다.
- **사용자에게 보이는 한국어 문구는 함부로 바꾸지 않는다.** E2E 테스트가 텍스트로 요소를 찾으므로
  라벨이나 메시지를 바꾸면 깨진다. 꼭 바꿔야 하면 같은 변경에서 `workbridge-client/e2e/`도 고친다.
- 검사(단위 테스트 없음): `npm run lint`, `npm run build`. 화면 확인과 E2E는 `run-workbridge` 스킬을 따른다.
