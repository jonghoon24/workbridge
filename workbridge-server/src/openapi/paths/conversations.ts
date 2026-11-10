import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { z } from '../../lib/zod';
import { conversationListQuery, messageBody, messageListQuery } from '../../schemas/conversations';
import {
  ACTIVE_USER,
  ATTACHMENT_UPLOAD,
  bearer,
  binaryFile,
  created,
  errors,
  invalid,
  ok,
  pathParams,
} from '../common';
import { unreadCountBody } from '../responses/common';
import { conversationBody, conversationList, messagePage, messageResult, readResult } from '../responses/conversations';

const tags = ['Conversations'];

const conversationId = pathParams({ id: '대화방 ID' });
/** Every `/:id` route looks the conversation up first: missing → 404, not a participant → 403. */
const LOOKUP = {
  403: ['`Not authorized` — 대화방 참여자가 아님'],
  404: ['`Conversation not found` — 없는 대화방, 또는 프로젝트가 삭제됨'],
};

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
      ...errors(invalid('`q: must be at most 100 characters` — 검색어가 앞뒤 공백을 빼고 100자 넘음'), ACTIVE_USER),
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
          '`before: Use either before or after, not both` — 커서를 둘 다 보냄',
          '`before: Message not found in this conversation` — 커서 메시지가 이 대화방에 없음(`after`도 같음)',
        ),
        ACTIVE_USER,
        LOOKUP,
      ),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/conversations/{id}/messages',
    operationId: 'postMessage',
    tags,
    summary: '메시지 보내기',
    description:
      '본문(최대 5,000자)이나 첨부(`files`, 최대 5개, 개당 10MB) 중 하나는 있어야 한다. 첨부는 `multipart/form-data`로 보낸다. '
      + '상대방이 10분 안에 읽지 않으면 요약 메일을 예약한다.',
    security: bearer,
    request: {
      params: conversationId,
      body: {
        required: true,
        content: {
          'application/json': { schema: messageBody },
          'multipart/form-data': {
            schema: z.intersection(messageBody, z.object({ files: z.array(binaryFile).max(5).optional() })),
          },
        },
      },
    },
    responses: {
      201: created(messageResult),
      ...errors(
        invalid('`body: Message or attachment is required` — 본문도 첨부도 없음'),
        ATTACHMENT_UPLOAD,
        ACTIVE_USER,
        LOOKUP,
        {
          409: [
            '`This conversation is closed` — 계약 완료 후 30일이 지남',
            '`The other participant is no longer active` — 상대방이 탈퇴함',
          ],
        },
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
    description: '보낸 사람이 보낸 지 5분 안에만. 본문과 첨부를 지운 흔적(`deleted: true`)이 남는다. 이미 지운 메시지는 다시 200.',
    security: bearer,
    request: { params: pathParams({ id: '대화방 ID', messageId: '메시지 ID' }) },
    responses: {
      200: ok(messageResult, '지운 메시지(흔적)'),
      ...errors(ACTIVE_USER, {
        403: [...LOOKUP[403], '`Not authorized` — 내가 보낸 `TEXT` 메시지가 아님'],
        404: [...LOOKUP[404], '`Message not found` — 이 대화방의 메시지가 아님'],
        409: ['`Messages can only be deleted within 5 minutes` — 5분이 지남'],
      }),
    },
  });
}
