---
paths:
  - "workbridge-client/**"
---

# 클라이언트 (Next.js 14 App Router, JSX)

- **TypeScript가 아니라 JSX.** `.ts/.tsx` 파일이나 TS 설정을 추가하지 않는다.
- **백엔드 호출은 `src/lib/api.js`를 거친다**(Axios 인스턴스 하나). 인터셉터가 액세스 토큰을 붙이고,
  401이 오면 `/api/auth/refresh`로 한 번 갱신하고, 동시에 실패한 요청은 줄 세워 다시 보내고, 갱신이
  실패하면 `/login`으로 보낸다. 컴포넌트에서 `axios`/`fetch`를 직접 쓰지 않는다.
  예외: `src/lib/authApi.js`(login, signup, select-role, logout) — 갱신 인터셉터가 없어서 로그인
  실패가 갱신 루프를 일으키지 않는다.
- **base URL이 둘로 나뉜다:** 브라우저에서 `getBaseURL()`은 `''`(같은 출처 `/api/*`, 라우트 핸들러
  `src/app/api/[...path]/route.js`와 `src/app/api/auth/*`가 전달)이고, SSR에서는
  `getApiUrl()`이다. 새 HTTP 메서드는 catch-all 라우트에서 export해야 한다.
- **백엔드 주소는 `src/lib/apiUrl.js`의 `getApiUrl()` 한 곳에서만 정한다**(`API_URL` → Related Projects
  `VERCEL_RELATED_PROJECTS` → `NEXT_PUBLIC_API_URL` → localhost). 서버 쪽에서만 부른다 — 브라우저 번들에 넣지 않는다.
- **`src/middleware.js`는 쿠키가 있는지만 본다.** 검증이 아니다: `protectedRoutes` 경로에
  `refreshToken` 쿠키가 없으면 `/login?redirect=…`로 보낸다. 보호할 페이지를 추가하면 그 접두사를
  여기에 넣는다. 실제 권한 경계는 여전히 서버의 컨트롤러다.
- 인증 상태: `src/store/authStore.js`(Zustand)가 `accessToken`/`user`를 `localStorage`에 복사해 둔다.
  처음 불러올 때 `initAuth()`를 호출한다. 목록 필터와 페이지: `src/store/projectStore.js`.
- **사용자에게 보이는 한국어 문구는 함부로 바꾸지 않는다.** E2E 테스트가 텍스트로 요소를 찾으므로
  라벨이나 메시지를 바꾸면 깨진다. 꼭 바꿔야 하면 같은 변경에서 `workbridge-client/e2e/`도 고친다.
- 결제 우회 버튼은 `NEXT_PUBLIC_ALLOW_PAYMENT_BYPASS`를 따른다 — 운영에서는 `false`.
- **검사**(단위 테스트 없음): `npm run lint`, `npm run build`. 그다음 리포지토리 루트에서
  E2E `bash scripts/e2e.sh`(Playwright 스펙은 `workbridge-client/e2e/`)와
  `node workbridge-client/scripts/screenshots.mjs` 스크린샷 — PNG를 열어서 직접 본다.
  그때그때 화면을 확인할 때는 Playwright MCP 서버(`.mcp.json`)로 실제 브라우저를 조작할 수 있다.
