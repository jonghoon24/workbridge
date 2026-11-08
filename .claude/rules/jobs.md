---
paths:
  - "workbridge-server/src/jobs/**/*.ts"
  - "workbridge-server/src/services/**/*.ts"
  - "workbridge-server/src/controllers/internal.controller.ts"
  - "workbridge-server/test/{jobs,auto-approval,settlements,message-digest,email}.test.ts"
---

# 백그라운드 작업 (`src/jobs/`, Postgres `Job` 테이블)

- `enqueueJob(tx, { type, payload, runAt, dedupeKey })` / `enqueueJobs`는 **그 작업을 일으킨 상태
  변경의 트랜잭션 안에서** 호출한다(트랜잭션 아웃박스). 롤백된 변경이 작업을 남기면 안 된다
  (BEHAVIOR.md 규칙 11).
- 중복은 `dedupeKey`로 막는다. 내부는 `createMany({ skipDuplicates: true })`다. 인터랙티브 트랜잭션
  안에서 `create` 후 P2002를 catch하지 않는다: Postgres는 처음 실패한 문장에서 트랜잭션 전체를
  중단하므로, catch해도 트랜잭션은 이미 망가져 있다.
- 핸들러는 멱등이다: 상태를 다시 읽고 조건부로 쓴다. 두 번 돌아도 바뀌는 것이 없다.
- 핸들러는 `new Date()`가 아니라 `ctx.now`를 쓴다(`jobs/types.ts`). 새 타입은 `jobs/registry.ts`에,
  payload 타입은 `jobs/types.ts`에, 반복 일정은 `jobs/recurring.ts`에 등록한다.
- `errorHandler` 밖에서 `logger.error`를 쓰는 곳은 작업 실패뿐이다(규칙 9).
- 실행 주체: `index.ts`가 띄우는 개발 워커(`JOB_WORKER_ENABLED`), `npm run jobs:run`,
  `POST /api/internal/jobs/run`(`X-Internal-Token`, JWT 없음 — `runJobs`에서 `req.user`를 읽지 않는다).
  **운영에는 상주 워커가 없다**: 외부 스케줄러가 내부 엔드포인트를 부르기 전까지 자동 승인, 정산,
  이메일, 다이제스트가 돌지 않는다.
- 테스트: `test/helpers/jobs.ts`의 `runJobs(now)` / `jobsOf(type)`. 미래의 `now`로 돌릴 때는 `types`를
  제한한다. 그러지 않으면 `project.lifecycleSweep`이 마감이 그 전인 프로젝트를 모두 닫는다.
