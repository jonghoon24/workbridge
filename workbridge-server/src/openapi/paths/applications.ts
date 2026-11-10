import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { z } from '../../lib/zod';
import { applicationCreateBody, applicationDecisionBody } from '../../schemas/applications';
import {
  ACTIVE_USER,
  AUTHENTICATED,
  bearer,
  COMPLETE_PROFILE,
  created,
  errors,
  invalid,
  jsonBody,
  NOT_OWNER,
  ok,
  pathParams,
  role,
} from '../common';
import { application, applicationDecision, projectApplication } from '../responses/applications';

const tags = ['Applications'];

export function registerApplicationPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/api/projects/{id}/applications',
    operationId: 'apply',
    tags,
    summary: '프로젝트에 지원(프리랜서)',
    description: '모집 중(`OPEN`)인 프로젝트에만. 의뢰인에게 알린다. 응답 전에 프로젝트 수명주기 스윕을 돌린다(행을 쓴다).',
    security: bearer,
    request: { params: pathParams({ id: '프로젝트 ID' }), body: jsonBody(applicationCreateBody) },
    responses: {
      201: created(application),
      ...errors(
        invalid('`Project is not accepting applications` — 모집 중이 아님(마감이 지난 프로젝트는 스윕이 먼저 마감한다)'),
        ACTIVE_USER,
        role('FREELANCER'),
        COMPLETE_PROFILE,
        { 404: ['`Project not found` — 없거나 삭제된 프로젝트, 또는 의뢰인이 삭제된 프로젝트'] },
        { 409: ['`You have already applied to this project` — 이미 지원함'] },
      ),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/projects/{id}/applications',
    operationId: 'getApplications',
    tags,
    summary: '프로젝트의 지원자(소유 의뢰인)',
    description: '최신순. 마감된 프로젝트라면 대기 중인 지원을 먼저 거절로 바꾼다(행을 쓴다).',
    security: bearer,
    request: { params: pathParams({ id: '프로젝트 ID' }) },
    responses: {
      200: ok(z.array(projectApplication)),
      ...errors(AUTHENTICATED, role('CLIENT'), NOT_OWNER, { 404: ['`Project not found` — 없거나 삭제된 프로젝트'] }),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/projects/{projectId}/applications/{appId}',
    operationId: 'updateApplication',
    tags,
    summary: '지원 수락·거절(소유 의뢰인)',
    description:
      '대기 중인 지원만. 수락하면 한 트랜잭션에서 다른 대기 지원 거절, 계약과 기본 마일스톤(30일 뒤 마감) 생성, '
      + '프로젝트 마감, 알림, 대화방 생성까지 하고 `{ application, contract }`를 준다. 거절하면 지원 하나를 준다.',
    security: bearer,
    request: {
      params: pathParams({ projectId: '프로젝트 ID', appId: '지원 ID' }),
      body: jsonBody(applicationDecisionBody),
    },
    responses: {
      200: ok(applicationDecision, '수락이면 `{ application, contract }`, 거절이면 지원'),
      ...errors(
        invalid(),
        ACTIVE_USER,
        role('CLIENT'),
        NOT_OWNER,
        {
          404: [
            '`Project not found` — 없거나 삭제된 프로젝트',
            '`Application not found` — 이 프로젝트의 지원이 아님',
          ],
          409: [
            '`This application has already been processed` — 대기 중이 아님',
            '`A contract already exists for this project` — 동시에 다른 지원이 수락됨',
          ],
        },
      ),
    },
  });
}
