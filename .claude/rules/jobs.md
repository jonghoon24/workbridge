---
paths:
  - "workbridge-server/src/jobs/**/*.ts"
  - "workbridge-server/src/services/**/*.ts"
  - "workbridge-server/src/controllers/internal.controller.ts"
  - "workbridge-server/test/{jobs,auto-approval,settlements,message-digest,email}.test.ts"
---

# 백그라운드 작업 (`src/jobs/`, Postgres `Job` 테이블)

- 작업은 `enqueueJob` / `enqueueJobs`(`jobs/queue.ts`)로만 넣고, 중복은 `dedupeKey`로 막는다.
- 핸들러는 멱등이다: 상태를 다시 읽고 조건부로 쓴다. 두 번 돌아도 바뀌는 것이 없다.
- 새 타입은 `jobs/registry.ts`에, payload 타입은 `jobs/types.ts`에, 반복 일정은 `jobs/recurring.ts`에 등록한다.
- 새 작업 타입이 외부로 무언가(돈, 메일)를 보내면 `jobs/gates.ts`에 같은 방식의 플래그를 둔다(기본 꺼짐).
