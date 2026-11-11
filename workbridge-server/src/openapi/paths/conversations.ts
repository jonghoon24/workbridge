import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { conversationListQuery, messageBody, messageListQuery } from '../../schemas/conversations';
import { uploadRequestBody } from '../../schemas/attachments';
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
  UPLOAD_CLAIM,
  UPLOAD_POLICY,
} from '../common';
import { attachmentDownload, uploadsIssued } from '../responses/contracts';
import { unreadCountBody } from '../responses/common';
import { conversationBody, conversationList, messagePage, messageResult, readResult } from '../responses/conversations';

const tags = ['Conversations'];

const conversationId = pathParams({ id: '대화방 ID' });
/** Every `/:id` route looks the conversation up first: missing → 404, not a participant → 403. */
const LOOKUP = [
  cause('FORBIDDEN_RESOURCE', '대화방 참여자가 아님'),
  cause('CONVERSATION_NOT_FOUND', '없는 대화방, 또는 프로젝트가 삭제됨'),
];

export function registerConversationPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/conversations',
    operationId: 'getMyConversations',
    tags,
    summary: '내 대화방 목록',
    description:
      '마지막 메시지가 최근인 순(메시지가 없는 대화방은 뒤). 삭제된 프로젝트의 대화방은 빠진다. '
      + '`q`가 있으면 프로젝트 제목이나 상대방 이름에 그 글자가 들어 있는 대화방만 같은 순서로 담고, '
      + '`meta`도 걸러진 결과를 센다. 내 이름은 검색하지 않는다. `%`와 `_`는 와일드카드가 아니라 글자 그대로다.',
    security: bearer,
    request: { query: conversationListQuery },
    responses: {
      200: ok(conversationList),
      ...errors(invalid('`q` `TOO_LARGE` — 검색어가 앞뒤 공백을 빼고 100자 넘음'), ACTIVE_USER),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/conversations/unread-count',
    operationId: 'getUnreadCount',
    tags,
    summary: '안 읽은 메시지 수(전체)',
    description: '상대방이 보낸, 지워지지 않은 `TEXT` 메시지만 센다.',
    security: bearer,
    responses: { 200: ok(unreadCountBody), ...errors(ACTIVE_USER) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/conversations/{id}',
    operationId: 'getConversationById',
    tags,
    summary: '대화방',
    security: bearer,
    request: { params: conversationId },
    responses: { 200: ok(conversationBody), ...errors(ACTIVE_USER, LOOKUP) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/conversations/{id}/messages',
    operationId: 'getMessages',
    tags,
    summary: '메시지 목록',
    description:
      '커서 페이지네이션. 커서가 없으면 최신 `limit`개, `before`는 그 메시지보다 오래된 것, `after`는 더 새로운 것. '
      + '어느 경우든 오래된 것부터 담는다. 읽음 처리는 하지 않는다.',
    security: bearer,
    request: { params: conversationId, query: messageListQuery },
    responses: {
      200: ok(messagePage),
      ...errors(
        invalid(
          '`before` `CONFLICT` — 커서를 둘 다 보냄',
          '`before`·`after` `INVALID` — 커서 메시지가 이 대화방에 없음',
        ),
        ACTIVE_USER,
        LOOKUP,
      ),
    },
  });

  const CLOSED = [
    cause('CONVERSATION_CLOSED', '계약이 완료되거나 철회된 뒤 30일이 지남'),
    cause('COUNTERPART_INACTIVE', '상대방이 탈퇴함'),
  ];

  registry.registerPath({
    method: 'post',
    path: '/api/conversations/{id}/uploads',
    operationId: 'postMessageUploads',
    tags,
    summary: '첨부 업로드 URL 받기',
    description:
      '메시지에 붙일 파일(최대 5개, 개당 10MB, 이미지·PDF·ZIP·텍스트·오피스 문서·HWP)마다 비공개 저장소의 서명 업로드 URL을 준다. '
      + '브라우저가 각 URL에 파일을 `PUT`한 뒤, 돌려받은 `id`를 메시지의 `uploadIds`로 보낸다. 파일 정책은 대화방을 찾기 전에 검사한다. '
      + '업로드는 2시간 뒤 만료되고, 붙지 않은 파일은 정리 작업이 지운다.',
    security: bearer,
    request: { params: conversationId, body: jsonBody(uploadRequestBody) },
    responses: {
      201: created(uploadsIssued),
      ...errors(invalid(), UPLOAD_POLICY, ACTIVE_USER, LOOKUP, CLOSED),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/conversations/{id}/messages',
    operationId: 'postMessage',
    tags,
    summary: '메시지 보내기',
    description:
      '본문(최대 5,000자)이나 첨부(`uploadIds`, 최대 5개) 중 하나는 있어야 한다. 첨부는 먼저 `POST /api/conversations/{id}/uploads`로 '
      + '올린다. 서버가 업로드마다 내가 이 대화방에 받은 것인지, 파일이 실제로 올라왔는지, 저장된 크기와 형식이 정책에 맞는지 확인한다. '
      + '상대방이 10분 안에 읽지 않으면 요약 메일을 예약한다.',
    security: bearer,
    request: { params: conversationId, body: jsonBody(messageBody) },
    responses: {
      201: created(messageResult),
      ...errors(
        invalid('`body` `REQUIRED` — 본문도 첨부도 없음'),
        ACTIVE_USER,
        LOOKUP,
        UPLOAD_CLAIM,
        cause('CONVERSATION_CLOSED', '계약이 완료되거나 철회된 뒤 30일이 지남'),
        cause('COUNTERPART_INACTIVE', '상대방이 탈퇴함'),
      ),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/conversations/{id}/read',
    operationId: 'readConversation',
    tags,
    summary: '대화방 읽음',
    description: '상대방의 최신 메시지까지 읽음으로 표시한다. 읽음 표시는 뒤로 가지 않는다.',
    security: bearer,
    request: { params: conversationId },
    responses: { 200: ok(readResult), ...errors(ACTIVE_USER, LOOKUP) },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/conversations/{id}/messages/{messageId}',
    operationId: 'removeMessage',
    tags,
    summary: '메시지 삭제',
    description:
      '보낸 사람이 보낸 지 5분 안에만. 본문과 첨부를 지운 흔적(`deleted: true`)이 남고, 첨부 파일은 작업이 저장소에서 지운다. '
      + '이미 지운 메시지는 다시 200.',
    security: bearer,
    request: { params: pathParams({ id: '대화방 ID', messageId: '메시지 ID' }) },
    responses: {
      200: ok(messageResult, '지운 메시지(흔적)'),
      ...errors(
        ACTIVE_USER,
        LOOKUP,
        cause('FORBIDDEN_RESOURCE', '내가 보낸 `TEXT` 메시지가 아님'),
        cause('MESSAGE_NOT_FOUND', '이 대화방의 메시지가 아님'),
        cause('MESSAGE_DELETE_WINDOW_EXPIRED', '5분이 지남'),
      ),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/conversations/{id}/attachments/{attachmentId}/download',
    operationId: 'getMessageAttachment',
    tags,
    summary: '메시지 첨부 내려받기 URL',
    description: '참여자에게 원래 파일 이름으로 내려받는 60초짜리 서명 URL을 준다. 지운 메시지의 첨부는 없는 것과 같다.',
    security: bearer,
    request: { params: pathParams({ id: '대화방 ID', attachmentId: '첨부 ID' }) },
    responses: {
      200: ok(attachmentDownload),
      ...errors(
        ACTIVE_USER,
        LOOKUP,
        cause('ATTACHMENT_NOT_FOUND', '이 대화방의 첨부가 아니거나 메시지가 삭제됨'),
        ATTACHMENT_DOWNLOAD,
      ),
    },
  });
}
