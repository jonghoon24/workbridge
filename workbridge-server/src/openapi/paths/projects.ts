import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { z } from '../../lib/zod';
import { recommendationQuery } from '../../schemas/profile';
import { projectCreateBody, projectListQuery, projectStatusBody, projectUpdateBody } from '../../schemas/projects';
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
  notFound,
  ok,
  pathParams,
  publicRoute,
  role,
} from '../common';
import { messageBody } from '../responses/common';
import {
  bookmarkState,
  pricingAnalysis,
  project,
  projectDetail,
  projectList,
  recommendedFreelancers,
} from '../responses/projects';

const tags = ['Projects'];

const PROJECT_NOT_FOUND = notFound('Project not found', '없거나 삭제된 프로젝트');
const projectId = pathParams({ id: '프로젝트 ID' });
const SCHEDULE = '`recruitmentStartDate cannot be after deadline` — 모집 시작일이 마감일보다 늦음';

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
    description: `기본은 모집 중(\`OPEN\`)인 프로젝트의 최신순, 한 페이지 10개(최대 50). ${LAZY_SWEEP}`,
    security: publicRoute,
    request: { query: projectListQuery },
    responses: {
      200: ok(projectList),
      ...errors(invalid('`minBudget: must not be greater than maxBudget` — 최소 예산이 최대 예산보다 큼')),
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
      ...errors(invalid(SCHEDULE), AUTHENTICATED, role('CLIENT'), COMPLETE_PROFILE),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/projects/{id}/bookmark',
    operationId: 'getProjectBookmark',
    tags,
    summary: '북마크 여부(프리랜서)',
    description: '없는 프로젝트도 `bookmarked: false`다.',
    security: bearer,
    request: { params: projectId },
    responses: { 200: ok(bookmarkState), ...errors(AUTHENTICATED, role('FREELANCER')) },
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
      ...errors(AUTHENTICATED, role('FREELANCER'), PROJECT_NOT_FOUND),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/projects/{id}/bookmark',
    operationId: 'deleteProjectBookmark',
    tags,
    summary: '북마크 해제(프리랜서)',
    description: '멱등이다. 북마크가 없어도 200.',
    security: bearer,
    request: { params: projectId },
    responses: {
      200: ok(bookmarkState.extend({ bookmarked: z.literal(false) })),
      ...errors(AUTHENTICATED, role('FREELANCER')),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/projects/{id}',
    operationId: 'getProjectById',
    tags,
    summary: '프로젝트 상세',
    description: `AI 단가 분석 결과가 있으면 함께 준다. ${LAZY_SWEEP}`,
    security: publicRoute,
    request: { params: projectId },
    responses: { 200: ok(projectDetail), ...errors(PROJECT_NOT_FOUND) },
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
        invalid(
          '`Cannot change budget or recruitment dates after applications have been submitted` — 지원이 있는데 예산·일정을 보냄',
          SCHEDULE,
        ),
        AUTHENTICATED,
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
      + '완료되지 않은 계약(`PENDING`·`ACTIVE`)이 있으면 지울 수 없다. 완료된 계약만 있으면 지울 수 있다.',
    security: bearer,
    request: { params: projectId },
    responses: {
      200: ok(messageBody, '`Project deleted successfully`'),
      ...errors(AUTHENTICATED, role('CLIENT'), NOT_OWNER, PROJECT_NOT_FOUND, {
        409: ['`Cannot delete a project with an unfinished contract` — 계약이 `PENDING` 또는 `ACTIVE`'],
      }),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/projects/{id}/status',
    operationId: 'updateProjectStatus',
    tags,
    summary: '프로젝트 상태 변경(소유 의뢰인)',
    description:
      '허용 전이: `UPCOMING`→`OPEN`·`CANCELLED`·`CLOSED`, `OPEN`→`CANCELLED`·`CLOSED`, `IN_PROGRESS`→`COMPLETED`·`CANCELLED`. '
      + '`CLOSED`로 바꾸면 대기 중인 지원을 거절하고 지원자에게 알린다.',
    security: bearer,
    request: { params: projectId, body: jsonBody(projectStatusBody) },
    responses: {
      200: ok(project, '바뀐 프로젝트'),
      ...errors(
        invalid('`Cannot transition from <현재> to <요청>` — 허용되지 않는 전이'),
        AUTHENTICATED,
        role('CLIENT'),
        NOT_OWNER,
        PROJECT_NOT_FOUND,
      ),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/projects/{id}/analyze',
    operationId: 'analyzeProject',
    tags,
    summary: 'AI 단가 분석(소유 의뢰인)',
    description:
      'OpenAI(`gpt-4o-mini`)로 기능별 예상 단가를 산정해 저장한다(다시 부르면 덮어쓴다). 총액은 기능별 금액의 합이다. '
      + '레이트 리밋: 사용자당 1시간 5회, 하루 20회 — 프로젝트를 찾기 전에 세므로 404·403·502도 센다.',
    security: bearer,
    request: { params: projectId },
    responses: {
      200: ok(pricingAnalysis),
      ...errors(AUTHENTICATED, role('CLIENT'), NOT_OWNER, PROJECT_NOT_FOUND, {
        429: ['`Too many requests. Try again later.` — 분석 한도 초과'],
        502: [
          '`AI analysis provider request failed` — 공급자 호출 실패(네트워크 오류, 공급자 5xx 등). 공급자 메시지는 싣지 않는다',
          '`AI analysis did not return a response` — 모델이 빈 응답을 줌(`choices`가 비었거나 내용이 없음)',
          '`AI analysis did not return valid feature pricing` — JSON이 아닌 내용이거나 금액이 있는 기능이 하나도 없음',
        ],
      }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/projects/{id}/recommended-freelancers',
    operationId: 'getRecommendedFreelancers',
    tags: ['Recommendations'],
    summary: '프로젝트에 맞는 프리랜서(소유 의뢰인)',
    description: '기술·카테고리·평점·경력으로 점수를 매긴다. 프로필이 완성되지 않았거나 이미 지원한 프리랜서는 빠진다. 읽기 전용.',
    security: bearer,
    request: { params: projectId, query: recommendationQuery },
    responses: {
      200: ok(recommendedFreelancers, '점수 내림차순'),
      ...errors(invalid(), ACTIVE_USER, role('CLIENT'), NOT_OWNER, PROJECT_NOT_FOUND),
    },
  });
}
