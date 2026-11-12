# 리뷰 기준

로컬 `pre-pr-review` 스킬과 사람 리뷰어가 함께 쓰는 기준이다.
아래 항목을 어긴 코드는 반드시 짚고, 지적에 항목 번호를 붙인다(예: `REVIEW #4`). 리뷰 코멘트는 한국어 합니다체로 쓴다.
이 목록 밖의 버그와 결과에 영향이 있는 가독성 문제도 지적한다. 스타일과 취향은 지적하지 않는다.

- 항목 번호는 바꾸지 않는다. PR 코멘트와 코드 주석이 `REVIEW #n`으로 가리킨다. 항목을 없애면 번호를 비워 둔다.
- 항목마다 기준 한 줄, 이유가 적힌 rule이나 문서의 링크, diff에서 확인하는 방법이 있다.
- ESLint나 CI가 검사하는 부분은 그렇다고만 적고, 사람이 봐야 할 나머지만 확인 줄에 둔다.

1. **새 라우트는 `authenticate → requireActiveUser → requireRole → validate → controller` 체인으로 만든다. 가드는 라우트마다 붙인다.**
   - 근거: [`.claude/rules/server-layers.md`](../.claude/rules/server-layers.md) "라우트 만드는 법". 이 체인이 맞추는 오류 순서와 `requireActiveUser`가 막는 것이 거기 있다.
   - 확인: `git diff origin/main...HEAD -- workbridge-server/src/routes`에서 새 `router.<method>(`마다 가드 순서와 `validate(`를 본다. `router.use(`로 건 가드도 위반이다.

2. **컨트롤러는 얇게 둔다. 컨트롤러는 검증된 입력, `req.user.id`, 요청 시각(`now`)을 서비스에 넘기고 응답만 쓴다. 쿼리, 트랜잭션, `AppError`는 서비스(`src/services/`)에 둔다.**
   - 근거: [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md#레이어) "레이어", [`.claude/rules/server-layers.md`](../.claude/rules/server-layers.md).
   - 왜: 컨트롤러에 있는 로직은 작업 핸들러나 다른 서비스가 다시 쓸 수 없다. 그래서 컨트롤러에는 상태 코드, 쿠키, 리다이렉트처럼 HTTP에 속한 것만 남는다.
   - 확인: `git diff origin/main...HEAD -- workbridge-server/src/controllers`의 추가된 줄에서 `prisma.`, `$transaction`, `new AppError(`를 grep한다.

3. **금액 계산(수수료, 부가세, 반올림)은 `lib/money.ts`만 쓴다. 요청 본문의 금액은 정수로 검증한다.**
   - 근거: [`.claude/rules/money-time.md`](../.claude/rules/money-time.md) "금액", [`docs/domain/milestones-payments.md`](../docs/domain/milestones-payments.md#돈-규칙) "돈 규칙".
   - 확인: 추가된 줄에서 금액에 쓰인 `0.1`, `* 0.`, `toFixed`, `Math.round(`, `Math.floor(`를 찾는다. 새 금액 필드의 zod 스키마는 `bodyWholeWon(`이나 `.int()`를 쓴다. `z.number()`만 쓰거나 `z.coerce.number()`로 받은 금액은 위반이다.

4. **달력 규칙은 `lib/time.ts`(고정 UTC+9)로 계산하고, 시간에 따라 달라지는 함수는 `now`를 인자로 받는다.**
   - 근거: [`.claude/rules/money-time.md`](../.claude/rules/money-time.md) "시간", [`docs/domain/README.md`](../docs/domain/README.md#시간대) "시간대".
   - 서버 ESLint(`no-restricted-syntax`)가 검사한다. 호스트 시간대 getter/setter와 `toLocaleDateString()`은 `src/` 전체에서, `new Date()`·`Date.now()`는 `src/services/`와 `src/jobs/handlers/`에서 잡는다.
   - 확인: 새 `eslint-disable … no-restricted-syntax` 주석과 `eslint-suppressions.json` 항목은 이유가 맞는지 본다. ESLint가 보지 않는 `src/lib/` 같은 곳에서 시간에 따라 달라지는 로직이 `new Date()`를 직접 읽는지 본다. 작업 핸들러는 `ctx.now`를 쓴다.

5. **여러 행을 바꾸는 변경은 `prisma.$transaction` 하나로 한다. 그 트랜잭션 안에서 P2002를 catch하지 않는다.**
   - 근거: [`.claude/rules/server-layers.md`](../.claude/rules/server-layers.md) "트랜잭션과 잠금".
   - 확인: `$transaction(async (tx)` 블록 안의 `catch`가 `P2002`를 검사하면 위반이다. 다중 쓰기가 트랜잭션 밖에 흩어져 있지 않은지 본다. 중복을 다루는 맞는 방법은 셋이다.
     - `createMany({ skipDuplicates: true })`로 충돌을 피한다(`jobs/queue.ts`의 `enqueueJob`).
     - 트랜잭션 밖에서 catch해 409로 바꾼다(`applications.service.ts`의 지원 수락 `decideApplication`).
     - 진 요청이 이긴 요청의 결과를 그대로 받아도 되면, 밖에서 catch하고 한 번 다시 실행한다(`payments.service.ts`의 `retryOnceOnPaymentConflict`).

6. **지급 계좌, 포트폴리오·경력, 알림 설정을 쓰는 트랜잭션과 주간 정산 배치(`settleFreelancer`)는 `lockUserRow(tx, userId)`(사용자 요청 경로는 `lockActiveUserRow`)를 첫 문장으로 둔다.**
   - 근거: [`docs/DATABASE.md`](../docs/DATABASE.md#동시성-잠금과-조건부-쓰기) "동시성: 잠금과 조건부 쓰기". 잠금 순서, 정산의 교착(#79), 예외와 그 이유가 모두 거기 있다.
   - 예외: 회원 탈퇴와 지원 생성은 `Project` → `Application` → `User` 순서로 잠근다.
   - 확인: 해당 서비스의 `$transaction` 콜백에서 첫 `await`가 그 잠금 함수인지 본다. 사용자 요청 경로에서 `lockUserRow`를 썼으면 위반이다.

7. **알림은 `notify()`·`notifyMany()`·`notifyRecipients()`로, 작업은 `enqueueJob()`으로 만든다. 둘 다 원인이 된 상태 변경의 트랜잭션 안에서 만든다.**
   - 근거: [`docs/domain/README.md`](../docs/domain/README.md#원자성) "원자성", [`.claude/rules/notifications-logging.md`](../.claude/rules/notifications-logging.md) "알림".
   - 확인: 새 코드의 `notification.create(`, `job.create(`를 grep한다. `notify` 계열이나 `enqueueJob(`에 `tx` 대신 `prisma`를 넘겼는지 본다. 받는 사람이 탈퇴했을 수 있는데 `notify()`를 썼는지 본다.

8. **`User`·`Project`를 읽거나 쓰는 쿼리는 `deletedAt: null`로 거른다.**
   - 근거: [`docs/domain/README.md`](../docs/domain/README.md#소프트-삭제) "소프트 삭제". 돈(정산, 지급 계좌)이 예외인 것도 거기 있다.
   - 왜: 이 필터를 빠뜨린 버그가 여러 번 났다(삭제된 프로젝트의 북마크 #14, 계약 #16).
   - 확인: 새 `findUnique`·`findFirst`·`findMany`·`update`가 `user`나 `project`(`contract.project` 포함)에 닿으면 필터가 있는지 본다. 유니크 필드만으로 찾는 `findUnique`는 위반이다. `deletedAt: null`을 함께 건 `findFirst`나 `findUnique`는 괜찮다.

9. **공개 핸들러에서 `req.user`를 읽지 않는다.**
   - 근거: [`.claude/rules/server-layers.md`](../.claude/rules/server-layers.md) "req.user". 공개 핸들러 목록은 `src/types/index.ts`의 `Request.user` 주석에 있다.
   - 확인: `authenticate`가 없는 라우트의 핸들러 diff에서 `req.user`를 grep한다. 새 공개 라우트는 그 주석과 `test/authorization.test.ts`의 `PUBLIC_ROUTES`에 추가돼야 한다.

10. **로그는 `lib/logger.ts`로 남긴다. `error` 레벨은 정해진 경우에만 쓰고, 요청 body·query·헤더를 통째로 남기지 않는다.**
    - 근거: [`.claude/rules/notifications-logging.md`](../.claude/rules/notifications-logging.md) "로그". `error`를 쓰는 경우와 그 이유가 거기 있다.
    - `console.*`는 서버 ESLint(`no-console`)가 검사한다.
    - 확인: 추가된 `logger.error(`가 `errorHandler`의 500, 응답을 보낸 뒤의 예외, 작업 실패 중 하나인지 본다. 4xx나 예상된 실패는 `warn`이나 `info`다. 로그 필드에 `req.body`·`req.query`·`req.headers`가 통째로 들어갔는지 본다.

11. **커밋된 마이그레이션은 고치지 않는다. 스키마 변경은 새 마이그레이션으로 한다.**
    - 근거: [`.claude/rules/prisma.md`](../.claude/rules/prisma.md).
    - CI(`ci.yml`)가 검사한다. PR이 커밋된 마이그레이션 파일을 고치거나 지우거나 이름을 바꾸면 실패한다. 로컬에서는 훅(`protect-migrations.sh`)이 Claude의 Edit/Write를 막는다.
    - 확인: 새 모델이면 `test/helpers/db.ts`의 `TABLES`가, 필요하면 `prisma/seed.js`도 함께 바뀌었는지 본다.

12. **실패한 테스트를 통과시키려고 단언을 지우거나 약하게 바꾸지 않는다. 버그를 고치는 PR에는 회귀 테스트가 있다.**
    - 근거: `CLAUDE.md` "테스트", [`.claude/rules/tests.md`](../.claude/rules/tests.md).
    - 왜: 단언을 지금 응답에 맞춰 바꾸면 버그가 기대값으로 굳는다. 버그는 실패하는 테스트로 남기지 않고 이슈로만 추적한다. 그래서 고치는 PR의 회귀 테스트가 재발을 잡는 유일한 장치다.
    - 확인:
      - 기존 `expect(`가 지워지거나 느슨해진 곳을 찾는다. 기대 상태 코드나 메시지 변경, `toEqual` → `toMatchObject`, 검사하던 필드 삭제가 그 예다.
      - 그런 곳마다 그 동작을 바꾸는 것이 PR의 목적인지 PR 본문과 연결된 이슈로 확인한다.
      - 버그 수정 PR이면 고치기 전 코드에서 실패하는 테스트가 추가됐는지 본다. 테스트가 없으면 본문에 자동 테스트로 재현할 수 없는 이유와 수동 재현 절차가 있는지 본다. 이슈 없이 Sentry 오류나 구두 보고로 시작한 수정도 있으므로 `Closes #N`이 없는 것은 위반이 아니다. 본문이 이슈를 언급하면 `Closes #N`으로 연결됐는지 본다.
      - 새 `it.fails`·`it.skip`·`it.todo`는 위반이다.

13. **새 라우트는 권한 매트릭스에, 새 쓰기 라우트는 소프트 삭제 매트릭스에도 등록한다.**
    - 근거: [`.claude/rules/tests.md`](../.claude/rules/tests.md). 401·403·소유권은 `test/authorization.test.ts`의 `PROTECTED_ROUTES`, 소프트 삭제된 호출자는 `test/soft-delete.test.ts`의 `guardedMutations`가 한 곳에서 검사한다.
    - 확인: 새 라우트마다 `PROTECTED_ROUTES` 행이 있는지 본다(공개 라우트면 `PUBLIC_ROUTES`). 두 표 어디에도 없으면 실제 라우터와 대조하는 테스트가 실패한다. 쓰기 라우트면 `guardedMutations` 행도 본다. 엔드포인트별 테스트 파일에서 401·403을 다시 단언하면 중복이다.

14. **클라이언트는 `src/lib/api.js`로 백엔드를 부른다. 사용자에게 보이는 문구를 바꾸면 E2E도 함께 고친다.**
    - 근거: [`.claude/rules/client.md`](../.claude/rules/client.md).
    - `axios`·`fetch`·`XMLHttpRequest`를 직접 쓰는 것은 클라이언트 ESLint(`.eslintrc.json`)가 검사한다. 허용하는 파일은 그 설정에 있다.
    - 확인: 바뀐 JSX 문구가 `workbridge-client/e2e/`에서 쓰이는지 grep한다. E2E는 화면의 한국어 텍스트로 요소를 찾는다. 새 로그인 필요 페이지는 `src/middleware.js`의 `protectedRoutes`에 추가됐는지 본다.

15. **새 `AppError`의 오류 코드는 그 원인에 맞는 것이다.**
    - 근거: [`.claude/rules/server-layers.md`](../.claude/rules/server-layers.md) "에러", [`docs/domain/README.md`](../docs/domain/README.md) "오류 응답".
    - 왜: 클라이언트는 메시지가 아니라 코드로 분기해 안내를 고른다. 타입과 테스트는 코드가 있고 그 경로의 문서에 적혀 있는지만 본다. 뜻이 다른 원인을 기존 코드에 넣으면 화면이 엉뚱한 안내를 보여 주고, 같은 안내로 충분한 원인에 새 코드를 만들면 클라이언트 표만 늘어난다.
    - 확인:
      - `git diff origin/main...HEAD -- workbridge-server/src`의 새 `new AppError('<CODE>'`와 `invalidField(`마다 `src/lib/errorCodes.ts`의 그 코드 설명이 원인과 맞는지 본다. 요청 필드가 틀린 것은 어디서 검사하든 `VALIDATION_FAILED`(`invalidField`)다.
      - 표에 새 코드가 생겼으면 클라이언트가 실제로 다르게 안내하거나 동작해야 하는 원인인지 본다.
