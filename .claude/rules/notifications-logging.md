---
paths:
  - "workbridge-server/src/**/*.ts"
---

# 알림과 로그

## 알림

- 알림은 `notify()` / `notifyMany()` / `notifyRecipients()`(`src/lib/notifications/notify.ts`)로만 만든다. 채널 정책,
  받는 사람의 설정, 이메일 발송 작업이 이 함수에서 적용된다.
- 받는 사람이 소프트 삭제됐을 수 있으면 `notifyRecipients()`를 쓴다. `notify()`는 삭제된 사용자의 이메일만 거르고
  인앱 알림은 만든다.
- 새 타입은 `lib/notifications/types.ts`, `policy.ts`, `templates.ts`에 함께 추가한다.

## 로그 — `src/lib/logger.ts`

- 요청 body·query·헤더를 통째로 로그 필드에 넣지 않는다(`{ body: req.body }` 금지). 계좌번호 같은 개인정보와
  토큰이 운영 로그에 남기 때문이다. 필요한 필드(id, 상태, 개수)만 골라 넣는다.
- `error` 레벨은 세 경우에만 쓴다. `errorHandler`의 500, 응답을 보낸 뒤에 난 예외(`errorHandler`의 `headersSent`
  분기), 작업 실패다. 응답을 보낸 뒤의 예외는 사용자에게 500을 보내지 못했을 뿐 서버 버그라서 `error`다.
  나머지는 `warn`이나 `info`다. 리다이렉트로 처리하는 `googleCallback`의 실패도 `warn`이다.
  테스트 스위트가 "500은 정확히 한 번 error로 로그된다"와 "4xx는 error로 로그하지 않는다"를 단언한다.
