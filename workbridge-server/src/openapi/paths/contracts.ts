import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { contractListQuery } from '../../schemas/contracts';
import { milestonePlanBody } from '../../schemas/milestones';
import { ACTIVE_USER, AUTHENTICATED, bearer, cause, errors, invalid, jsonBody, notFound, ok, pathParams, role } from '../common';
import {
  contractConversation,
  contractDetail,
  contractList,
  contractMilestones,
  replacedPlan,
} from '../responses/contracts';

const tags = ['Contracts'];

const contractId = pathParams({ id: '계약 ID' });
const NOT_PARTY = cause('FORBIDDEN_RESOURCE', '계약 당사자가 아님');
const CONTRACT_OR_PROJECT_NOT_FOUND = notFound('CONTRACT_NOT_FOUND', '없는 계약, 또는 프로젝트가 삭제됨');

export function registerContractPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/contracts',
    operationId: 'getMyContracts',
    tags,
    summary: '내 계약 목록',
    description: '의뢰인·프리랜서 어느 쪽이든 내가 당사자인 계약, 최신순. 철회된 계약도 들어 있다. 삭제된 프로젝트의 계약은 빠진다.',
    security: bearer,
    request: { query: contractListQuery },
    responses: { 200: ok(contractList), ...errors(invalid(), ACTIVE_USER) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/contracts/{id}/milestones',
    operationId: 'getContractMilestones',
    tags: ['Milestones'],
    summary: '계약의 마일스톤',
    security: bearer,
    request: { params: contractId },
    responses: {
      200: ok(contractMilestones, '순서(`sequence`)대로'),
      ...errors(ACTIVE_USER, NOT_PARTY, CONTRACT_OR_PROJECT_NOT_FOUND),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/contracts/{id}/milestones',
    operationId: 'putContractMilestones',
    tags: ['Milestones'],
    summary: '마일스톤 계획 바꾸기(의뢰인)',
    description:
      '서명 전(`PENDING`) 계약의 계획 전체를 바꾼다. 금액 합은 계약 금액과 같아야 한다. '
      + '양쪽 서명을 초기화하고, 서명이 있었으면 프리랜서에게 알린다.',
    security: bearer,
    request: { params: contractId, body: jsonBody(milestonePlanBody) },
    responses: {
      200: ok(replacedPlan),
      ...errors(
        invalid(),
        cause('MILESTONE_AMOUNT_MISMATCH', '금액 합이 계약 금액과 다름'),
        ACTIVE_USER,
        role('CLIENT'),
        cause('FORBIDDEN_RESOURCE', '계약의 의뢰인이 아님'),
        CONTRACT_OR_PROJECT_NOT_FOUND,
        cause('MILESTONE_PLAN_LOCKED', '계약이 이미 시작됨'),
        cause('CONTRACT_CANCELLED', '철회된 계약'),
      ),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/contracts/{id}/conversation',
    operationId: 'getConversationOfContract',
    tags: ['Conversations'],
    summary: '계약의 대화방',
    security: bearer,
    request: { params: contractId },
    responses: {
      200: ok(contractConversation, '대화방 ID와 내 안 읽은 메시지 수'),
      ...errors(ACTIVE_USER, NOT_PARTY, [
        cause('CONTRACT_NOT_FOUND', '없는 계약, 또는 프로젝트가 삭제됨'),
        cause('CONVERSATION_NOT_FOUND', '계약에 대화방이 없음'),
      ]),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/contracts/{id}',
    operationId: 'getContract',
    tags,
    summary: '계약 상세',
    description: '마일스톤, 리뷰, 마일스톤 요약을 함께 준다. 프로젝트가 삭제된 계약은 404다.',
    security: bearer,
    request: { params: contractId },
    responses: { 200: ok(contractDetail), ...errors(AUTHENTICATED, NOT_PARTY, CONTRACT_OR_PROJECT_NOT_FOUND) },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/contracts/{id}',
    operationId: 'completeContract',
    tags,
    summary: '계약 완료(폐지됨)',
    description: '계약은 모든 마일스톤이 승인되면 자동으로 완료된다. 이 경로는 언제나 410이다.',
    deprecated: true,
    security: bearer,
    request: { params: contractId },
    responses: {
      ...errors(AUTHENTICATED, cause('MANUAL_COMPLETION_REMOVED', '언제나')),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/contracts/{id}/sign',
    operationId: 'signContract',
    tags,
    summary: '계약 서명',
    description: '양쪽이 서명하면 계약이 `ACTIVE`가 되고 두 당사자에게 알린다. 서명 전 계약은 유효한 마일스톤 계획이 있어야 한다.',
    security: bearer,
    request: { params: contractId },
    responses: {
      200: ok(contractDetail, '서명이 반영된 계약'),
      ...errors(
        cause('CONTRACT_ALREADY_COMPLETED', '이미 완료된 계약'),
        cause('MILESTONE_PLAN_INVALID', '계획이 없거나 금액 합이 맞지 않음'),
        ACTIVE_USER,
        NOT_PARTY,
        CONTRACT_OR_PROJECT_NOT_FOUND,
        cause('CONTRACT_CANCELLED', '철회된 계약'),
      ),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/contracts/{id}/cancel',
    operationId: 'cancelContract',
    tags,
    summary: '서명 전 계약 철회',
    description:
      '서명 대기(`PENDING`) 계약을 의뢰인이나 프리랜서가 철회한다. 한쪽이 이미 서명했어도 된다. '
      + '계약은 `CANCELLED`로 남고(마일스톤·서명·대화방은 그대로), 상대방에게 알린다. 프로젝트는 모집 마감(`CLOSED`)으로 남는다 — '
      + '다시 모집할지는 의뢰인이 정한다(`PATCH /api/projects/{id}/status`).',
    security: bearer,
    request: { params: contractId },
    responses: {
      200: ok(contractDetail, '철회된 계약'),
      ...errors(
        ACTIVE_USER,
        NOT_PARTY,
        CONTRACT_OR_PROJECT_NOT_FOUND,
        cause('CONTRACT_CANCELLED', '이미 철회된 계약'),
        cause('CONTRACT_NOT_CANCELLABLE', '양측 서명으로 시작됐거나 완료된 계약'),
      ),
    },
  });
}
