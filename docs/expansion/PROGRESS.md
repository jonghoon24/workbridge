# 확장 진행 상태

단계는 PLAN.md §3을 따른다. 각 단계는 계획 → 계획 검토 → 구현 → 검증 → 지적 반영 → 커밋 순으로 간다. 완료한 단계는 마지막 커밋 해시를 적는다.

| 단계 | 상태 | 비고 |
|---|---|---|
| 계획 | 완료 | PLAN.md 1차 검토(reviews/PLAN_REVIEW_1.md) 24건 반영 |
| P0 인프라 | 완료 | c9d04b4. 검증 1차 반영(reviews/P0_REVIEW_1.md). 서버 테스트 1151 통과, it.fails 63(변화 없음), todo 1. 결정은 DECISIONS.md "P0" |
| P1 마일스톤과 정산 | 완료 | f670600. 검증 1차 반영(reviews/P1_REVIEW_1.md). 명세 1c560e1·29a8a1a, 스키마 f10f7af, 서버 91e8f3a·ed9d7e4·f1c3e09, 클라이언트 병합 5d1769f. 서버 테스트 1474 통과, it.fails 62(63에서 D12 PATCH·D21 completeContract 행이 빠지고 D22가 더해짐), todo 1. 결정은 DECISIONS.md "P1" 절들 |
| P2-S 메시지·프로필 명세와 스키마 | 완료 | c3f5584. 별도 worktree에서 P1 수정과 병렬로 만든 뒤 병합. 병합 트리에서 1474 통과 / 62 핀 / 1 todo 확인 |
| P2A 메시지 | 완료 | cfa2824. P2B 뒤에 병합. P2 검증 1차(reviews/P2_REVIEW_1.md, 병합 트리 bc1d263): 판정 "P3 시작 가능", 블로커 없음, 1901 통과 / 62 핀 / 1 todo(두 번 동일) |
| P2B 프로필 확장 | 완료 | 559a1ba. 서버·클라이언트 모두 worktree에서 구현, 2A보다 먼저 병합. 병합 트리 1716 통과 / 62 핀 / 1 todo. 통합 검증은 2A 병합 뒤 P2 전체로. P2 검증 1차(reviews/P2_REVIEW_1.md)의 지적 1·2·3·4·6·7 반영, 5는 후속 과제 |
| P3 알림 채널 | 완료 | 9e0f462. 명세·스키마(P3-S)는 P2 구현과 병렬로 작성·검토 후 bc1d263에 병합, 구현은 5242573에 병합. 검증 1차 반영(reviews/P3_REVIEW_1.md: 판정 "P4 시작 가능", 블로커 없음). 병합 직후 2014는 `guardedMutations` 중복 행 1개를 센 수라 실제는 2013 통과 / 62 핀 / 1 todo. 지적 반영 뒤 2015(+NC13 링크 기준 테스트, +`guardedMutations` 라벨 중복 검사) |
| P4 마무리 | 진행 중 | 코드 정리(main checkout): P3 지적 1–4 9e0f462, 헬퍼 통합 d1f5fec(서버 `lib/locks.ts` `lockUserRow`, 클라이언트 `lib/serverErrors.js` `describeServerError`, `profileFormat.js`가 `lib/format.js`의 `kstToday` 사용), D13 flake 32b2042(Payment 테이블 SHARE 잠금으로 경합 고정, payments.test.ts 10회 중 10회 통과), 헤더 "추천 프로젝트"·`/payments` 보호 dffa804. 서버 테스트 2015 통과 / 62 핀 / 1 todo(두 번 동일). 시드·문서는 별도 worktree(p4)에서 진행, 그 뒤 최종 검증(PLAN §5.3) |

## 후속 과제

- P3 검증 1차 지적 2의 문서 절반: `docs/ENV.md`의 `CLIENT_URL`에 "쉼표 목록이면 첫 항목을 메일 링크 기준으로 쓴다"를 더한다. ENV.md는 P4 시드·문서 워커 소유라 코드 정리에서 손대지 않았다.
