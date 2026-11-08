# E2E 테스트 (Playwright)

핵심 흐름 5개를 실제 서버·DB에 대고 브라우저로 확인한다: 로그인(`auth`), 프로젝트 등록(`project-create`), 지원(`apply`), 수락·서명(`accept-contract`), 마일스톤 결제·제출·승인(`milestone`).

```bash
bash scripts/e2e.sh                 # 리포지토리 루트에서. DB 생성·마이그레이션·시드 → 서버 :4002, 클라이언트 :3002 → 테스트 → 종료
bash scripts/e2e.sh e2e/apply.spec.js --headed   # 뒤의 인자는 playwright test로 넘어간다
E2E_SKIP_SEED=1 bash scripts/e2e.sh # 시드 없이 같은 DB로 다시 돌린다(재실행 확인)
```

- DB는 `workbridge_e2e`(`E2E_DB` 또는 `E2E_DATABASE_URL`로 바꾼다). **시드가 모든 테이블을 비우므로** 다른 DB를 가리키지 말 것.
- 포트는 `E2E_SERVER_PORT`/`E2E_CLIENT_PORT`, 클라이언트는 기본 `next dev`, `CI=true`나 `E2E_CLIENT_MODE=prod`면 `next build && next start`.
- 서버가 이미 떠 있으면 `cd workbridge-client && E2E_BASE_URL=http://localhost:3002 npm run e2e`.
- **`E2E_BASE_URL`은 로컬 주소(`localhost`, `127.0.0.1`)만 받는다.** 스펙이 `[E2E]` 프로젝트·계약을 실제로 만들기 때문에, 배포된 주소를 가리키면 그 환경의 DB에 테스트 데이터가 남는다. 운영 주소로는 돌리지 않는다. 버려도 되는 환경에서만 `E2E_ALLOW_REMOTE=1`을 함께 준다.
- 각 스펙은 `beforeAll`에서 API(`helpers/api.js`)로 새 프로젝트·지원·계약을 만들고 화면으로만 확인한다. 시드 행을 바꾸지 않으므로 같은 DB에서 몇 번이고 다시 돌릴 수 있다.
- `helpers/fixtures.js`의 `clientPage`(kim)·`freelancerPage`(park)는 각자 브라우저 컨텍스트로 로그인된 페이지이고, `confirm`/`alert`는 자동 수락하며 메시지를 `page.dialogs`에 남긴다.
- 실패하면 `workbridge-client/playwright-report/`(HTML 리포트)와 `test-results/`(trace, 스크린샷, `e2e-logs/`의 서버·클라이언트 로그)를 본다. CI는 이 둘을 아티팩트로 올린다.
