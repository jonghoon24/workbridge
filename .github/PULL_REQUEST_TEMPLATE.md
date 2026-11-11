## 변경 요약

<!-- 무엇을 왜 바꿨는지. 동작이 바뀌면 전/후를 적는다. -->

## 관련 이슈

<!-- 버그 수정이면 그 이슈를 닫는다. -->
Closes #

## 확인한 것

- [ ] `npm run typecheck` (workbridge-server)
- [ ] `npm test` (workbridge-server)
- [ ] (버그 수정) 고치기 전 코드에서 실패하는 회귀 테스트를 추가했다. 기존 테스트의 단언은 약하게 바꾸지 않았다
- [ ] `npm run build` (workbridge-client, 클라이언트를 건드린 경우)
- [ ] E2E / 화면 확인 (클라이언트 흐름을 건드린 경우, 스크린샷 첨부)
- [ ] (API 변경) `src/openapi/`의 경로·응답 스키마를 고치고 `npm run openapi`로 만든 `openapi.json`을 포함했다
- [ ] 문서 — `docs/domain/`(제품 결정과 그 이유), `docs/DATABASE.md`(불변식·제약·잠금), 해당 패키지의 `.env.example`(새 환경변수)
- [ ] 스키마 변경 시 마이그레이션 포함

## 리뷰어가 볼 곳

<!-- 트랜잭션 경계, 동시성, 돈·시간 계산, 권한 검사 순서처럼 diff만으로는 놓치기 쉬운 곳.
     작성자가 판단하지 못해 사람이 확인해야 할 항목도 여기에 적는다. -->
