---
name: pre-pr-review
description: PR을 열기 전에 main 대비 브랜치 diff를 /code-review와 REVIEW.md의 번호 항목으로 리뷰하고(pre-PR review), 수정을 적용해 커밋하고, 사람이 봐야 할 지적을 표시한 뒤 리포지토리 템플릿으로 PR을 연다(open a PR)
model: sonnet
allowed-tools: Bash(git:*), Bash(gh pr create:*), Bash(gh pr view:*), Bash(npm run typecheck:*), Bash(npm run lint:*), Bash(npm run build:*), Bash(npm run openapi:*), Bash(npx vitest run:*), Read, Grep, Glob, Edit, Skill
---

# PR 전 리뷰

리포지토리 루트에서, 기능 브랜치에서 돌린다(`main`에서는 절대 돌리지 않는다).

## 1. 범위

```bash
git fetch origin main
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

커밋하지 않은 변경 사항이 있으면 → 멈추고 먼저 커밋할지 묻는다.

## 2. 일반 리뷰

브랜치 diff를 `main`과 비교해 `/code-review medium --fix`를 돌린다(Skill 툴, 스킬
`code-review`, 인자는 `medium --fix`와 대상인 현재 브랜치). 지적마다 결과를 적는다:
`fixed` 또는 `skipped`(와 그 이유).

## 3. WorkBridge 기준 — `REVIEW.md`

`REVIEW.md`를 읽고 diff를 **번호 항목 하나하나**와 대조한다. 항목마다 있는 "확인 방법" 줄을 쓴다
(대부분 `git diff origin/main...HEAD -- <path>`와 grep). 항목마다 `해당 없음`, `통과`, `위반`(file:line과
함께) 중 하나를 적는다.

- 위반은 고치는 방법이 국소적이고 분명할 때만 고친다(예: `console.log` → `logger.info`,
  빠진 `deletedAt: null`, `guardedMutations`에 빠진 라우트).
- 기존 테스트의 단언을 코드에 맞춰 약하게 고치거나, 기존 컨트롤러를 서비스 레이어로 옮기거나 `requireActiveUser`를
  붙이는 것으로 "수정"하지 않는다 — 그런 것은 사람에게 넘길 지적이다.
- 응답 모양이나 상태 코드가 바뀌었는데 `src/openapi/`나 `openapi.json`이 그대로면 위반이다. 등록을 고치고
  `npm run openapi`를 돌리는 것은 국소적인 수정이다.

## 4. 다시 검사

diff가 건드린 곳의 정적 검사를 돌린다:

```bash
(cd workbridge-server && npm run typecheck && npm run lint)     # workbridge-server/**가 바뀌었으면
(cd workbridge-server && npm run openapi && git diff --exit-code openapi.json)   # 같은 경우. 차이가 나면 커밋할 것
(cd workbridge-client && npm run lint && npm run build)   # workbridge-client/**가 바뀌었으면
```

로컬 테스트 DB가 있으면 건드린 서버 코드를 다루는 vitest 파일을 돌린다(`npx vitest run test/<file>.test.ts`).
없으면 스위트는 CI에 맡겼다고 적는다.

## 5. 수정 커밋

적용한 것이 없으면 건너뛴다. 있으면 커밋 하나, 메시지는 한국어:

```bash
git add -A && git commit -m "fix: 리뷰 지적 반영 — <요약>"
```

## 6. 보고하고 기다리기

표를 출력한다: 출처(`code-review` / `REVIEW.md #n`), file:line, 지적, 결과
(`fixed` / `skipped` / `위반 — 사람 확인 필요`). `skipped`인 지적과 고치지 않은 REVIEW.md 위반은 모두
**"사람이 확인해야 할 항목"** 아래에 적는다. 그다음 **사용자의 진행 승인을 기다린다**.

## 7. PR 열기

`.github/PULL_REQUEST_TEMPLATE.md`를 채운다(읽고, 제목과 체크박스를 모두 유지한다): 무엇을 왜 바꿨는지,
관련 이슈 번호(버그 수정이면 `Closes #N`), 어떻게 검증했는지(돌린 검사만 체크한다). 6단계의 "사람이 확인해야
할 항목"은 템플릿의 **"리뷰어가 볼 곳"** 절에 적는다. 본문을 임시 파일에 쓰고:

```bash
git push -u origin HEAD        # 사용자의 승인이 있을 때만
gh pr create --base main --title "<한국어 제목>" --body-file <tmpfile>
```

PR URL을 출력한다.
