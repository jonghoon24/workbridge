import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { withdrawalBody } from '../../schemas/account';
import { ACTIVE_USER, bearer, errors, invalid, jsonBody, ok } from '../common';
import { withdrawalStatus } from '../responses/account';
import { messageBody } from '../responses/common';

const tags = ['Account'];

/** Withdrawal (docs/domain/accounts.md "회원 탈퇴"). Changing the password lives with the auth routes. */
export function registerAccountPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/users/me/withdrawal',
    operationId: 'getWithdrawalStatus',
    tags,
    summary: '탈퇴할 수 있는지',
    description: '지금 탈퇴할 수 있는지와, 막는 항목(진행 중인 계약, 받지 않은 돈)을 항목별 개수로 준다.',
    security: bearer,
    responses: {
      200: ok(withdrawalStatus, '탈퇴 가능 여부와 막는 항목'),
      ...errors(ACTIVE_USER),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/users/me/withdrawal',
    operationId: 'withdraw',
    tags,
    summary: '회원 탈퇴',
    description:
      '비밀번호가 있는 계정은 현재 비밀번호로 다시 확인한다(틀린 횟수는 비밀번호 변경과 같은 카운터로 센다). '
      + 'Google로만 가입한 계정은 `reauthToken`으로 확인한다: 연결된 구글 계정으로 방금 다시 로그인했다는 짧게 사는 증명으로, '
      + '`GET /api/auth/google/reauth`가 이끄는 콜백이 탈퇴 화면의 `#reauthToken=`으로 준다. '
      + '진행 중인 계약이나 받지 않은 돈이 있으면 409. 탈퇴하면 계약 없는 내 프로젝트는 삭제되고 그 대기 지원은 거절되며, '
      + '결정 전 내 지원은 철회된다. 프로필·포트폴리오·경력·지급 계좌·북마크·알림은 지워지고, 이름과 이메일은 알아볼 수 없게 바뀐 채 '
      + '계정이 소프트 삭제된다. 계약·결제·정산·메시지·쓴 리뷰는 남는다. 리프레시 쿠키는 지우지 않으니 이어서 로그아웃한다.',
    security: bearer,
    request: { body: jsonBody(withdrawalBody) },
    responses: {
      200: ok(messageBody, '`Account withdrawn`'),
      ...errors(
        invalid(
          '`Current password is required` — 비밀번호가 있는 계정인데 `currentPassword`가 없음',
          '`Current password is incorrect` — 현재 비밀번호가 틀림(실패로 센다)',
          '`Google re-authentication is required` — Google 전용 계정인데 `reauthToken`이 없음',
          '`Google re-authentication is invalid or expired` — 증명이 만료됐거나, 이 계정·탈퇴용·연결된 구글 계정의 것이 아님',
        ),
        ACTIVE_USER,
        {
          409: ['`Cannot withdraw while contracts or settlements are unfinished` — 진행 중이거나 서명 전인 계약, 미정산·미지급·보류 정산이 있음'],
          429: ['`Too many requests. Try again later.` — 현재 비밀번호를 너무 많이 틀림'],
        },
      ),
    },
  });
}
