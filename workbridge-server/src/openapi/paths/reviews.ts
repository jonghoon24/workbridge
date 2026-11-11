import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { z } from '../../lib/zod';
import { reviewBody } from '../../schemas/reviews';
import { ACTIVE_USER, bearer, cause, created, errors, invalid, jsonBody, ok, pathParams, publicRoute } from '../common';
import { receivedReview, review } from '../responses/reviews';

const tags = ['Reviews'];

export function registerReviewPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/api/reviews',
    operationId: 'createReview',
    tags,
    summary: '리뷰 작성',
    description: '완료된 계약의 당사자가 상대방에게 한 번만 쓴다.',
    security: bearer,
    request: { body: jsonBody(reviewBody) },
    responses: {
      201: created(review),
      ...errors(
        invalid(),
        cause('CONTRACT_NOT_COMPLETED', '계약이 완료되지 않음'),
        cause('REVIEWEE_INVALID', '리뷰 대상이 계약 상대방이 아님'),
        ACTIVE_USER,
        cause('FORBIDDEN_RESOURCE', '계약 당사자가 아님'),
        cause('CONTRACT_NOT_FOUND', '없는 계약, 또는 프로젝트가 삭제됨'),
        cause('REVIEW_ALREADY_EXISTS', '이 계약에 이미 리뷰를 씀'),
      ),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/reviews/users/{id}',
    operationId: 'getUserReviews',
    tags,
    summary: '사용자가 받은 리뷰',
    description: '최신순이고, 없거나 삭제된 사용자는 빈 배열이다(삭제된 사용자가 받은 리뷰는 숨긴다).',
    security: publicRoute,
    request: { params: pathParams({ id: '사용자 ID' }) },
    responses: { 200: ok(z.array(receivedReview)) },
  });
}
