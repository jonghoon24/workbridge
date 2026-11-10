import { Prisma } from '@prisma/client';
import type { Contract, MessageKind } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { DAY_MS, MINUTE_MS } from '../lib/time';
import { PermanentJobError } from '../jobs/errors';
import { enqueueJob } from '../jobs/queue';
import { notify } from '../lib/notifications/notify';
import { renderTemplate } from '../lib/notifications/templates';
import { storeUploadedFile } from '../middlewares/attachmentUpload';
import type { StoredFile } from '../middlewares/attachmentUpload';
import type { PrismaTransactionClient } from '../types/index';
import type { MessageListQuery } from '../schemas/conversations';

/**
 * Conversations and messages, plus the unread-message digest's enqueue rule and run logic
 * (docs/domain/messaging-notifications.md).
 *
 * Every message — a person's text or a contract event's system message — goes through
 * {@link postMessage}, which takes the conversation's row lock and derives `createdAt` from the
 * locked `lastMessageAt`, so `createdAt` strictly increases in commit order within a conversation
 * The cursors and the read watermark depend on that. Lock order across the codebase is
 * `Contract` → `Milestone` → the event's other writes → `Conversation`: a system message is always
 * the last write of its event transaction, and nothing here locks anything after a conversation.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Posting stays open this long after completion — exact hours, not KST days. */
export const POST_COMPLETION_WINDOW_MS = 30 * DAY_MS;
/** A sender may delete a message strictly less than this long after `createdAt`. */
export const DELETE_WINDOW_MS = 5 * MINUTE_MS;
/** The unread digest runs this long after the message that schedules it. */
export const UNREAD_DIGEST_DELAY_MS = 10 * MINUTE_MS;
/** At most one digest email per conversation and recipient per this period. */
export const UNREAD_DIGEST_THROTTLE_MS = 60 * MINUTE_MS;

const CONVERSATION_NOT_FOUND = 'Conversation not found';
const NOT_AUTHORIZED = 'Not authorized';

// ---------------------------------------------------------------------------
// System messages
// ---------------------------------------------------------------------------

/** `Message.systemEvent` values — a bare String in the schema, like `Notification.type`. */
export type MessageSystemEvent =
  | 'CONTRACT_CREATED'
  | 'MILESTONE_PLAN_UPDATED'
  | 'CONTRACT_ACTIVATED'
  | 'MILESTONE_FUNDED'
  | 'MILESTONE_SUBMITTED'
  | 'MILESTONE_REVISION_REQUESTED'
  | 'MILESTONE_APPROVED'
  | 'MILESTONE_AUTO_APPROVED'
  | 'CONTRACT_COMPLETED';

export interface SystemMessageVars {
  /** MILESTONE_PLAN_UPDATED: whether a signature was cleared by this replacement. */
  signaturesReset?: boolean;
  milestoneTitle?: string;
  round?: number;
  reason?: string;
}

/**
 * Fixed Korean bodies. The wording is not a contract (tests assert `systemEvent`). No
 * particle follows a quoted title — 이/가 would depend on its last syllable.
 */
const ms = (v: SystemMessageVars) => `마일스톤 '${v.milestoneTitle ?? ''}'`;
const SYSTEM_BODIES: Record<MessageSystemEvent, (v: SystemMessageVars) => string> = {
  CONTRACT_CREATED: () => '계약이 생성되었습니다. 마일스톤 계획을 확인해 주세요.',
  MILESTONE_PLAN_UPDATED: (v) => (v.signaturesReset
    ? '마일스톤 계획이 변경되어 서명이 초기화되었습니다. 다시 확인하고 서명해 주세요.'
    : '마일스톤 계획이 변경되었습니다. 확인한 뒤 서명해 주세요.'),
  CONTRACT_ACTIVATED: () => '양측이 서명해 계약이 시작되었습니다. 첫 마일스톤 결제부터 진행해 주세요.',
  MILESTONE_FUNDED: (v) => `${ms(v)} 결제가 완료되었습니다. 작업을 시작해 주세요.`,
  MILESTONE_SUBMITTED: (v) => `${ms(v)} 결과물이 제출되었습니다${v.round ? ` (${v.round}차)` : ''}. 검수 후 승인하거나 수정을 요청해 주세요.`,
  MILESTONE_REVISION_REQUESTED: (v) => `${ms(v)} 수정이 요청되었습니다.${v.reason ? `\n요청 사항: ${v.reason}` : ''}`,
  MILESTONE_APPROVED: (v) => `${ms(v)} 결과물이 승인되었습니다.`,
  MILESTONE_AUTO_APPROVED: (v) => `${ms(v)} 결과물이 검수 기한이 지나 자동 승인되었습니다.`,
  CONTRACT_COMPLETED: () => '모든 마일스톤이 승인되어 계약이 완료되었습니다. 서로 리뷰를 남겨 주세요.',
};

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

const userCard = { select: { id: true, name: true, profileImage: true } } as const;

/** The attachment keys, in upload order. */
const messageInclude = {
  sender: userCard,
  attachments: {
    select: { id: true, url: true, fileName: true, mimeType: true, size: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.MessageInclude;

type MessageRow = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

/** `(createdAt, id)` — the order of a message page and of "newest" everywhere in this file. */
const NEWEST_FIRST = [{ createdAt: 'desc' }, { id: 'desc' }] satisfies Prisma.MessageOrderByWithRelationInput[];
const OLDEST_FIRST = [{ createdAt: 'asc' }, { id: 'asc' }] satisfies Prisma.MessageOrderByWithRelationInput[];

/**
 * `readByCounterpart` only means something for the viewer's own text messages; a deleted
 * message is a tombstone (`body: ''`, `attachments: []`).
 */
export function serializeMessage(row: MessageRow, viewerId: string, counterpartLastReadAt: Date | null) {
  const deleted = row.deletedAt !== null;
  const own = row.kind === 'TEXT' && row.senderId === viewerId;
  return {
    id: row.id,
    conversationId: row.conversationId,
    kind: row.kind,
    systemEvent: row.systemEvent,
    sender: row.sender,
    body: deleted ? '' : row.body,
    deleted,
    attachments: deleted ? [] : row.attachments,
    createdAt: row.createdAt,
    readByCounterpart: own ? counterpartLastReadAt !== null && counterpartLastReadAt >= row.createdAt : null,
  };
}

export type SerializedMessage = ReturnType<typeof serializeMessage>;

const partyCard = { select: { id: true, name: true, profileImage: true, deletedAt: true } } as const;

const conversationInclude = {
  contract: {
    select: {
      id: true,
      status: true,
      completedAt: true,
      clientId: true,
      freelancerId: true,
      project: { select: { id: true, title: true } },
      client: partyCard,
      freelancer: partyCard,
    },
  },
  participants: { select: { userId: true, lastReadAt: true } },
} satisfies Prisma.ConversationInclude;

type ConversationRow = Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>;

export type ClosedReason = 'CONTRACT_CLOSED' | 'COUNTERPART_INACTIVE';

/**
 * Who may post, decided top to bottom: closed after `closesAt`, then an inactive counterpart, else
 * open. A COMPLETED contract without `completedAt` (bad data) has no `closesAt`.
 */
export function postingState(
  contract: Pick<Contract, 'status' | 'completedAt'>,
  counterpart: { deletedAt: Date | null },
  now: Date,
): { canSend: boolean; closedReason: ClosedReason | null; closesAt: Date | null } {
  const closesAt = contract.status === 'COMPLETED' && contract.completedAt
    ? new Date(contract.completedAt.getTime() + POST_COMPLETION_WINDOW_MS)
    : null;
  if (closesAt && now >= closesAt) return { canSend: false, closedReason: 'CONTRACT_CLOSED', closesAt };
  if (counterpart.deletedAt) return { canSend: false, closedReason: 'COUNTERPART_INACTIVE', closesAt };
  return { canSend: true, closedReason: null, closesAt };
}

/** The caller's view of a conversation row: roles, both watermarks, the other party. */
function sides(row: ConversationRow, userId: string) {
  const myRole = row.contract.clientId === userId ? 'CLIENT' as const : 'FREELANCER' as const;
  const counterpartUser = myRole === 'CLIENT' ? row.contract.freelancer : row.contract.client;
  const me = row.participants.find((p) => p.userId === userId);
  const counterpart = row.participants.find((p) => p.userId !== userId);
  return {
    myRole,
    counterpartUser,
    myLastReadAt: me?.lastReadAt ?? null,
    counterpartLastReadAt: counterpart?.lastReadAt ?? null,
  };
}

/** The conversation object as every conversation route returns it. */
function serializeConversation(row: ConversationRow, userId: string, unreadCount: number, now: Date) {
  const { myRole, counterpartUser, myLastReadAt, counterpartLastReadAt } = sides(row, userId);
  const { id: counterpartId, name, profileImage } = counterpartUser;
  return {
    id: row.id,
    contractId: row.contractId,
    myRole,
    contract: { id: row.contract.id, status: row.contract.status, completedAt: row.contract.completedAt },
    project: row.contract.project,
    counterpart: { id: counterpartId, name, profileImage },
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    unreadCount,
    myLastReadAt,
    counterpartLastReadAt,
    ...postingState(row.contract, counterpartUser, now),
  };
}

// ---------------------------------------------------------------------------
// Unread counts
// ---------------------------------------------------------------------------

/**
 * Unread count for `userId` — the counterpart's undeleted text messages after the caller's
 * `lastReadAt` — per conversation matching `condition` (a predicate on `c`, the conversation).
 * Conversations with nothing unread are absent from the result.
 */
async function unreadRows(client: PrismaTransactionClient, userId: string, condition: Prisma.Sql) {
  return client.$queryRaw<{ conversationId: string; contractId: string; unread: number }[]>`
    SELECT c."id" AS "conversationId", c."contractId", COUNT(m."id")::int AS "unread"
      FROM "Conversation" c
      JOIN "ConversationParticipant" p ON p."conversationId" = c."id" AND p."userId" = ${userId}
      JOIN "Message" m ON m."conversationId" = c."id"
     WHERE ${condition}
       AND m."kind" = 'TEXT'
       AND m."senderId" <> p."userId"
       AND m."deletedAt" IS NULL
       AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt")
     GROUP BY c."id", c."contractId"`;
}

/** Unread count per conversation id; 0 for any id not in the map. */
export async function unreadByConversation(
  userId: string,
  conversationIds: readonly string[],
  client: PrismaTransactionClient = prisma,
): Promise<Map<string, number>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await unreadRows(client, userId, Prisma.sql`c."id" IN (${Prisma.join(conversationIds)})`);
  return new Map(rows.map((r) => [r.conversationId, r.unread]));
}

/** Unread count per contract id, for the contract list (callers already excluded deleted projects). */
export async function unreadByContract(userId: string, contractIds: readonly string[]): Promise<Map<string, number>> {
  if (contractIds.length === 0) return new Map();
  const rows = await unreadRows(prisma, userId, Prisma.sql`c."contractId" IN (${Prisma.join(contractIds)})`);
  return new Map(rows.map((r) => [r.contractId, r.unread]));
}

/** The sum over the caller's conversations, those of soft-deleted projects excluded. */
export async function unreadTotal(userId: string): Promise<{ unreadCount: number }> {
  const rows = await unreadRows(prisma, userId, Prisma.sql`EXISTS (
    SELECT 1 FROM "Contract" ct JOIN "Project" pr ON pr."id" = ct."projectId"
     WHERE ct."id" = c."contractId" AND pr."deletedAt" IS NULL)`);
  return { unreadCount: rows.reduce((sum, r) => sum + r.unread, 0) };
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

interface PostInput {
  kind: MessageKind;
  senderId: string | null;
  systemEvent: MessageSystemEvent | null;
  body: string;
  attachments?: readonly StoredFile[];
}

/**
 * Lock the conversation, take `createdAt = max(clock, lastMessageAt + 1 ms)` with the clock
 * read only once the lock is held, insert the message, move `lastMessageAt`. Always the server
 * clock — never a `now` handed in (an exception to the take-`now`-as-an-argument convention).
 */
async function postMessage(tx: PrismaTransactionClient, conversationId: string, input: PostInput): Promise<MessageRow> {
  const [locked] = await tx.$queryRaw<{ lastMessageAt: Date | null }[]>`
    SELECT "lastMessageAt" FROM "Conversation" WHERE "id" = ${conversationId} FOR UPDATE`;
  if (!locked) throw new Error(`postMessage: conversation ${conversationId} does not exist`);

  const floor = locked.lastMessageAt ? locked.lastMessageAt.getTime() + 1 : 0;
  const createdAt = new Date(Math.max(Date.now(), floor));

  const message = await tx.message.create({
    data: {
      conversationId,
      kind: input.kind,
      senderId: input.senderId,
      systemEvent: input.systemEvent,
      body: input.body,
      createdAt,
      attachments: {
        create: (input.attachments ?? []).map((file) => ({
          url: file.url,
          fileName: file.fileName,
          mimeType: file.mimeType,
          size: file.size,
        })),
      },
    },
    include: messageInclude,
  });
  await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: createdAt } });
  return message;
}

/**
 * Records a contract event in its conversation. Call it as the **last write** of the
 * event's transaction. A contract without a conversation (a data-repair case, or a test fixture
 * made with `makeContract` alone) posts nothing and logs a warning — it never throws.
 */
export async function postSystemMessage(
  tx: PrismaTransactionClient,
  contractId: string,
  event: MessageSystemEvent,
  vars: SystemMessageVars = {},
): Promise<MessageRow | null> {
  const conversation = await tx.conversation.findUnique({ where: { contractId }, select: { id: true } });
  if (!conversation) {
    logger.warn('system message skipped: contract has no conversation', { contractId, systemEvent: event });
    return null;
  }
  return postMessage(tx, conversation.id, {
    kind: 'SYSTEM',
    senderId: null,
    systemEvent: event,
    body: SYSTEM_BODIES[event](vars),
  });
}

/** Part of accepting an application: the conversation, both participants, then `CONTRACT_CREATED`. */
export async function openContractConversation(
  tx: PrismaTransactionClient,
  contract: Pick<Contract, 'id' | 'clientId' | 'freelancerId'>,
): Promise<void> {
  await tx.conversation.create({
    data: {
      contractId: contract.id,
      participants: { create: [{ userId: contract.clientId }, { userId: contract.freelancerId }] },
    },
  });
  await postSystemMessage(tx, contract.id, 'CONTRACT_CREATED');
}

// ---------------------------------------------------------------------------
// Unread digest scheduling
// ---------------------------------------------------------------------------

/** The digest's enqueue rule: skipped while a `PENDING` digest exists for the pair (by payload). */
async function scheduleUnreadDigest(
  tx: PrismaTransactionClient,
  conversationId: string,
  recipientId: string,
  runAt: Date,
): Promise<boolean> {
  const pending = await tx.job.findFirst({
    where: {
      type: 'message.unreadDigest',
      status: 'PENDING',
      AND: [
        { payload: { path: ['conversationId'], equals: conversationId } },
        { payload: { path: ['recipientId'], equals: recipientId } },
      ],
    },
    select: { id: true },
  });
  if (pending) return false;
  return enqueueJob(tx, { type: 'message.unreadDigest', payload: { conversationId, recipientId }, runAt });
}

export type UnreadDigestOutcome = 'not-applicable' | 'nothing-unread' | 'rescheduled' | 'throttled' | 'notified';

/** The digest delivery's `contextKey`, which the throttle (step 3 below) looks up. */
export function digestContextKey(conversationId: string): string {
  return `conversation:${conversationId}`;
}

/**
 * The `message.unreadDigest` job (docs/domain/messaging-notifications.md). One transaction:
 * lock the recipient's participant row (a concurrent `POST …/read` writes the same row), then
 * decide. `throttled`
 * re-enqueues for one throttle period after the last digest; `notified` handed the digest to
 * `notify()`, which creates the email (or nothing, when the recipient turned the digest off).
 * A payload naming a participant row that does not exist is a `PermanentJobError`.
 */
export async function runUnreadDigest(
  conversationId: string,
  recipientId: string,
  now: Date,
): Promise<{ outcome: UnreadDigestOutcome; unreadCount: number; nextRunAt?: Date }> {
  return prisma.$transaction(async (tx) => {
    const [participant] = await tx.$queryRaw<{ lastReadAt: Date | null }[]>`
      SELECT "lastReadAt" FROM "ConversationParticipant"
       WHERE "conversationId" = ${conversationId} AND "userId" = ${recipientId} FOR UPDATE`;
    if (!participant) {
      throw new PermanentJobError(`no participant ${recipientId} in conversation ${conversationId}`);
    }

    const context = await tx.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { contract: { select: { project: { select: { deletedAt: true, title: true } } } } },
    });
    const recipient = await tx.user.findUniqueOrThrow({ where: { id: recipientId }, select: { deletedAt: true } });
    if (context.contract.project.deletedAt || recipient.deletedAt) {
      return { outcome: 'not-applicable' as const, unreadCount: 0 };
    }

    const unreadCount = (await unreadByConversation(recipientId, [conversationId], tx)).get(conversationId) ?? 0;
    if (unreadCount === 0) return { outcome: 'nothing-unread' as const, unreadCount };

    const oldest = await tx.message.findFirstOrThrow({
      where: {
        conversationId,
        kind: 'TEXT',
        deletedAt: null,
        senderId: { not: recipientId },
        ...(participant.lastReadAt ? { createdAt: { gt: participant.lastReadAt } } : {}),
      },
      orderBy: OLDEST_FIRST,
      select: { createdAt: true },
    });
    // The messages this job was enqueued for were read and newer ones arrived meanwhile (the
    // enqueue rule skipped them while this job was pending): wait for their own 10 minutes.
    if (oldest.createdAt.getTime() > now.getTime() - UNREAD_DIGEST_DELAY_MS) {
      const nextRunAt = new Date(oldest.createdAt.getTime() + UNREAD_DIGEST_DELAY_MS);
      await scheduleUnreadDigest(tx, conversationId, recipientId, nextRunAt);
      return { outcome: 'rescheduled' as const, unreadCount, nextRunAt };
    }

    // 3. Throttle: the newest digest delivery for the pair, in any status. `createdAt` is
    // the `ctx.now` of the run that created it, so this is exact under `runDueJobs({ now })`.
    const contextKey = digestContextKey(conversationId);
    const last = await tx.emailDelivery.findFirst({
      where: { userId: recipientId, type: 'MESSAGE_UNREAD_DIGEST', contextKey },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (last && last.createdAt.getTime() > now.getTime() - UNREAD_DIGEST_THROTTLE_MS) {
      const nextRunAt = new Date(last.createdAt.getTime() + UNREAD_DIGEST_THROTTLE_MS);
      await scheduleUnreadDigest(tx, conversationId, recipientId, nextRunAt);
      return { outcome: 'throttled' as const, unreadCount, nextRunAt };
    }

    // 4. The email-only digest: no in-app row; its `notification.email` job sends it on a
    // later runner pass.
    await notify(tx, {
      userId: recipientId,
      type: 'MESSAGE_UNREAD_DIGEST',
      ...renderTemplate('MESSAGE_UNREAD_DIGEST', {
        projectTitle: context.contract.project.title,
        conversationId,
        unreadCount,
      }),
      contextKey,
    }, now);
    return { outcome: 'notified' as const, unreadCount };
  });
}

// ---------------------------------------------------------------------------
// Route lookups
// ---------------------------------------------------------------------------

/** Missing or its project soft-deleted → 404, not a participant → 403. */
async function findConversationForRoute(conversationId: string, userId: string): Promise<ConversationRow> {
  const row = await prisma.conversation.findFirst({
    where: { id: conversationId, contract: { project: { deletedAt: null } } },
    include: conversationInclude,
  });
  if (!row) throw new AppError(CONVERSATION_NOT_FOUND, 404);
  if (!row.participants.some((p) => p.userId === userId)) throw new AppError(NOT_AUTHORIZED, 403);
  return row;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface ConversationListQuery {
  page: number;
  limit: number;
  /** Trimmed, non-empty search text (the schema turns a blank `q` into `undefined`). */
  q?: string;
}

/**
 * The conversations whose project title or counterpart's name contains `q`, ignoring case.
 * The counterpart is the contract party who is not `userId` — the caller's own name never matches.
 * A soft-deleted counterpart still matches: the list shows their stored name.
 */
function searchCondition(userId: string, q: string): Prisma.ConversationWhereInput {
  // Prisma passes `contains` to ILIKE unescaped: `%` and `_` would be wildcards. Escape them (and
  // the escape character itself, Postgres' default `\`) so they match literally.
  const literal = q.replace(/[\\%_]/g, '\\$&');
  const contains = { contains: literal, mode: 'insensitive' } as const;
  return {
    OR: [
      { contract: { project: { title: contains } } },
      { contract: { clientId: { not: userId }, client: { name: contains } } },
      { contract: { freelancerId: { not: userId }, freelancer: { name: contains } } },
    ],
  };
}

export async function listConversations(userId: string, query: ConversationListQuery, now: Date) {
  const where: Prisma.ConversationWhereInput = {
    participants: { some: { userId } },
    contract: { project: { deletedAt: null } },
    ...(query.q ? { AND: [searchCondition(userId, query.q)] } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.conversation.count({ where }),
    prisma.conversation.findMany({
      where,
      include: { ...conversationInclude, messages: { orderBy: NEWEST_FIRST, take: 1, include: messageInclude } },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
  ]);
  const unread = await unreadByConversation(userId, rows.map((r) => r.id));

  return {
    conversations: rows.map((row) => {
      const { messages, ...conversation } = row;
      const { counterpartLastReadAt } = sides(conversation, userId);
      return {
        ...serializeConversation(conversation, userId, unread.get(row.id) ?? 0, now),
        lastMessage: messages[0] ? serializeMessage(messages[0], userId, counterpartLastReadAt) : null,
      };
    }),
    meta: { total, page: query.page, limit: query.limit, totalPages: Math.ceil(total / query.limit) },
  };
}

export async function getConversation(conversationId: string, userId: string, now: Date = new Date()) {
  const row = await findConversationForRoute(conversationId, userId);
  const unread = await unreadByConversation(userId, [row.id]);
  return { conversation: serializeConversation(row, userId, unread.get(row.id) ?? 0, now) };
}

/** Always ascending `(createdAt, id)`; never marks anything read. */
export async function listMessages(conversationId: string, userId: string, query: MessageListQuery) {
  const row = await findConversationForRoute(conversationId, userId);
  const { counterpartLastReadAt } = sides(row, userId);

  const cursorField = query.before !== undefined ? 'before' : query.after !== undefined ? 'after' : null;
  let cursor: { id: string; createdAt: Date } | null = null;
  if (cursorField) {
    cursor = await prisma.message.findFirst({
      where: { id: query[cursorField], conversationId },
      select: { id: true, createdAt: true },
    });
    if (!cursor) throw new AppError(`${cursorField}: Message not found in this conversation`, 400);
  }

  const take = query.limit + 1;
  let rows: MessageRow[];
  if (cursor && cursorField === 'after') {
    rows = await prisma.message.findMany({
      where: {
        conversationId,
        OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }],
      },
      orderBy: OLDEST_FIRST,
      take,
      include: messageInclude,
    });
  } else {
    rows = await prisma.message.findMany({
      where: {
        conversationId,
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: NEWEST_FIRST,
      take,
      include: messageInclude,
    });
  }

  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  if (cursorField !== 'after') page.reverse();
  return { messages: page.map((m) => serializeMessage(m, userId, counterpartLastReadAt)), hasMore };
}

/**
 * Lookup, posting check, file storage, then one transaction for the message and the digest
 * (validation ran before).
 */
export async function sendMessage(
  conversationId: string,
  userId: string,
  body: string,
  files: readonly Express.Multer.File[],
  now: Date = new Date(),
) {
  const row = await findConversationForRoute(conversationId, userId);
  const { counterpartUser, counterpartLastReadAt } = sides(row, userId);

  const state = postingState(row.contract, counterpartUser, now);
  if (state.closedReason === 'CONTRACT_CLOSED') throw new AppError('This conversation is closed', 409);
  if (state.closedReason === 'COUNTERPART_INACTIVE') throw new AppError('The other participant is no longer active', 409);

  // Step 4: a storage failure is a 502 before anything is written; files stored by a request
  // whose transaction then fails stay in the bucket unreferenced.
  const stored: StoredFile[] = [];
  for (const file of files) {
    stored.push(await storeUploadedFile(file, `messages/${conversationId}`));
  }

  const message = await prisma.$transaction(async (tx) => {
    const posted = await postMessage(tx, conversationId, {
      kind: 'TEXT',
      senderId: userId,
      systemEvent: null,
      body,
      attachments: stored,
    });
    // Sends to one conversation serialize on the lock above, so this check cannot race another send.
    await scheduleUnreadDigest(
      tx,
      conversationId,
      counterpartUser.id,
      new Date(posted.createdAt.getTime() + UNREAD_DIGEST_DELAY_MS),
    );
    return posted;
  });

  return { message: serializeMessage(message, userId, counterpartLastReadAt) };
}

/** Moves `lastReadAt` up to the newest counterpart message, conditionally, so it never moves back. */
export async function markRead(conversationId: string, userId: string) {
  const row = await findConversationForRoute(conversationId, userId);
  const { counterpartUser } = sides(row, userId);

  const newest = await prisma.message.findFirst({
    where: { conversationId, kind: 'TEXT', senderId: counterpartUser.id },
    orderBy: NEWEST_FIRST,
    select: { createdAt: true },
  });
  if (newest) {
    await prisma.conversationParticipant.updateMany({
      where: {
        conversationId,
        userId,
        OR: [{ lastReadAt: null }, { lastReadAt: { lt: newest.createdAt } }],
      },
      data: { lastReadAt: newest.createdAt },
    });
  }

  const me = await prisma.conversationParticipant.findUniqueOrThrow({
    where: { conversationId_userId: { conversationId, userId } },
    select: { lastReadAt: true },
  });
  const unread = await unreadByConversation(userId, [conversationId]);
  return { lastReadAt: me.lastReadAt, unreadCount: unread.get(conversationId) ?? 0 };
}

export async function deleteMessage(conversationId: string, messageId: string, userId: string, now: Date = new Date()) {
  const row = await findConversationForRoute(conversationId, userId);
  const { counterpartLastReadAt } = sides(row, userId);

  const message = await prisma.message.findFirst({ where: { id: messageId, conversationId }, include: messageInclude });
  if (!message) throw new AppError('Message not found', 404);
  if (message.kind !== 'TEXT' || message.senderId !== userId) throw new AppError(NOT_AUTHORIZED, 403);

  const tooLate = () => new AppError('Messages can only be deleted within 5 minutes', 409);
  if (!message.deletedAt) {
    const windowStart = new Date(now.getTime() - DELETE_WINDOW_MS);
    if (message.createdAt <= windowStart) throw tooLate();
    const { count } = await prisma.message.updateMany({
      where: { id: messageId, deletedAt: null, createdAt: { gt: windowStart } },
      data: { deletedAt: now },
    });
    if (count === 0) {
      const again = await prisma.message.findUniqueOrThrow({ where: { id: messageId }, select: { deletedAt: true } });
      if (!again.deletedAt) throw tooLate();
    }
  }

  const tombstone = await prisma.message.findUniqueOrThrow({ where: { id: messageId }, include: messageInclude });
  return { message: serializeMessage(tombstone, userId, counterpartLastReadAt) };
}

export async function getContractConversation(contractId: string, userId: string) {
  const contract = await prisma.contract.findFirst({
    where: { id: contractId, project: { deletedAt: null } },
    select: { clientId: true, freelancerId: true, conversation: { select: { id: true } } },
  });
  if (!contract) throw new AppError('Contract not found', 404);
  if (contract.clientId !== userId && contract.freelancerId !== userId) throw new AppError(NOT_AUTHORIZED, 403);
  if (!contract.conversation) throw new AppError(CONVERSATION_NOT_FOUND, 404);

  const { id } = contract.conversation;
  const unread = await unreadByConversation(userId, [id]);
  return { id, unreadCount: unread.get(id) ?? 0 };
}
