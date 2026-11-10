import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { z } from '../../lib/zod';
import { milestonePaymentBody, paymentConfirmBody } from '../../schemas/payments';
import { AUTHENTICATED, bearer, created, errors, invalid, jsonBody, ok } from '../common';
import type { ErrorSpec } from '../common';
import { payment, paymentOrder, paymentWithContext } from '../responses/contracts';

const tags = ['Payments'];

const FUNDING_CHECKS: ErrorSpec = {
  400: [
    '`Contract must be active to proceed with payment` — 계약이 `ACTIVE`가 아님',
    '`Earlier milestones must be funded first` — 앞 순서 마일스톤이 아직 결제되지 않음',
  ],
  403: ['`Not authorized` — 계약의 의뢰인이 아님'],
  404: ['`Milestone not found` — 없는 마일스톤, 또는 프로젝트가 삭제됨'],
};

export function registerPaymentPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/api/payments',
    operationId: 'createPayment',
    tags,
    summary: '마일스톤 결제 준비',
    description:
      '토스페이먼츠 결제창에 넘길 주문을 만든다. 대기 중인 결제가 있으면 그 주문을, 실패한 결제가 있으면 새 주문 ID로 '
      + '되살려 200으로 준다. 새로 만들면 201.',
    security: bearer,
    request: { body: jsonBody(milestonePaymentBody) },
    responses: {
      200: ok(paymentOrder, '기존 결제의 주문'),
      201: created(paymentOrder, '새 결제의 주문'),
      ...errors(invalid(), AUTHENTICATED, FUNDING_CHECKS, {
        409: [
          '`Milestone is already funded` — 이미 결제된 마일스톤',
          '`Payment already completed for this milestone` — 결제는 완료됐는데 마일스톤이 결제 전(데이터 불일치)',
          '`Payment cannot be created for this milestone` — 환불된 결제가 있음',
        ],
      }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/payments/confirm',
    operationId: 'confirmPayment',
    tags,
    summary: '결제 승인',
    description:
      '토스페이먼츠 결제창이 돌려준 값으로 결제를 승인하고 마일스톤을 결제 완료(`FUNDED`)로 바꾼다. '
      + '토스 승인 요청이나 그 뒤 저장이 실패하면 결제를 `FAILED`로 바꾸고 400을 준다.',
    security: bearer,
    request: { body: jsonBody(paymentConfirmBody) },
    responses: {
      200: ok(payment, '완료된 결제'),
      ...errors(
        invalid(
          '`Payment amount does not match the contract amount` — 금액이 결제 금액과 다름',
          '`Payment verification failed` — 토스 승인 실패, 금액·상태 불일치, 또는 승인 뒤 저장 실패',
        ),
        AUTHENTICATED,
        {
          403: ['`Not authorized` — 결제한 의뢰인이 아님'],
          404: ['`Payment not found` — 없는 주문, 또는 프로젝트가 삭제됨'],
          409: ['`Payment has already been processed` — 대기 중인 결제가 아님'],
        },
      ),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/payments/dev-complete',
    operationId: 'completePaymentForDev',
    tags,
    summary: '개발용 결제 완료',
    description:
      '`ALLOW_PAYMENT_BYPASS=true`일 때만 동작한다(운영에서는 꺼 둔다). 토스 없이 결제를 완료하고 마일스톤을 결제 완료로 바꾼다. '
      + '결제 행을 새로 만들면 201, 기존 행을 완료하거나 이미 완료된 결제를 돌려주면 200.',
    security: bearer,
    request: { body: jsonBody(milestonePaymentBody) },
    responses: {
      200: ok(payment, '기존 결제를 완료했거나 이미 완료된 결제'),
      201: created(payment, '새로 만든 완료 결제'),
      ...errors(
        { 403: ['`Payment bypass is disabled` — 결제 우회가 꺼져 있음(요청 검증보다 먼저)'] },
        invalid(),
        AUTHENTICATED,
        FUNDING_CHECKS,
        {
          409: [
            '`Milestone is already funded` — 결제 완료가 아닌 결제로 이미 진행된 마일스톤',
            '`Payment cannot be completed for a refunded milestone` — 환불된 결제가 있음',
          ],
        },
      ),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/payments',
    operationId: 'getPayments',
    tags,
    summary: '내 결제 내역(의뢰인)',
    description: '내가 결제한 것만, 최신순. 프리랜서는 빈 배열이다.',
    security: bearer,
    responses: { 200: ok(z.array(paymentWithContext)), ...errors(AUTHENTICATED) },
  });
}
