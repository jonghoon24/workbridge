import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { settlementListQuery } from '../../schemas/settlements';
import { ACTIVE_USER, bearer, cause, errors, invalid, ok, pathParams, role } from '../common';
import { settlementDetail, settlementList, settlementSummary } from '../responses/settlements';

const tags = ['Settlements'];

export function registerSettlementPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/settlements',
    operationId: 'getMySettlements',
    tags,
    summary: '내 정산 목록(프리랜서)',
    description: '정산 기간의 최신순.',
    security: bearer,
    request: { query: settlementListQuery },
    responses: { 200: ok(settlementList), ...errors(invalid(), ACTIVE_USER, role('FREELANCER')) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/settlements/summary',
    operationId: 'getSettlementSummary',
    tags,
    summary: '정산 요약(프리랜서)',
    security: bearer,
    responses: { 200: ok(settlementSummary), ...errors(ACTIVE_USER, role('FREELANCER')) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/settlements/{id}',
    operationId: 'getSettlementById',
    tags,
    summary: '정산 상세(프리랜서)',
    description: '정산에 묶인 항목(마일스톤별)을 승인 순으로 준다.',
    security: bearer,
    request: { params: pathParams({ id: '정산 ID' }) },
    responses: {
      200: ok(settlementDetail),
      ...errors(ACTIVE_USER, role('FREELANCER'), [
        cause('FORBIDDEN_RESOURCE', '내 정산이 아님'),
        cause('SETTLEMENT_NOT_FOUND', '없는 정산'),
      ]),
    },
  });
}
