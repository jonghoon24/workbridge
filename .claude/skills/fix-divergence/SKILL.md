---
name: fix-divergence
description: docs/BEHAVIOR.md의 알려진 불일치(known divergence, D번호) 하나를 끝까지 고친다 — it.fails 핀을 뒤집고, 명세대로 코드를 고치고, 행을 Resolved로 옮기고, docs/API.md를 고친다. "D17 고쳐줘"("fix D17") 같은 요청, 알려진 불일치 해결, it.fails 테스트를 통과시키라는 요청에 쓴다.
argument-hint: D<번호>
---

# BEHAVIOR.md 불일치 고치기

인자: 불일치 번호, 예: `D3`. 리포지토리 루트에서 작업하고, 서버 커맨드는 `workbridge-server/` 안에서
돌린다. 로컬 테스트 DB가 있어야 한다(서버 안에서 `bash scripts/test-db.sh`).

## 1. 명세 읽기

```bash
ID=$ARGUMENTS                                 # 예: D3
grep -n "| \*\*$ID\*\* |" docs/BEHAVIOR.md     # "Known divergences" → "Outstanding"의 그 행
grep -n "\[$ID\]\|$ID\b" docs/BEHAVIOR.md      # 명세에서 그 번호를 인용한 모든 곳
```

- 행은 `Issue | Intended | Current`로 되어 있다. **Intended**가 목표다. 인용된 명세 절(엔드포인트 절,
  공통 규칙 1–12)이 정확한 상태 코드와 메시지를 준다.
- 행에 "decided in Q<n>"이 있으면 "Open questions → Decided"의 답을 읽는다.
  의도한 동작이 아직 "Still open"에 있는 질문에 달려 있으면 멈추고 묻는다.

## 2. 핀 찾기

```bash
grep -rn "\[$ID\]" workbridge-server/test/
```

- 핀은 모두 이름이 `[$ID]`로 끝나는 `it.fails(...)`(또는 `it.fails.each`)다.
- 여러 엔드포인트에 걸친 핀은 엔드포인트별 파일이 아니라 중앙 매트릭스에 있다: D12 →
  `test/soft-delete.test.ts` `mutations`, D21 → `soft-delete.test.ts`, 역할/401 문제 →
  `test/authorization.test.ts`.
- 핀이 없으면 먼저 쓴다(`test/helpers/factories.ts`로 Intended 동작을 단언하는 `it.fails`). 돌려서
  맞는 이유로 실패하는지 확인한다.

## 3. 핀을 뒤집고 실패하는지 보기

이 번호의 핀만 정확히 `it.fails` → `it`으로 바꾼다. 그다음:

```bash
cd workbridge-server && npx vitest run test/<file>.test.ts
```

실패해야 하고, 그 실패가 행에 적힌 불일치여야 한다(예: 400 대신 200). 다른 이유로 실패하면 테스트
준비부터 고친다.

## 4. 코드 고치기

- 그 엔드포인트가 이미 쓰는 레이어에서 고친다. 기존 컨트롤러(auth, users, projects,
  applications, contracts, payments, reviews, notifications)는 인라인 검사를 유지한다 — **거기에 zod,
  서비스, `requireActiveUser`를 추가하지 않는다**(`.claude/rules/server-layers.md`). D12는 의도적인
  설계 결정이 필요한 예외다. 고치기 전에 묻는다.
- `throw new AppError(message, status)`. 잘못된 입력 → 400, 유니크 충돌 → 409(D4 수정처럼 P2002는
  트랜잭션 **밖에서** catch), 외부 서비스 실패 → 502.
- 여러 행 변경은 `prisma.$transaction` 하나로 유지하고, `deletedAt: null`로 거른다.
- 금액은 `lib/money.ts`, 달력은 `lib/time.ts`, 로그는 `lib/logger.ts`.

## 5. 검증

```bash
npx vitest run test/<file>.test.ts   # 뒤집은 핀이 이제 통과한다
npm run typecheck
npm test                             # 전체 스위트, ~90초
```

수정 하나가 *다른* `it.fails`를 예기치 않게 통과시킬 수 있다(vitest는 이것을 실패로 보고한다). 그 핀은
같은 원인을 다룬 것이다: 함께 뒤집고 같은 행에 적는다. 조용히 넘기려고 `.fails`를 다시 붙이지 않는다.

## 6. BEHAVIOR.md에서 행 옮기기

"Known divergences → Resolved"에 D1, D2, D4, D7이 적힌 방식을 따른다:

```
| **D<n>** | <Was: what the code did, past tense> | <Fix: what changed, and why that way> | <Verified by: the assertions that now pass> |
```

- "Outstanding"에서 행을 지운다. Resolved 행은 번호 순서를 유지한다.
- 1단계에서 찾은 인용을 고친다: 인라인 `**[D<n>]**`은 참조로 남긴다. 엔드포인트가 "아직" 잘못
  동작한다고 말하는 문장(예: "(The pre-existing … still miss this: **D21**.)")은 새 동작으로 다시 쓴다.
- "Suggested test priority"나 "Found by the suite, not yet numbered" 절에서 언급하면 그것도 고친다.

## 7. docs/API.md 고치기

```bash
grep -n "$ID" docs/API.md
```

지금 동작을 설명하는 문장을 다시 쓴다(한국어, 예: "숫자가 아닌 값은 400이어야 하지만 지금은
null로 저장된다(D3)" → "숫자가 아닌 값은 400"). 상태 코드가 바뀌었으면 그 엔드포인트의 상태 목록을
고친다. 클라이언트가 그 오류를 보여 주면 클라이언트가 기대하는 문구를 확인한다(`workbridge-client/src`).

## 8. 요약

보고: 번호, 근본 원인 한 줄, 바꾼 파일, 뒤집은 핀(파일 + 테스트 이름), 함께 뒤집은 다른 핀,
전체 스위트 결과, 옮긴 문서 행. 요청이 없으면 커밋하지 않는다.
