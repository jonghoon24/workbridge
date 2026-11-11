import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { uploadRequestBody } from '../../schemas/attachments';
import { rejectBody, submissionBody } from '../../schemas/milestones';
import {
  ACTIVE_USER,
  ATTACHMENT_DOWNLOAD,
  bearer,
  cause,
  created,
  errors,
  invalid,
  jsonBody,
  ok,
  pathParams,
  role,
  UPLOAD_CLAIM,
  UPLOAD_POLICY,
} from '../common';
import type { ErrorSpec } from '../common';
import {
  attachmentDownload,
  milestoneApproved,
  milestoneDetail,
  milestoneRejected,
  submissionCreated,
  uploadsIssued,
} from '../responses/contracts';

const tags = ['Milestones'];

const milestoneId = pathParams({ id: '마일스톤 ID' });
const MILESTONE_NOT_FOUND = cause('MILESTONE_NOT_FOUND', '없는 마일스톤, 또는 프로젝트가 삭제됨');
const NOT_AWAITING_REVIEW = cause('MILESTONE_NOT_AWAITING_REVIEW', '제출(`SUBMITTED`) 상태가 아님');

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
      ...errors(ACTIVE_USER, cause('FORBIDDEN_RESOURCE', '계약 당사자가 아님'), MILESTONE_NOT_FOUND),
    },
  });

  const SUBMITTABLE: ErrorSpec = [
    cause('FORBIDDEN_RESOURCE', '계약의 프리랜서가 아님'),
    MILESTONE_NOT_FOUND,
    cause('MILESTONE_NOT_AWAITING_SUBMISSION', '제출할 수 있는 상태가 아님'),
  ];

  registry.registerPath({
    method: 'post',
    path: '/api/milestones/{id}/uploads',
    operationId: 'createSubmissionUploads',
    tags,
    summary: '결과물 첨부 업로드 URL 받기(프리랜서)',
    description:
      '제출에 붙일 파일(최대 5개, 개당 10MB, 이미지·PDF·ZIP·텍스트·오피스 문서·HWP)마다 비공개 저장소의 서명 업로드 URL을 준다. '
      + '브라우저가 각 URL에 파일을 `PUT`한 뒤, 돌려받은 `id`를 제출의 `uploadIds`로 보낸다. 파일 정책은 마일스톤을 찾기 전에 검사한다. '
      + '업로드는 2시간 뒤 만료되고, 붙지 않은 파일은 정리 작업이 지운다.',
    security: bearer,
    request: { params: milestoneId, body: jsonBody(uploadRequestBody) },
    responses: {
      201: created(uploadsIssued),
      ...errors(invalid(), UPLOAD_POLICY, ACTIVE_USER, role('FREELANCER'), SUBMITTABLE),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/milestones/{id}/submissions',
    operationId: 'createSubmission',
    tags,
    summary: '결과물 제출(프리랜서)',
    description:
      '결제 완료(`FUNDED`)나 수정 요청(`REVISION_REQUESTED`) 상태에서만. 메시지, 링크, 첨부(`uploadIds`, 최대 5개)를 보낸다. '
      + '첨부는 먼저 `POST /api/milestones/{id}/uploads`로 올린다. 제출하면 자동 승인 기한이 잡히고 의뢰인에게 알린다.',
    security: bearer,
    request: { params: milestoneId, body: jsonBody(submissionBody) },
    responses: {
      201: created(submissionCreated),
      ...errors(invalid(), ACTIVE_USER, role('FREELANCER'), SUBMITTABLE, UPLOAD_CLAIM),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/milestones/{id}/attachments/{attachmentId}/download',
    operationId: 'getSubmissionAttachment',
    tags,
    summary: '결과물 첨부 내려받기 URL',
    description: '계약 당사자에게 원래 파일 이름으로 내려받는 60초짜리 서명 URL을 준다. 모든 제출 회차의 첨부가 대상이다.',
    security: bearer,
    request: { params: pathParams({ id: '마일스톤 ID', attachmentId: '첨부 ID' }) },
    responses: {
      200: ok(attachmentDownload),
      ...errors(
        ACTIVE_USER,
        cause('FORBIDDEN_RESOURCE', '계약 당사자가 아님'),
        MILESTONE_NOT_FOUND,
        cause('ATTACHMENT_NOT_FOUND', '이 마일스톤의 첨부가 아님'),
        ATTACHMENT_DOWNLOAD,
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
        cause('FORBIDDEN_RESOURCE', '계약의 의뢰인이 아님'),
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
        cause('FORBIDDEN_RESOURCE', '계약의 의뢰인이 아님'),
        MILESTONE_NOT_FOUND,
        NOT_AWAITING_REVIEW,
      ),
    },
  });
}
