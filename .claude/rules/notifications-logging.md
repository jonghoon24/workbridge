---
paths:
  - "workbridge-server/src/**/*.ts"
---

# 알림과 로그

## 알림

- 알림은 `notify()` / `notifyMany()` / `notifyRecipients()`(`src/lib/notifications/notify.ts`)로만
  만들고, 상태 변경의 **트랜잭션 클라이언트**를 넘긴다. 이 함수가 채널 정책(`lib/notifications/policy.ts`)과
  받는 사람의 설정을 적용하고, 인앱 행, `EmailDelivery`, 그 `notification.email` 작업을 함께 쓴다(NC9).
- 새 코드에서 `tx.notification.create(...)`를 직접 부르지 않는다. 소프트 삭제된 사용자에게 보내지 않는다.
- 새 타입: `lib/notifications/types.ts`, `policy.ts`, `templates.ts`에 추가한다.
- 기존 타입 네 개는 일부러 옛 컨트롤러 안에 한국어 문구를 그대로 둔다
  (클라이언트와 E2E가 그 텍스트로 찾는다).
- 이메일은 로그로만 남는다: `MAIL_PROVIDER`가 없거나 `log`면 이메일 하나가 `mail.sent` info 한 줄이다.

## 로그 — `src/lib/logger.ts`

- `console.*`가 아니라 `logger.debug|info|warn|error(msg, fields)`를 쓴다(PostToolUse 훅이 잡는다).
  로그는 한 줄 JSON이고, 필드 안의 `Error`는 `serializeError`가 직렬화한다.
- `error` 레벨은 `errorHandler`의 500과 작업 실패 전용이다. 스위트는 `console.error` 스파이로
  "500은 정확히 한 번 로그된다"와 "4xx는 error로 로그하지 않는다"를 단언한다.
  나머지는 `warn`/`info`를 쓴다.
- 남겨 두는 예외: `auth.controller.ts`의 `googleCallback`(리다이렉트로 삼키는 실패를 로그로 남긴다)과
  `jobs/cli.ts`(CLI에 실행 결과를 출력한다).
