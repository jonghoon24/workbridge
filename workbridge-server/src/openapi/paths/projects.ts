import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { z } from '../../lib/zod';
import { projectCreateBody, projectListQuery, projectStatusBody, projectUpdateBody } from '../../schemas/projects';
import {
  ACTIVE_USER,
  AUTHENTICATED,
  bearer,
  cause,
  COMPLETE_PROFILE,
  created,
  errors,
  invalid,
  jsonBody,
  NOT_OWNER,
  notFound,
  ok,
  pathParams,
  publicRoute,
  role,
} from '../common';
import { messageBody } from '../responses/common';
import {
  bookmarkState,
  project,
  projectDetail,
  projectList,
} from '../responses/projects';

const tags = ['Projects'];

const PROJECT_NOT_FOUND = notFound('PROJECT_NOT_FOUND', '없거나 삭제된 프로젝트');
/** Public reads also hide a project whose client is soft-deleted. */
const PUBLIC_PROJECT_NOT_FOUND = notFound('PROJECT_NOT_FOUND', '없거나 삭제된 프로젝트, 또는 의뢰인이 삭제된 프로젝트');
const projectId = pathParams({ id: '프로젝트 ID' });
const SCHEDULE = '`deadline` `CONFLICT` — 모집 시작일이 마감일보다 늦음';

/** Rule 7: the read path closes what the scheduler may not have yet. */
const LAZY_SWEEP =
  '**행을 쓴다:** 응답 전에 지연 수명주기 스윕을 돌린다 — 모집 시작일이 지난 `UPCOMING`은 `OPEN`, '
  + '마감이 지난 `UPCOMING`·`OPEN`은 `CLOSED`로 바꾸고 그 프로젝트의 대기 중인 지원을 거절한다.';

export function registerProjectPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/projects',
    operationId: 'getProjects',
    tags,
    summary: '프로젝트 목록',
    description: `기본은 모집 중(\`OPEN\`)인 프로젝트의 최신순, 한 페이지 10개(최대 50). 삭제된 프로젝트와 의뢰인이 삭제된 프로젝트는 빠진다. ${LAZY_SWEEP}`,
    security: publicRoute,
    request: { query: projectListQuery },
    responses: {
      200: ok(projectList),
      ...errors(invalid('`minBudget` `CONFLICT` — 최소 예산이 최대 예산보다 큼')),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/projects',
    operationId: 'createProject',
    tags,
    summary: '프로젝트 등록(의뢰인)',
    description: '모집 시작일을 생략하면 지금이다. 시작일이 미래면 `UPCOMING`, 아니면 `OPEN`으로 만든다.',
    security: bearer,
    request: { body: jsonBody(projectCreateBody) },
    responses: {
      201: created(project),
      ...errors(invalid(SCHEDULE), ACTIVE_USER, role('CLIENT'), COMPLETE_PROFILE),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/projects/{id}/bookmark',
    operationId: 'getProjectBookmark',
    tags,
    summary: '북마크 여부(프리랜서)',
    description: '프로젝트가 없거나 삭제됐으면(의뢰인이 삭제된 프로젝트 포함) 404다.',
    security: bearer,
    request: { params: projectId },
    responses: { 200: ok(bookmarkState), ...errors(AUTHENTICATED, role('FREELANCER'), PUBLIC_PROJECT_NOT_FOUND) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/projects/{id}/bookmark',
    operationId: 'createProjectBookmark',
    tags,
    summary: '북마크(프리랜서)',
    description: '멱등이다. 이미 북마크했어도 201.',
    security: bearer,
    request: { params: projectId },
    responses: {
      201: created(bookmarkState.extend({ bookmarked: z.literal(true) })),
      ...errors(ACTIVE_USER, role('FREELANCER'), PUBLIC_PROJECT_NOT_FOUND),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/projects/{id}/bookmark',
    operationId: 'deleteProjectBookmark',
    tags,
    summary: '북마크 해제(프리랜서)',
    description: '멱등이다. 프로젝트가 있으면 북마크가 없어도 200. 프로젝트가 없거나 삭제됐으면(의뢰인이 삭제된 프로젝트 포함) 404다.',
    security: bearer,
    request: { params: projectId },
    responses: {
      200: ok(bookmarkState.extend({ bookmarked: z.literal(false) })),
      ...errors(ACTIVE_USER, role('FREELANCER'), PUBLIC_PROJECT_NOT_FOUND),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/projects/{id}',
    operationId: 'getProjectById',
    tags,
    summary: '프로젝트 상세',
    description: LAZY_SWEEP,
    security: publicRoute,
    request: { params: projectId },
    responses: { 200: ok(projectDetail), ...errors(PUBLIC_PROJECT_NOT_FOUND) },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/projects/{id}',
    operationId: 'updateProject',
    tags,
    summary: '프로젝트 수정(소유 의뢰인)',
    description: '보낸 필드만 바꾼다. 지원이 하나라도 있으면 예산과 모집 일정은 보내는 것 자체가 400이다.',
    security: bearer,
    request: { params: projectId, body: jsonBody(projectUpdateBody) },
    responses: {
      200: ok(project, '수정된 프로젝트'),
      ...errors(
        invalid(SCHEDULE),
        cause('PROJECT_TERMS_LOCKED', '지원이 있는데 예산·일정을 보냄'),
        ACTIVE_USER,
        role('CLIENT'),
        NOT_OWNER,
        PROJECT_NOT_FOUND,
      ),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/projects/{id}',
    operationId: 'deleteProject',
    tags,
    summary: '프로젝트 삭제(소유 의뢰인)',
    description:
      '소프트 삭제다. 이후 목록·상세와 그 프로젝트의 계약·마일스톤·대화 경로에서 404가 된다. '
      + '계약이 하나라도 있으면(서명 대기·진행 중·완료·철회) 지울 수 없다. 계약은 상대방의 기록이기도 하다.',
    security: bearer,
    request: { params: projectId },
    responses: {
      200: ok(messageBody, '`Project deleted successfully`'),
      ...errors(ACTIVE_USER, role('CLIENT'), NOT_OWNER, PROJECT_NOT_FOUND, [
        cause('PROJECT_HAS_ACTIVE_CONTRACT', '계약이 `PENDING` 또는 `ACTIVE`'),
        cause('PROJECT_HAS_CONTRACT_RECORD', '완료되거나 철회된 계약이 있음(상대방의 기록)'),
      ]),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/projects/{id}/status',
    operationId: 'updateProjectStatus',
    tags,
    summary: '프로젝트 상태 변경(소유 의뢰인)',
    description:
      '허용 전이: `UPCOMING`→`OPEN`·`CANCELLED`·`CLOSED`, `OPEN`→`CANCELLED`·`CLOSED`, `CLOSED`→`OPEN`(다시 모집하기). '
      + '`IN_PROGRESS`(계약 서명으로 시작)와 `COMPLETED`(마지막 마일스톤 승인)는 시스템만 바꾼다. '
      + '`CLOSED`로 바꾸면 대기 중인 지원을 거절하고 그 지원자에게만 알린다. '
      + '다시 모집할 때는 새 마감일(`deadline`)이 필요하고, 철회되지 않은 계약이 있으면 할 수 없다. 모집 시작일이 아직 오지 않았으면 `UPCOMING`이 된다. 아무에게도 알리지 않는다.',
    security: bearer,
    request: { params: projectId, body: jsonBody(projectStatusBody) },
    responses: {
      200: ok(project, '바뀐 프로젝트'),
      ...errors(
        invalid(
          '`deadline` `REQUIRED` — 다시 모집하는데 마감일이 없음',
          '`deadline` `TOO_SMALL` — 다시 모집할 마감일이 이미 지남',
          '`deadline` `NOT_ALLOWED` — 다시 모집하기가 아닌 전이에 마감일을 보냄',
          SCHEDULE,
        ),
        cause('PROJECT_STATUS_TRANSITION_INVALID', '허용되지 않는 전이'),
        ACTIVE_USER,
        role('CLIENT'),
        NOT_OWNER,
        PROJECT_NOT_FOUND,
        cause('REOPEN_BLOCKED_BY_CONTRACT', '철회되지 않은 계약(서명 대기 등)이 있음'),
      ),
    },
  });
}
