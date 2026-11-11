import { z } from '../../lib/zod';
import { count } from './common';

/** `GET /api/users/me/withdrawal`. */
export const withdrawalStatus = z
  .object({
    canWithdraw: z.boolean().openapi({ description: '막는 항목이 하나도 없으면 `true`' }),
    hasPassword: z.boolean().openapi({ description: '탈퇴할 때 현재 비밀번호를 보내야 하는 계정인지. `false`(Google 전용 계정)면 구글 재인증 증명(`reauthToken`)을 보낸다' }),
    blockers: z.object({
      unfinishedContracts: count.openapi({ description: '서명 전(`PENDING`)이거나 진행 중(`ACTIVE`)인 계약. 의뢰인·프리랜서 모두, 프로젝트가 삭제됐어도 센다' }),
      unsettledEarnings: count.openapi({ description: '승인됐지만 아직 주간 정산에 묶이지 않은 마일스톤' }),
      unpaidSettlements: count.openapi({ description: '지급되지 않은 정산: 지급 예정·지급 중·지급 실패' }),
      heldSettlements: count.openapi({ description: '지급 계좌가 없어 보류된 정산' }),
    }),
  })
  .openapi('WithdrawalStatus');
