# 리뷰 기준

로컬 `pre-pr-review` 스킬과 CI 리뷰어가 함께 읽는 기준이다. 리뷰 코멘트는 한국어 합니다체로 쓰고, 지적할 때는
항목 번호를 붙인다(예: `REVIEW #4`). 기준의 근거는 `docs/domain/`(제품 규칙), OpenAPI 문서(`workbridge-server/openapi.json`), `.claude/rules/`다.
일반적인 버그·가독성 지적은 이 목록 밖에서도 하되, 아래 항목 위반은 반드시 짚는다.

1. **새 라우트는 확장 방식으로 만든다: `authenticate → requireActiveUser → requireRole → validate → controller`, 로직은 `src/services/`.**
   - 왜: 이 체인이 검사 순서(역할 403 → 업로드 413/400 → 검증 400 `<path>: <문장>` → 존재 404 → 소유권 403 → 상태 409)를 보장하고, 탈퇴한 사용자가 남은 토큰으로 쓰는 것을 막는다(기존 라우트에는 이 가드가 없다: #7). 새 라우트를 기존 방식(컨트롤러 안의 로직, `requireActiveUser` 없음)으로 쓰면 #40에서 옮길 대상만 늘어난다.
   - 확인: `git diff origin/main...HEAD -- workbridge-server/src/routes`에서 새 `router.<method>(`마다 가드 순서와 `validate(`를 본다. `router.use(`로 가드를 거는 것도 위반이다 — 같은 접두사에 나중에 마운트된 라우터로 가야 할 요청까지 가드가 가로챈다.

2. **기존 컨트롤러(auth, users, projects, applications, contracts, payments, reviews, notifications)를 서비스 레이어로 옮기는 일은 다른 변경에 섞지 않는다.**
   - 왜: 이 이전은 #40에서 도메인 단위로 한다. 버그 수정이나 기능 PR에 일부만 섞이면 한 도메인 안에 두 방식이 생긴다.
   - 확인: #40이 아닌 PR의 diff에서 위 8개 도메인의 `*.controller.ts`에 `from '../services/`가 새로 생겼는지 grep한다.

3. **금액 계산(수수료, 부가세, 반올림)은 `lib/money.ts`만 쓴다.**
   - 왜: 금액은 원 단위 정수이고 `payoutBreakdown`(수수료 floor → 부가세 floor → 실지급)과 `sumBreakdowns`(합계는 항목의 합)가 정산 금액의 기준이다(`docs/domain/milestones-payments.md` "돈 규칙"). 인라인 `* 0.1`이나 `Math.round`는 1원 어긋남을 만든다. `Float` 컬럼은 의도된 부채라 마이그레이션하지 않는다.
   - 확인: 추가된 줄에서 `0.1`, `* 0.`, `toFixed`, `Math.round(`/`Math.floor(`가 금액에 쓰였는지, 새 금액 필드의 zod가 정수인지(`bodyWholeWon(`, 또는 확장 스키마의 기존 방식인 `.int()`) 본다. `z.number()`만 쓰거나 `z.coerce.number()`로 받은 금액은 위반이다.

4. **달력 규칙은 `lib/time.ts`(고정 UTC+9)로 계산하고 `now`를 인자로 받는다.**
   - 왜: CI와 Vercel은 UTC, 개발 PC는 KST라 `getDate()`·`setHours()` 같은 호스트 시간대 함수는 기기마다 다른 "오늘"을 만든다. 서비스와 작업 핸들러가 `new Date()`를 직접 읽으면 테스트가 `runJobs(now)`로 시간을 제어할 수 없다.
   - 확인: 추가된 줄에서 `getDate(`·`getDay(`·`getHours(`·`getMonth(`·`getFullYear(`와 같은 이름의 `set*(`, `toLocaleDateString(`, 그리고 `src/services/`·`src/jobs/handlers/`의 `new Date()`를 grep한다. 핸들러는 `ctx.now`를 써야 한다.

5. **여러 행을 바꾸는 변경은 하나의 `prisma.$transaction`이고, 그 안에서 P2002를 catch하지 않는다.**
   - 왜: 인터랙티브 트랜잭션에서 실패한 문장은 Postgres가 트랜잭션 전체를 중단시켜서 catch해도 이미 망가져 있다. 중복은 `createMany({ skipDuplicates: true })`(`enqueueJob`의 방식)로 피하거나 트랜잭션 밖에서 catch해 409로 바꾼다(지원 수락 `updateApplication`의 방식). 진 쪽이 이긴 쪽 결과를 그대로 받아도 되면 밖에서 catch하고 한 번 다시 실행한다(결제 생성과 dev-complete의 `retryOnceOnPaymentConflict`, 이 처리가 없어 500이 나던 사례가 #8·#17이다).
   - 확인: `$transaction(async (tx)` 블록 안의 `catch`에서 `P2002`를 검사하는지, 다중 쓰기가 트랜잭션 밖에 흩어져 있지 않은지 본다.

6. **지급 계좌·포트폴리오/경력·알림 설정을 쓰는 트랜잭션은 `lockUserRow(tx, userId)`를 첫 문장으로 둔다.**
   - 왜: 사용자 행 잠금 하나로 이 쓰기들과 지급 결정을 직렬화한다(`docs/DATABASE.md` "동시성: 잠금과 조건부 쓰기"). 앞에 다른 쿼리가 오면 경합 테스트가 잡는 창(예: 19개에서 동시 생성 → 21개)이 다시 열린다.
   - 확인: 해당 서비스의 `$transaction` 콜백에서 첫 `await`가 `lockUserRow`인지 본다.

7. **알림은 `notify()`/`notifyMany()`로, 작업은 `enqueueJob()`으로, 원인이 된 상태 변경의 트랜잭션 안에서 만든다.**
   - 왜: `notify()`가 채널 정책과 수신자 설정을 적용하고 인앱 행·`EmailDelivery`·`notification.email` 작업을 한 번에 쓴다. 롤백된 변경이 알림이나 작업을 남기면 안 된다(트랜잭션 아웃박스, `docs/domain/README.md` "원자성"). 기존 4종 알림의 한국어 문구는 기존 컨트롤러에 그대로 둔다.
   - 확인: 새 코드의 `notification.create(`, `job.create(`, 그리고 `tx` 대신 `prisma`를 넘긴 `notify(`/`enqueueJob(`을 grep한다.

8. **`User`·`Project`를 읽거나 쓰는 모든 쿼리는 `deletedAt: null`로 거른다.**
   - 왜: 소프트 삭제다(`docs/domain/README.md` "소프트 삭제"). 삭제된 사용자의 로그인(고쳐짐), 삭제된 프로젝트의 북마크 조회·해제(고쳐짐: #14), 삭제된 프로젝트의 계약 조회·서명(고쳐짐: #16)이 모두 이 필터 누락이다. 확장 리소스는 계약의 프로젝트를 따라 404가 된다.
   - 확인: 새 `findUnique`/`findFirst`/`findMany`/`update`가 `user`·`project`(또는 `contract.project`)에 닿을 때 필터가 있는지 본다. `findUnique`는 필터를 못 거니 `findFirst`로 바꿔야 한다.

9. **공개 핸들러에서 `req.user`를 읽지 않는다.**
   - 왜: `Express.Request.user`는 non-optional로 선언돼 컴파일러가 경고하지 않지만, `src/types/index.ts`에 적힌 15개 공개 핸들러(`runJobs`, API 문서 화면 포함)에서는 런타임에 `undefined`다. `test/authorization.test.ts`가 유일한 안전장치다.
   - 확인: `authenticate`가 없는 라우트에 연결된 핸들러의 diff에서 `req.user`를 grep한다. 새 공개 라우트는 `src/types/index.ts`의 목록과 `PUBLIC_ROUTES`에 추가됐는지 본다.

10. **로그는 `lib/logger.ts`로 남기고 `console.*`를 쓰지 않는다. `error` 레벨은 `errorHandler`의 500과 작업 실패 전용이다. 요청 body·query·헤더를 통째로 로그에 남기지 않는다.**
    - 왜: 스위트가 `console.error` 스파이로 "500은 정확히 한 번 로그된다"를 단언한다. 4xx나 예상된 실패를 `error`로 남기면 그 테스트가 깨지고 운영 경보가 오염된다. 요청 전체를 로그에 넣으면 계좌번호 같은 개인정보와 토큰이 운영 로그에 남는다(로그에는 필요한 필드만).
    - 확인: 추가된 줄의 `console.`과 `logger.error(`를 grep한다. 예외는 `googleCallback`과 `jobs/cli.ts`뿐이다. 로그 필드에 `req.body`·`req.query`·`req.headers`가 통째로 들어갔는지 본다.

11. **이미 커밋된 마이그레이션은 수정하지 않는다. 스키마 변경은 새 마이그레이션으로 한다.**
    - 왜: main에 합쳐지면 CI가 preview와 production DB에 `prisma migrate deploy`를 돌리고, Prisma는 적용된 마이그레이션의 체크섬을 검사한다. 수정하면 두 DB에서 배포가 멈춘다.
    - 확인: `git diff --name-status origin/main...HEAD -- workbridge-server/prisma/migrations`에 `M`/`D`가 있으면 위반이다. 새 모델이면 `docs/DATABASE.md`, `test/helpers/db.ts`의 `TABLES`, 필요하면 `prisma/seed.js`도 바뀌었는지 본다.

12. **테스트는 현재 코드가 아니라 의도한 동작을 단언한다. 기존 단언을 코드에 맞춰 약하게 고치지 않고, 버그를 고치는 PR에는 회귀 테스트와 이슈 번호가 있다.**
    - 왜: 의도의 근거는 `docs/domain/`, OpenAPI 문서, 이슈다. 실패하는 단언을 지금 응답에 맞춰 바꾸면 버그가 기대값으로 굳는다. 알려진 버그는 실패하는 테스트로 남겨 두지 않고 이슈로만 추적하므로, 고치는 PR이 넣는 회귀 테스트가 그 버그의 재발을 잡는 유일한 장치다.
    - 확인: diff에서 기존 `expect(`가 지워지거나 느슨해진 곳(기대 상태 코드나 메시지 변경, `toEqual` → `toMatchObject`, 검사하던 필드 삭제)마다 같은 PR에 의도가 바뀐 근거(도메인 문서나 OpenAPI의 변경, 이슈의 결정)가 있는지 본다. 버그 수정 PR이면 본문에 `Closes #N`이 있고, 고치기 전 코드에서 실패하는 테스트가 추가됐는지 본다. 새 `it.fails`·`it.skip`·`it.todo`는 위반이다.

13. **새 쓰기 라우트는 권한·소프트 삭제 매트릭스에 등록한다.**
    - 왜: 401/403/소유권은 `test/authorization.test.ts`의 `PROTECTED_ROUTES`, 소프트 삭제는 `test/soft-delete.test.ts`의 `guardedMutations`에서 중앙으로 검사한다. 빠지면 그 라우트는 이 검사를 전혀 받지 않는다. 기존 라우트는 아직 `requireActiveUser`가 없어(#7) `guardedMutations`에 넣으면 실패한다 — #7을 고치는 PR에서 함께 넣는다.
    - 확인: 새 라우트마다 `PROTECTED_ROUTES`(표에 없으면 실제 라우터와 대조하는 테스트가 실패한다)와, 쓰기 라우트면 `guardedMutations` 행이 추가됐는지 본다. 엔드포인트별 파일에서 401/403을 다시 단언하는 것은 중복이다.

14. **클라이언트는 `src/lib/api.js`로만 백엔드를 부르고, 사용자에게 보이는 문구를 바꾸면 E2E도 함께 고친다.**
    - 왜: `api.js`가 토큰 첨부, 401 시 한 번 갱신, 동시 요청 대기열, 실패 시 `/login` 이동을 맡는다(인증 폼만 `authApi.js`). E2E(`workbridge-client/e2e/`)는 화면의 한국어 텍스트로 요소를 고른다. 클라이언트에는 단위 테스트가 없다.
    - 확인: `workbridge-client/src` diff에서 `from 'axios'`, `fetch(`를 grep하고, 바뀐 JSX 문자열이 `workbridge-client/e2e/`에서 쓰이는지 grep한다. 새 보호 페이지는 `src/middleware.js`의 `protectedRoutes`에 추가됐는지 본다.
