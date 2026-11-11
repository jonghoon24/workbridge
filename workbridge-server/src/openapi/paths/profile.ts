import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { z } from '../../lib/zod';
import {
  careerCreateBody,
  careerPatchBody,
  portfolioCreateBody,
  portfolioOrderBody,
  portfolioPatchBody,
  recommendationQuery,
} from '../../schemas/profile';
import {
  ACTIVE_USER,
  bearer,
  binaryFile,
  cause,
  COMPLETE_PROFILE,
  created,
  errors,
  IMAGE_UPLOAD,
  invalid,
  jsonBody,
  NOT_OWNER,
  notFound,
  ok,
  pathParams,
  publicRoute,
  role,
} from '../common';
import type { ErrorSpec } from '../common';
import {
  careerBody,
  careerList,
  deletedBody,
  portfolioItemBody,
  portfolioList,
  profileCompletion,
  recommendedProjects,
} from '../responses/profile';

const tags = ['Portfolio & careers'];

const FREELANCER: ErrorSpec = [...ACTIVE_USER, role('FREELANCER')];
const USER_NOT_FOUND = notFound('USER_NOT_FOUND', '없거나 탈퇴한 사용자');
const ITEM_NOT_FOUND = notFound('PORTFOLIO_ITEM_NOT_FOUND', '없는 포트폴리오 항목');
const CAREER_NOT_FOUND = notFound('CAREER_NOT_FOUND', '없는 경력');

/** JSON, or multipart with the optional `image` file. */
function withImage(schema: z.ZodTypeAny) {
  return {
    required: true,
    content: {
      'application/json': { schema },
      'multipart/form-data': { schema: z.intersection(schema, z.object({ image: binaryFile.optional() })) },
    },
  };
}

export function registerProfilePaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/users/{id}/portfolio',
    operationId: 'getUserPortfolio',
    tags,
    summary: '사용자의 포트폴리오',
    description: '정렬 순서(`sortOrder`)대로. `id`가 `me`여도 다른 없는 사용자처럼 404다.',
    security: publicRoute,
    request: { params: pathParams({ id: '사용자 ID' }) },
    responses: { 200: ok(portfolioList), ...errors(USER_NOT_FOUND) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/{id}/careers',
    operationId: 'getUserCareers',
    tags,
    summary: '사용자의 경력',
    description: '시작 월의 최신순. `careerSummary`는 겹치거나 이어진 기간을 합쳐 센 총 경력이다.',
    security: publicRoute,
    request: { params: pathParams({ id: '사용자 ID' }) },
    responses: { 200: ok(careerList), ...errors(USER_NOT_FOUND) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/users/me/portfolio',
    operationId: 'postPortfolioItem',
    tags,
    summary: '포트폴리오 항목 추가',
    description: '최대 20개. 이미지는 `multipart/form-data`의 `image`(이미지 하나, 5MB)로 보낸다. 새 항목은 맨 뒤에 붙는다.',
    security: bearer,
    request: { body: withImage(portfolioCreateBody) },
    responses: {
      201: created(portfolioItemBody),
      ...errors(invalid(), IMAGE_UPLOAD, FREELANCER, cause('PORTFOLIO_LIMIT_REACHED', '이미 20개')),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/users/me/portfolio/order',
    operationId: 'putPortfolioOrder',
    tags,
    summary: '포트폴리오 순서 바꾸기',
    security: bearer,
    request: { body: jsonBody(portfolioOrderBody) },
    responses: {
      200: ok(portfolioList, '새 순서의 전체 목록'),
      ...errors(
        invalid(),
        cause('PORTFOLIO_ORDER_MISMATCH', '내 항목 전부를 한 번씩 담지 않음'),
        FREELANCER,
      ),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/users/me/portfolio/{itemId}',
    operationId: 'patchPortfolioItem',
    tags,
    summary: '포트폴리오 항목 수정',
    description: '보낸 필드만 바꾼다. 새 이미지(`image`)와 `removeImage: true`를 함께 보낼 수 없다. 월 순서는 저장된 값과 합쳐 검사한다.',
    security: bearer,
    request: { params: pathParams({ itemId: '포트폴리오 항목 ID' }), body: withImage(portfolioPatchBody) },
    responses: {
      200: ok(portfolioItemBody),
      ...errors(
        invalid(
          '`removeImage` `CONFLICT` — 이미지 업로드와 삭제를 함께 요청함',
          '`endedAt` `CONFLICT` — 저장된 값과 합친 시작·끝 월이 맞지 않음',
        ),
        IMAGE_UPLOAD,
        FREELANCER,
        NOT_OWNER,
        ITEM_NOT_FOUND,
      ),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/users/me/portfolio/{itemId}',
    operationId: 'removePortfolioItem',
    tags,
    summary: '포트폴리오 항목 삭제',
    description: '남은 항목의 `sortOrder`는 바꾸지 않는다.',
    security: bearer,
    request: { params: pathParams({ itemId: '포트폴리오 항목 ID' }) },
    responses: { 200: ok(deletedBody), ...errors(FREELANCER, NOT_OWNER, ITEM_NOT_FOUND) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/users/me/careers',
    operationId: 'postCareer',
    tags,
    summary: '경력 추가',
    description: '최대 30개. `endDate`가 없으면(또는 `null`) 재직 중이다.',
    security: bearer,
    request: { body: jsonBody(careerCreateBody) },
    responses: {
      201: created(careerBody),
      ...errors(invalid(), FREELANCER, cause('CAREER_LIMIT_REACHED', '이미 30개')),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/users/me/careers/{careerId}',
    operationId: 'patchCareer',
    tags,
    summary: '경력 수정',
    description: '보낸 필드만 바꾼다. 월 순서는 저장된 값과 합쳐 검사한다.',
    security: bearer,
    request: { params: pathParams({ careerId: '경력 ID' }), body: jsonBody(careerPatchBody) },
    responses: {
      200: ok(careerBody),
      ...errors(
        invalid('`endDate` `CONFLICT` — 저장된 값과 합친 시작·끝 월이 맞지 않음'),
        FREELANCER,
        NOT_OWNER,
        CAREER_NOT_FOUND,
      ),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/users/me/careers/{careerId}',
    operationId: 'removeCareer',
    tags,
    summary: '경력 삭제',
    security: bearer,
    request: { params: pathParams({ careerId: '경력 ID' }) },
    responses: { 200: ok(deletedBody), ...errors(FREELANCER, NOT_OWNER, CAREER_NOT_FOUND) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/profile-completion',
    operationId: 'getMyProfileCompletion',
    tags: ['Users'],
    summary: '프로필 완성도',
    description: '저장된 역할로 계산한다. `isComplete`(프로젝트 등록·지원 조건)와 `percent`(표시용)는 서로 독립이다.',
    security: bearer,
    responses: {
      200: ok(profileCompletion),
      ...errors(ACTIVE_USER, cause('USER_NOT_FOUND', '요청 도중 탈퇴함')),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/recommended-projects',
    operationId: 'getRecommendedProjects',
    tags: ['Recommendations'],
    summary: '나에게 맞는 프로젝트(프리랜서)',
    description: '기술·카테고리로 점수를 매긴 모집 중인 프로젝트. 이미 지원한 프로젝트와 의뢰인이 삭제된 프로젝트는 빠진다. 읽기 전용(수명주기 스윕 없음).',
    security: bearer,
    request: { query: recommendationQuery },
    responses: {
      200: ok(recommendedProjects, '점수 내림차순'),
      ...errors(invalid(), FREELANCER, COMPLETE_PROFILE),
    },
  });
}
