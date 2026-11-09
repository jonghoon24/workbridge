import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { z } from '../../lib/zod';
import { reviewBody } from '../../schemas/reviews';
import { AUTHENTICATED, bearer, created, errors, invalid, jsonBody, ok, pathParams, publicRoute } from '../common';
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
        invalid(
          '`Reviews can only be written after project completion` — 계약이 완료되지 않음',
          '`Invalid reviewee` — 리뷰 대상이 계약 상대방이 아님',
        ),
        AUTHENTICATED,
        {
          403: ['`Not authorized` — 계약 당사자가 아님'],
          404: ['`Contract not found` — 없는 계약'],
          409: ['`You have already reviewed this contract` — 이 계약에 이미 리뷰를 씀'],
        },
      ),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/reviews/users/{id}',
    operationId: 'getUserReviews',
    tags,
    summary: '사용자가 받은 리뷰',
    description: '최신순이고, 없는 사용자도 빈 배열이다.',
    security: publicRoute,
    request: { params: pathParams({ id: '사용자 ID' }) },
    responses: { 200: ok(z.array(receivedReview)) },
  });
}
