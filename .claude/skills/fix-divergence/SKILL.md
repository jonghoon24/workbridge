---
name: fix-divergence
description: Fix one known divergence from docs/BEHAVIOR.md (D3, D5, D6, D8–D22) end to end — flip its it.fails pin, fix the code per the spec, move the row to Resolved, update docs/API.md. Use when asked to "fix D<n>", resolve a known divergence, or make an it.fails test pass.
argument-hint: D<number>
---

# Fix a BEHAVIOR.md divergence

Argument: a divergence id, e.g. `D3`. Work from the repo root; run server commands inside
`workbridge-server/`. A local test DB must exist (`bash scripts/test-db.sh`, inside the server).

## 1. Read the spec

```bash
ID=$ARGUMENTS                                 # e.g. D3
grep -n "| \*\*$ID\*\* |" docs/BEHAVIOR.md     # the row in "Known divergences" → "Outstanding"
grep -n "\[$ID\]\|$ID\b" docs/BEHAVIOR.md      # every place the spec cites it
```

- The row has `Issue | Intended | Current`. **Intended** is the target; the cited spec sections
  (endpoint section, cross-cutting rule 1–12) give the exact status code and message.
- If the row says "decided in Q<n>", read that answer under "Open questions → Decided".
  If the intended behavior depends on a question still under "Still open", stop and ask.

## 2. Find the pin

```bash
grep -rn "\[$ID\]" workbridge-server/test/
```

- Every pin is an `it.fails(...)` (or `it.fails.each`) whose name ends in `[$ID]`.
- Cross-cutting pins live in the central matrices, not per endpoint: D12 →
  `test/soft-delete.test.ts` `mutations`; D21 → `soft-delete.test.ts`; role/401 issues →
  `test/authorization.test.ts`.
- No pin found → write one first (an `it.fails` asserting the Intended behavior, built with
  `test/helpers/factories.ts`), run it, confirm it fails for the right reason.

## 3. Flip the pin and watch it fail

Change `it.fails` → `it` for exactly the pins of this id. Then:

```bash
cd workbridge-server && npx vitest run test/<file>.test.ts
```

It must fail, and the failure must be the divergence described in the row (e.g. 200 instead of
400). If it fails for another reason, fix the test setup first.

## 4. Fix the code

- Fix in the layer the endpoint already uses. Pre-existing controllers (auth, users, projects,
  applications, contracts, payments, reviews, notifications) keep inline checks — **don't add zod,
  a service, or `requireActiveUser` there** (`.claude/rules/server-layers.md`). D12 is the
  exception that needs a deliberate design decision; ask before changing it.
- `throw new AppError(message, status)`; malformed input → 400, unique collision → 409 (catch
  P2002 **outside** the transaction, like the D4 fix), provider failure → 502.
- Keep multi-row changes in one `prisma.$transaction`; filter `deletedAt: null`.
- Money via `lib/money.ts`, calendar via `lib/time.ts`, logging via `lib/logger.ts`.

## 5. Verify

```bash
npx vitest run test/<file>.test.ts   # the flipped pins now pass
npm run typecheck
npm test                             # full suite, ~90 s
```

A fix can make *another* `it.fails` pass unexpectedly (vitest reports it as a failure). That pin
covered the same root cause: flip it too and record it in the same row. Never re-add `.fails`
to silence it.

## 6. Move the row in BEHAVIOR.md

Follow how D1, D2, D4 and D7 are recorded under "Known divergences → Resolved":

```
| **D<n>** | <Was: what the code did, past tense> | <Fix: what changed, and why that way> | <Verified by: the assertions that now pass> |
```

- Delete the row from "Outstanding"; keep resolved rows in id order.
- Update the citations found in step 1: an inline `**[D<n>]**` stays as a reference; prose that
  says the endpoint "still" misbehaves (e.g. "(The pre-existing … still miss this: **D21**.)")
  must be rewritten to the new behavior.
- If the "Suggested test priority" or "Found by the suite, not yet numbered" sections mention it,
  update them too.

## 7. Update docs/API.md

```bash
grep -n "$ID" docs/API.md
```

Rewrite the sentence about current behavior (Korean, e.g. "숫자가 아닌 값은 400이어야 하지만 지금은
null로 저장된다(D3)" → "숫자가 아닌 값은 400"). If a status code changed, update the endpoint's status
list. If the client shows that error, check the wording the client expects (`workbridge-client/src`).

## 8. Summarize

Report: the id, the root cause in one line, files changed, the pins flipped (file + test name),
any extra pins that flipped, the full-suite result, and the doc rows moved. Don't commit unless
asked.
