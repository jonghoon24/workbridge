---
paths:
  - "workbridge-client/**"
---

# 클라이언트 (Next.js 14 App Router, JSX)

- **TypeScript가 아니라 JSX.** `.ts/.tsx` 파일이나 TS 설정을 추가하지 않는다.
- 백엔드 호출은 `src/lib/api.js`를 거친다. 컴포넌트에서 `axios`/`fetch`를 직접 쓰지 않는다. ESLint가 검사하고,
  직접 네트워크를 써도 되는 파일 목록은 `.eslintrc.json`에 있다.
- 예외: 로그인, 가입, 역할 선택, 로그아웃 요청은 `src/lib/authApi.js`를 쓴다. 이유는 그 파일 머리 주석에 있다.
- 첨부 파일은 `src/lib/attachments.js`가 서명 URL로 Supabase Storage에 직접 `PUT`한다. 이 요청에는 액세스 토큰을
  붙이지 않는다. 백엔드가 아닌 제3자 저장소로 가는 요청이기 때문이다. 컴포넌트는 `uploadAttachments()`와
  `AttachmentLink`만 쓴다.
- 백엔드 주소는 `src/lib/apiUrl.js`의 `getApiUrl()`로만 정하고, 서버 쪽(라우트 핸들러, SSR)에서만 부른다.
  브라우저 코드는 같은 출처 `/api/*`를 부른다.
- 로그인이 필요한 페이지를 추가하면 그 경로 접두사를 `src/middleware.js`의 `protectedRoutes`에 넣는다.
  이 미들웨어는 쿠키가 있는지만 보므로 권한 검사는 서버에 둔다.
- 서버 오류는 `toUserMessage(err, fallback, { codes, fields })`(`src/lib/errorMessages.js`)로 보여 주고, 분기는
  `errorCode(err)`(오류 코드)나 `fieldViolation(err)`(검증 실패의 원인 필드)로 한다. 서버의 `message`는 개발자용 영어라
  바뀔 수 있으므로 비교하지도 화면에 보여 주지도 않는다. 코드와 필드 코드는 `npm run check:error-codes`가 서버의
  `openapi.json`과 대조한다(CI).
- **사용자에게 보이는 한국어 문구는 함부로 바꾸지 않는다.** E2E 테스트가 텍스트로 요소를 찾으므로
  라벨이나 메시지를 바꾸면 깨진다. 꼭 바꿔야 하면 같은 변경에서 `workbridge-client/e2e/`도 고친다.
- 검사: `npm run lint`, `npm run check:error-codes`, `npm run build`. 화면 확인은 `run-workbridge` 스킬을 따른다. E2E 스펙을 쓰거나 고칠 때는
  `workbridge-client/e2e/README.md`(실행 방법, 픽스처, 데이터를 만드는 방식)를 읽는다.
