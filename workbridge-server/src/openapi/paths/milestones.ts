import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { z } from '../../lib/zod';
import { rejectBody, submissionBody } from '../../schemas/milestones';
import {
  ACTIVE_USER,
  ATTACHMENT_UPLOAD,
  bearer,
  binaryFile,
  created,
  errors,
  invalid,
  jsonBody,
  notFound,
  ok,
  pathParams,
  role,
} from '../common';
import { milestoneApproved, milestoneDetail, milestoneRejected, submissionCreated } from '../responses/contracts';

const tags = ['Milestones'];

const milestoneId = pathParams({ id: '마일스톤 ID' });
const MILESTONE_NOT_FOUND = notFound('Milestone not found', '없는 마일스톤, 또는 프로젝트가 삭제됨');
const NOT_AWAITING_REVIEW = { 409: ['`Milestone is not awaiting review` — 제출(`SUBMITTED`) 상태가 아님'] };

export function registerMilestonePaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/milestones/{id}',
    operationId: 'getMilestone',
    tags,
    summary: '마일스톤 상세',
    description: '모든 제출 회차(최신 회차부터)와 계약 요약을 함께 준다.',
    security: bearer,
    request: { params: milestoneId },
    responses: {
      200: ok(milestoneDetail),
      ...errors(ACTIVE_USER, { 403: ['`Not authorized` — 계약 당사자가 아님'] }, MILESTONE_NOT_FOUND),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/milestones/{id}/submissions',
    operationId: 'createSubmission',
    tags,
    summary: '결과물 제출(프리랜서)',
    description:
      '결제 완료(`FUNDED`)나 수정 요청(`REVISION_REQUESTED`) 상태에서만. `multipart/form-data`로 메시지, 링크, '
      + '`files`(최대 5개, 개당 10MB)를 보낸다. 제출하면 자동 승인 기한이 잡히고 의뢰인에게 알린다.',
    security: bearer,
    request: {
      params: milestoneId,
      body: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: z.intersection(submissionBody, z.object({ files: z.array(binaryFile).max(5).optional() })),
          },
          'application/json': { schema: submissionBody },
        },
      },
    },
    responses: {
      201: created(submissionCreated),
      ...errors(
        invalid(),
        ATTACHMENT_UPLOAD,
        ACTIVE_USER,
        role('FREELANCER'),
        { 403: ['`Not authorized` — 계약의 프리랜서가 아님'] },
        MILESTONE_NOT_FOUND,
        { 409: ['`Milestone is not awaiting a submission` — 제출할 수 있는 상태가 아님'] },
      ),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/milestones/{id}/approve',
    operationId: 'approveMilestone',
    tags,
    summary: '결과물 승인(의뢰인)',
    description: '정산 항목을 만든다. 마지막 마일스톤이면 계약과 프로젝트를 완료로 바꾼다.',
    security: bearer,
    request: { params: milestoneId },
    responses: {
      200: ok(milestoneApproved),
      ...errors(
        ACTIVE_USER,
        role('CLIENT'),
        { 403: ['`Not authorized` — 계약의 의뢰인이 아님'] },
        MILESTONE_NOT_FOUND,
        NOT_AWAITING_REVIEW,
      ),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/milestones/{id}/reject',
    operationId: 'rejectMilestone',
    tags,
    summary: '수정 요청(의뢰인)',
    security: bearer,
    request: { params: milestoneId, body: jsonBody(rejectBody) },
    responses: {
      200: ok(milestoneRejected),
      ...errors(
        invalid(),
        ACTIVE_USER,
        role('CLIENT'),
        { 403: ['`Not authorized` — 계약의 의뢰인이 아님'] },
        MILESTONE_NOT_FOUND,
        NOT_AWAITING_REVIEW,
      ),
    },
  });
}
