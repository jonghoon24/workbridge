import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { z } from '../../lib/zod';
import { payoutAccountBody as payoutAccountRequest } from '../../schemas/settlements';
import { clientProfileUpdateBody, freelancerProfileUpdateBody } from '../../schemas/users';
import {
  ACTIVE_USER,
  AUTHENTICATED,
  bearer,
  errors,
  invalid,
  jsonBody,
  ok,
  pathParams,
  publicRoute,
  role,
} from '../common';
import { myApplication } from '../responses/applications';
import { bookmarkedProject, myProject } from '../responses/projects';
import { receivedReview } from '../responses/reviews';
import {
  myProfile,
  payoutAccountBody,
  payoutAccountDeletedBody,
  payoutAccountPutBody,
  publicProfile,
} from '../responses/users';

const tags = ['Users'];
const payoutTags = ['Payout account'];

const PAYOUT_LOCKED = { 409: ['`Payout account cannot be changed while a payout is processing` — 지급 중(`PROCESSING`)인 정산이 있음'] };

export function registerUserPaths(registry: OpenAPIRegistry): void {
  // `PATCH /me` validates the caller's role's fields only and strips the other role's: one
  // body schema per role, documented as `oneOf`.
  registry.register('ClientProfileUpdate', clientProfileUpdateBody);
  registry.register('FreelancerProfileUpdate', freelancerProfileUpdateBody);
  const byRole = {
    oneOf: [
      { $ref: '#/components/schemas/ClientProfileUpdate' },
      { $ref: '#/components/schemas/FreelancerProfileUpdate' },
    ],
    description: '호출자 역할의 스키마로 검증한다. 다른 역할의 필드는 검증하지 않고 버린다.',
  };

  registry.registerPath({
    method: 'get',
    path: '/api/users/me',
    operationId: 'getMe',
    tags,
    summary: '내 프로필',
    security: bearer,
    responses: {
      200: ok(myProfile),
      ...errors(AUTHENTICATED, { 404: ['`User not found` — 탈퇴한 사용자'] }),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/users/me',
    operationId: 'updateMe',
    tags,
    summary: '내 프로필 수정',
    description:
      '보낸 필드만 바꾼다. 프로필 이미지는 `multipart/form-data`의 `profileImage`(이미지 하나, 5MB)로 보낸다. '
      + '이미지가 아니거나 5MB를 넘으면 지금은 500이 난다(알려진 버그).',
    security: bearer,
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: byRole },
          'multipart/form-data': {
            schema: {
              allOf: [byRole, { type: 'object', properties: { profileImage: { type: 'string', format: 'binary' } } }],
            },
          },
        },
      },
    },
    responses: {
      200: ok(myProfile, '수정된 프로필'),
      ...errors(invalid(), AUTHENTICATED),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/applications',
    operationId: 'getMyApplications',
    tags,
    summary: '내 지원 목록(프리랜서)',
    description: '최신순. 응답 전에 프로젝트 수명주기 스윕을 돌리고, 마감된 프로젝트의 대기 중인 내 지원을 거절로 바꾼다(행을 쓴다).',
    security: bearer,
    responses: {
      200: ok(z.array(myApplication)),
      ...errors(AUTHENTICATED, { 403: ['`Only freelancers can view their applications` — FREELANCER가 아님'] }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/bookmarks',
    operationId: 'getMyBookmarks',
    tags,
    summary: '북마크한 프로젝트(프리랜서)',
    description: '북마크한 시각의 최신순. 삭제된 프로젝트는 빠진다.',
    security: bearer,
    responses: {
      200: ok(z.array(bookmarkedProject)),
      ...errors(AUTHENTICATED, { 403: ['`Only freelancers can view their bookmarks` — FREELANCER가 아님'] }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/projects',
    operationId: 'getMyProjects',
    tags,
    summary: '내가 등록한 프로젝트(의뢰인)',
    description: '최신순. 응답 전에 프로젝트 수명주기 스윕을 돌린다(행을 쓴다).',
    security: bearer,
    responses: {
      200: ok(z.array(myProject)),
      ...errors(AUTHENTICATED, { 403: ['`Only clients can view their projects` — CLIENT가 아님'] }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/payout-account',
    operationId: 'getMyPayoutAccount',
    tags: payoutTags,
    summary: '내 지급 계좌',
    description: '계좌번호는 마지막 네 자리만 보인다. 등록하지 않았으면 `payoutAccount: null`.',
    security: bearer,
    responses: {
      200: ok(payoutAccountBody),
      ...errors(ACTIVE_USER, role('FREELANCER')),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/users/me/payout-account',
    operationId: 'putMyPayoutAccount',
    tags: payoutTags,
    summary: '지급 계좌 등록·변경',
    description: '예금주는 회원 이름과 같아야 한다(공백·대소문자 무시). 계좌가 없어 보류(`ON_HOLD`)된 정산을 다음 수요일 지급으로 다시 예약한다.',
    security: bearer,
    request: { body: jsonBody(payoutAccountRequest) },
    responses: {
      200: ok(payoutAccountPutBody),
      ...errors(
        invalid('`Account holder must match your name` — 예금주가 회원 이름과 다름'),
        ACTIVE_USER,
        role('FREELANCER'),
        PAYOUT_LOCKED,
      ),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/users/me/payout-account',
    operationId: 'deleteMyPayoutAccount',
    tags: payoutTags,
    summary: '지급 계좌 삭제',
    description: '멱등이다. 계좌가 없어도 200.',
    security: bearer,
    responses: {
      200: ok(payoutAccountDeletedBody),
      ...errors(ACTIVE_USER, role('FREELANCER'), PAYOUT_LOCKED),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/{id}/reviews',
    operationId: 'getUserReviewsByUser',
    tags,
    summary: '사용자가 받은 리뷰',
    description: '`GET /api/reviews/users/{id}`와 같다. 최신순이고, 없는 사용자도 빈 배열이다.',
    security: publicRoute,
    request: { params: pathParams({ id: '사용자 ID' }) },
    responses: {
      200: ok(z.array(receivedReview)),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/users/{id}',
    operationId: 'getUserById',
    tags,
    summary: '공개 프로필',
    description: '받은 리뷰와 평균 평점, 포트폴리오와 경력을 함께 준다. 이메일은 없다.',
    security: publicRoute,
    request: { params: pathParams({ id: '사용자 ID' }) },
    responses: {
      200: ok(publicProfile),
      ...errors({ 404: ['`User not found` — 없거나 탈퇴한 사용자'] }),
    },
  });
}
