---
name: pre-pr-review
description: Review the branch diff against main with /code-review and the numbered criteria in REVIEW.md, apply and commit fixes, flag findings needing human attention, then open a PR with the repository template
model: sonnet
allowed-tools: Bash(git:*), Bash(gh pr create:*), Bash(gh pr view:*), Bash(npm run typecheck:*), Bash(npm run lint:*), Bash(npm run build:*), Bash(npx vitest run:*), Read, Grep, Glob, Edit, Skill
---

# Pre-PR review

Run from the repo root on a feature branch (never on `main`).

## 1. Scope

```bash
git fetch origin main
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Uncommitted changes → stop and ask whether to commit them first.

## 2. Generic review

Run `/code-review medium --fix` on the branch diff against `main` (Skill tool, skill
`code-review`, args `medium --fix` plus the current branch as target). Record each finding with its outcome:
`fixed` or `skipped` (and why).

## 3. WorkBridge criteria — `REVIEW.md`

Read `REVIEW.md` and check the diff against **every numbered item**, using each item's
"확인 방법" line (mostly `git diff origin/main...HEAD -- <path>` plus a grep). For each item record
`해당 없음`, `통과`, or `위반` with file:line.

- Fix a violation only when the fix is local and unambiguous (e.g. `console.log` → `logger.info`,
  a missing `deletedAt: null`, a route missing from `guardedMutations`).
- Never "fix" by flipping an `it.fails` pin, adding zod/services/`requireActiveUser` to a
  pre-existing controller, or editing an applied migration — those are findings for a human.

## 4. Re-check

Run the static checks for what the diff touched (the Stop hook does the same):

```bash
(cd workbridge-server && npm run typecheck)     # if workbridge-server/** changed
(cd workbridge-client && npm run lint && npm run build)   # if workbridge-client/** changed
```

Run the vitest files that cover touched server code (`npx vitest run test/<file>.test.ts`) if a
local test DB exists; otherwise say the suite was left to CI.

## 5. Commit the fixes

Skip if nothing was applied. Otherwise one commit, Korean message:

```bash
git add -A && git commit -m "fix: 리뷰 지적 반영 — <요약>"
```

## 6. Report and wait

Print a table: source (`code-review` / `REVIEW.md #n`), file:line, finding, outcome
(`fixed` / `skipped` / `위반 — 사람 확인 필요`). List every `skipped` finding and every unfixed
REVIEW.md violation under **"사람이 확인해야 할 항목"**. Then **wait for the user's go-ahead**.

## 7. Open the PR

Fill `.github/PULL_REQUEST_TEMPLATE.md` (read it; keep every heading and checkbox): what changed
and why, the BEHAVIOR.md rule ids or D-numbers touched, how it was verified, and the
"사람이 확인해야 할 항목" list. Write the body to a temp file and:

```bash
git push -u origin HEAD        # only with the user's go-ahead; never --force
gh pr create --base main --title "<한국어 제목>" --body-file <tmpfile>
```

Print the PR URL. The CI reviewer will read the same `REVIEW.md`.
