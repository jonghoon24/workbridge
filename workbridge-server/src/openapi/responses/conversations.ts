import { z } from '../../lib/zod';
import {
  contractStatusEnum,
  count,
  dateTime,
  id,
  messageKindEnum,
  paginationMeta,
  roleEnum,
  userCard,
} from './common';
import { attachment } from './contracts';

/** `serializeMessage`. A deleted message is a tombstone: `body: ''`, `attachments: []`. */
export const message = z
  .object({
    id,
    conversationId: id,
    kind: messageKindEnum,
    systemEvent: z
      .enum([
        'CONTRACT_CREATED',
        'MILESTONE_PLAN_UPDATED',
        'CONTRACT_ACTIVATED',
        'MILESTONE_FUNDED',
        'MILESTONE_SUBMITTED',
        'MILESTONE_REVISION_REQUESTED',
        'MILESTONE_APPROVED',
        'MILESTONE_AUTO_APPROVED',
        'CONTRACT_COMPLETED',
      ])
      .nullable()
      .openapi({ description: '`SYSTEM` 메시지의 계약 이벤트. `TEXT`면 `null`' }),
    sender: userCard.nullable().openapi({ description: '`SYSTEM` 메시지면 `null`' }),
    body: z.string(),
    deleted: z.boolean(),
    attachments: z.array(attachment),
    createdAt: dateTime,
    readByCounterpart: z
      .boolean()
      .nullable()
      .openapi({ description: '내가 보낸 `TEXT` 메시지만 값이 있고, 나머지는 `null`' }),
  })
  .openapi('Message');

/** `serializeConversation`. */
const conversationFields = {
  id,
  contractId: id,
  myRole: roleEnum,
  contract: z.object({ id, status: contractStatusEnum, completedAt: dateTime.nullable() }),
  project: z.object({ id, title: z.string() }),
  counterpart: userCard,
  lastMessageAt: dateTime.nullable(),
  createdAt: dateTime,
  unreadCount: count,
  myLastReadAt: dateTime.nullable(),
  counterpartLastReadAt: dateTime.nullable(),
  canSend: z.boolean(),
  closedReason: z.enum(['CONTRACT_CLOSED', 'COUNTERPART_INACTIVE']).nullable(),
  closesAt: dateTime.nullable().openapi({ description: '완료된 계약에서 메시지를 더 보낼 수 없게 되는 시각(완료 + 30일)' }),
};

export const conversation = z.object(conversationFields).openapi('Conversation');

export const conversationList = z.object({
  conversations: z.array(
    z.object({ ...conversationFields, lastMessage: message.nullable() }).openapi('ConversationListItem'),
  ),
  meta: paginationMeta,
});

export const conversationBody = z.object({ conversation });
export const messagePage = z.object({
  messages: z.array(message).openapi({ description: '항상 오래된 것부터' }),
  hasMore: z.boolean(),
});
export const messageResult = z.object({ message });
export const readResult = z.object({ lastReadAt: dateTime.nullable(), unreadCount: count });
