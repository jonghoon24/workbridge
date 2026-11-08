## 변경 요약

<!-- 무엇을 왜 바꿨는지. 동작이 바뀌면 전/후를 적는다. -->

## 관련 이슈

Closes #

## 확인한 것

- [ ] `npm run typecheck` (workbridge-server)
- [ ] `npm test` (workbridge-server)
- [ ] (불일치를 고친 경우) 그 D번호의 `it.fails`를 `it`으로 바꾸고 `docs/BEHAVIOR.md`에서 Resolved로 옮겼다
- [ ] `npm run build` (workbridge-client, 클라이언트를 건드린 경우)
- [ ] E2E / 화면 확인 (클라이언트 흐름을 건드린 경우, 스크린샷 첨부)
- [ ] 문서 — `docs/BEHAVIOR.md`(규칙 변경), `docs/API.md`, `docs/ENV.md`
- [ ] 스키마 변경 시 마이그레이션 포함

## 리뷰어가 볼 곳

<!-- 트랜잭션 경계, 동시성, 돈·시간 계산, 권한 검사 순서처럼 diff만으로는 놓치기 쉬운 곳.
     작성자가 판단하지 못해 사람이 확인해야 할 항목도 여기에 적는다. -->
