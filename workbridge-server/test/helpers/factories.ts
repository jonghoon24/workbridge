import bcrypt from 'bcryptjs';
import type {
  Application,
  Career,
  Contract,
  Conversation,
  ConversationParticipant,
  Message,
  MessageAttachment,
  Milestone,
  MilestoneSubmission,
  PayoutAccount,
  Payment,
  PortfolioItem,
  Prisma,
  Project,
  User,
} from '@prisma/client';

import { prisma } from './db';
import { encryptAccountNumber } from '../../src/lib/payoutAccountCrypto';

export const TEST_PASSWORD = 'password123';

/** Monotonic so generated emails and order ids stay unique within a run. */
let seq = 0;
const next = () => ++seq;

export const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000);

/**
 * A low bcrypt cost keeps the suite fast. `bcrypt.compare` reads the cost from the hash, so
 * login still works exactly as it does in production.
 */
async function hash(password: string) {
  return bcrypt.hash(password, 4);
}

export async function makeUser(overrides: Partial<Prisma.UserCreateInput> = {}): Promise<User> {
  const n = next();
  return prisma.user.create({
    data: {
      email: `user${n}@test.local`,
      name: `User ${n}`,
      role: 'FREELANCER',
      password: await hash(TEST_PASSWORD),
      ...overrides,
    },
  });
}

/** A CLIENT with a **complete** profile, so it passes `requireCompleteProfile`. */
export function makeClient(overrides: Partial<Prisma.UserCreateInput> = {}): Promise<User> {
  return makeUser({
    role: 'CLIENT',
    companyName: 'Test Company',
    businessField: 'IT',
    ...overrides,
  });
}

/** A FREELANCER with a **complete** profile. */
export function makeFreelancer(overrides: Partial<Prisma.UserCreateInput> = {}): Promise<User> {
  return makeUser({
    role: 'FREELANCER',
    skills: ['React', 'Node.js'],
    activityCategory: '웹 개발',
    experienceYears: 3,
    hourlyRate: 50_000,
    ...overrides,
  });
}

export function makeProject(
  clientId: string,
  overrides: Partial<Prisma.ProjectUncheckedCreateInput> = {},
): Promise<Project> {
  const n = next();
  return prisma.project.create({
    data: {
      title: `Project ${n}`,
      description: `Description for project ${n}`,
      category: '웹 개발',
      budget: 5_000_000,
      requiredSkills: ['React'],
      recruitmentStartDate: daysFromNow(-1),
      deadline: daysFromNow(30),
      status: 'OPEN',
      clientId,
      ...overrides,
    },
  });
}

export function makeApplication(
  projectId: string,
  freelancerId: string,
  overrides: Partial<Prisma.ApplicationUncheckedCreateInput> = {},
): Promise<Application> {
  return prisma.application.create({
    data: {
      projectId,
      freelancerId,
      coverLetter: 'I would like to work on this project.',
      expectedRate: 4_000_000,
      expectedDuration: '4주',
      ...overrides,
    },
  });
}

export function makeContract(
  ids: { projectId: string; applicationId: string; clientId: string; freelancerId: string },
  overrides: Partial<Prisma.ContractUncheckedCreateInput> = {},
): Promise<Contract> {
  return prisma.contract.create({
    data: {
      ...ids,
      amount: 4_000_000,
      startDate: daysFromNow(0),
      endDate: daysFromNow(30),
      ...overrides,
    },
  });
}

/**
 * A milestone on `contractId`. `sequence` defaults to the next free one; the amount defaults to
 * 4,000,000 (the default contract amount) and the due date to 30 days out.
 */
export async function makeMilestone(
  contractId: string,
  overrides: Partial<Prisma.MilestoneUncheckedCreateInput> = {},
): Promise<Milestone> {
  const sequence = overrides.sequence
    ?? (await prisma.milestone.count({ where: { contractId } })) + 1;
  return prisma.milestone.create({
    data: {
      contractId,
      sequence,
      title: `Milestone ${sequence}`,
      amount: 4_000_000,
      dueDate: daysFromNow(30),
      ...overrides,
    },
  });
}

/** A payment for `milestoneId`; its `contractId` is taken from the milestone. */
export async function makePayment(
  milestoneId: string,
  clientId: string,
  overrides: Partial<Prisma.PaymentUncheckedCreateInput> = {},
): Promise<Payment> {
  const milestone = await prisma.milestone.findUniqueOrThrow({ where: { id: milestoneId } });
  return prisma.payment.create({
    data: {
      contractId: milestone.contractId,
      milestoneId,
      clientId,
      amount: milestone.amount,
      orderId: `order-${next()}`,
      ...overrides,
    },
  });
}

/** A submission (round 1 by default) awaiting review. */
export function makeSubmission(
  milestoneId: string,
  overrides: Partial<Prisma.MilestoneSubmissionUncheckedCreateInput> = {},
): Promise<MilestoneSubmission> {
  return prisma.milestoneSubmission.create({
    data: {
      milestoneId,
      round: 1,
      message: 'Here is the deliverable.',
      links: [],
      ...overrides,
    },
  });
}

/**
 * A valid payout account for `user` (holder name = the user's name). `accountNumber` is the plain
 * number; it is stored encrypted, as the API stores it.
 */
export function makePayoutAccount(
  user: Pick<User, 'id' | 'name'>,
  overrides: Partial<Prisma.PayoutAccountUncheckedCreateInput> = {},
): Promise<PayoutAccount> {
  const { accountNumber = '110123456789', ...rest } = overrides;
  return prisma.payoutAccount.create({
    data: {
      userId: user.id,
      bankCode: '004',
      holderName: user.name,
      ...rest,
      accountNumber: encryptAccountNumber(accountNumber, user.id),
    },
  });
}

export type ConversationWithParticipants = Conversation & { participants: ConversationParticipant[] };

/**
 * The contract's conversation with its two participants (client and freelancer, nothing read), as
 * accepting an application creates it — but without the `CONTRACT_CREATED`
 * system message, like a conversation backfilled by the migration.
 */
export function makeConversation(
  contract: Pick<Contract, 'id' | 'clientId' | 'freelancerId'>,
  overrides: Partial<Prisma.ConversationUncheckedCreateInput> = {},
): Promise<ConversationWithParticipants> {
  return prisma.conversation.create({
    data: {
      contractId: contract.id,
      participants: {
        create: [{ userId: contract.clientId }, { userId: contract.freelancerId }],
      },
      ...overrides,
    },
    include: { participants: true },
  });
}

/**
 * A message in `conversationId`: `TEXT` from `senderId`, or `SYSTEM` when `senderId` is `null`
 * (with `systemEvent` defaulting to `CONTRACT_CREATED`). `createdAt` defaults to now; pass it to
 * place a message in the past (the 5-minute delete window, cursors). Keeps the conversation's
 * `lastMessageAt` at its newest message, as posting does. `attachments` adds attachment
 * rows.
 */
export async function makeMessage(
  conversationId: string,
  senderId: string | null,
  overrides: Partial<Prisma.MessageUncheckedCreateInput> & {
    attachments?: Partial<Prisma.MessageAttachmentUncheckedCreateWithoutMessageInput>[];
  } = {},
): Promise<Message & { attachments: MessageAttachment[] }> {
  const { attachments = [], ...data } = overrides;
  const system = senderId === null;
  const message = await prisma.message.create({
    data: {
      conversationId,
      senderId,
      kind: system ? 'SYSTEM' : 'TEXT',
      systemEvent: system ? 'CONTRACT_CREATED' : null,
      body: system ? '계약이 생성되었습니다.' : `Message ${next()}`,
      ...data,
      attachments: {
        create: attachments.map((attachment) => {
          const n = next();
          return {
            url: `https://storage.test/messages/${conversationId}/${n}.pdf`,
            fileName: `file-${n}.pdf`,
            mimeType: 'application/pdf',
            size: 1024,
            ...attachment,
          };
        }),
      },
    },
    include: { attachments: true },
  });
  await prisma.conversation.updateMany({
    where: {
      id: conversationId,
      OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: message.createdAt } }],
    },
    data: { lastMessageAt: message.createdAt },
  });
  return message;
}

/** A portfolio item for `userId`, appended after the user's existing items (`sortOrder` max + 1). */
export async function makePortfolioItem(
  userId: string,
  overrides: Partial<Prisma.PortfolioItemUncheckedCreateInput> = {},
): Promise<PortfolioItem> {
  const last = await prisma.portfolioItem.findFirst({
    where: { userId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });
  return prisma.portfolioItem.create({
    data: {
      userId,
      title: `Portfolio ${next()}`,
      skills: ['React'],
      sortOrder: last ? last.sortOrder + 1 : 0,
      ...overrides,
    },
  });
}

/**
 * A career entry for `userId`: by default a finished `FULL_TIME` position from 2020-01 to
 * 2021-12, with months stored as the first instant of the month in KST.
 * Pass `endDate: null` for a current position.
 */
export function makeCareer(
  userId: string,
  overrides: Partial<Prisma.CareerUncheckedCreateInput> = {},
): Promise<Career> {
  const n = next();
  return prisma.career.create({
    data: {
      userId,
      company: `Company ${n}`,
      position: 'Developer',
      employmentType: 'FULL_TIME',
      startDate: new Date('2019-12-31T15:00:00.000Z'), // 2020-01 KST
      endDate: new Date('2021-11-30T15:00:00.000Z'), // 2021-12 KST
      ...overrides,
    },
  });
}

/**
 * The full chain most contract, payment, and review tests need: a client, a freelancer, a
 * project whose recruitment has closed, an accepted application, the resulting contract, its
 * default milestone (sequence 1, the whole contract amount) and its conversation with both
 * participants — as accepting an application creates them. The
 * conversation has no messages.
 *
 * Pass `contract` overrides to place the contract in a particular state, e.g.
 * `makeContractScenario({ contract: { status: 'ACTIVE', clientSigned: true, freelancerSigned: true } })`.
 * The milestone is `APPROVED` when the contract is `COMPLETED` and `PENDING` otherwise, unless
 * `milestone` overrides say differently.
 */
export async function makeContractScenario(overrides: {
  project?: Partial<Prisma.ProjectUncheckedCreateInput>;
  application?: Partial<Prisma.ApplicationUncheckedCreateInput>;
  contract?: Partial<Prisma.ContractUncheckedCreateInput>;
  milestone?: Partial<Prisma.MilestoneUncheckedCreateInput>;
} = {}) {
  const client = await makeClient();
  const freelancer = await makeFreelancer();
  const project = await makeProject(client.id, { status: 'CLOSED', ...overrides.project });
  const application = await makeApplication(project.id, freelancer.id, {
    status: 'ACCEPTED',
    ...overrides.application,
  });
  const contract = await makeContract(
    {
      projectId: project.id,
      applicationId: application.id,
      clientId: client.id,
      freelancerId: freelancer.id,
    },
    overrides.contract,
  );
  const completed = contract.status === 'COMPLETED';
  const milestone = await makeMilestone(contract.id, {
    sequence: 1,
    title: '전체 작업',
    amount: Math.round(contract.amount),
    ...(completed ? { status: 'APPROVED', approvalType: 'MANUAL', approvedAt: new Date() } : {}),
    ...overrides.milestone,
  });
  const conversation = await makeConversation(contract);

  return { client, freelancer, project, application, contract, milestone, conversation };
}

// ─── Notification channels ───────────────────────────────────────────────

/**
 * A stored preference override for `userId` and `type`. Both channels default to `null`
 * ("follow the policy default") — pass the channel the test overrides, e.g.
 * `makeNotificationPreference(user.id, 'APPLICATION_REJECTED', { email: true })`.
 * Written directly, so it can also store what the API refuses (a locked channel).
 */
export function makeNotificationPreference(
  userId: string,
  type: string,
  overrides: Partial<Prisma.NotificationPreferenceUncheckedCreateInput> = {},
) {
  return prisma.notificationPreference.create({
    data: { userId, type, inApp: null, email: null, ...overrides },
  });
}

/**
 * An email delivery addressed to `user`: `PENDING`, no attempts, no linked notification, as
 * `notify()` creates it but without enqueueing its `notification.email` job. Pass
 * `createdAt` to place a digest delivery in time for the unread-digest throttle, e.g.
 * `{ type: 'MESSAGE_UNREAD_DIGEST', contextKey: 'conversation:<id>', createdAt }`.
 */
export function makeEmailDelivery(
  user: Pick<User, 'id' | 'email'>,
  overrides: Partial<Prisma.EmailDeliveryUncheckedCreateInput> = {},
) {
  return prisma.emailDelivery.create({
    data: {
      userId: user.id,
      type: 'APPLICATION_CREATED',
      toAddress: user.email,
      subject: '[WorkBridge] 테스트 알림',
      body: '테스트 본문',
      ...overrides,
    },
  });
}
