// CommonJS: this file is run directly by `node` and is outside tsconfig's `include`,
// so it is not transpiled. The package has no `"type": "module"`, which means `import`
// syntax here would be a SyntaxError.
//
// It loads `workbridge-server/.env` with dotenv, which never overrides a variable that is already set
// (CI and scripts/e2e.sh export theirs). Prisma reads `.env` for its own DATABASE_URL, but does not put
// other variables into `process.env` — the seed needs PAYOUT_ACCOUNT_ENCRYPTION_KEY from there too.
//
// Sample dataset for local development and the shared environments (docs/SEED_DATA.md describes it). Every date is computed from the
// moment the seed runs, so OPEN projects always have a future deadline and settlement weeks line
// up with the real calendar. The rows follow the same invariants the services keep (docs/domain/):
// milestone sums, sequential funding, one payment per funded milestone, fee math, settlement
// sums, strictly increasing message times, and one system message per contract/milestone event.
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { encryptAccountNumber } = require('./payoutAccountCrypto');

const prisma = new PrismaClient();

// ─── Time ─────────────────────────────────────────────
// KST is a fixed UTC+9 offset (docs/domain/README.md, 시간대). These mirror src/lib/time.ts, which a plain
// JS file cannot import.
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const KST_OFFSET = 9 * HOUR;

const now = new Date();
const plus = (date, ms) => new Date(date.getTime() + ms);
const ago = (ms) => plus(now, -ms);
const later = (ms) => plus(now, ms);

function startOfKstDay(date) {
  return new Date(Math.floor((date.getTime() + KST_OFFSET) / DAY) * DAY - KST_OFFSET);
}
/** A due date is the last millisecond of its KST day. */
function endOfKstDay(date) {
  return new Date(startOfKstDay(date).getTime() + DAY - 1);
}
/** 0 = Sunday … 6 = Saturday, in KST. */
function kstWeekday(date) {
  return new Date(startOfKstDay(date).getTime() + KST_OFFSET).getUTCDay();
}
/** A `YYYY-MM` month is stored as the first instant of that month in KST. */
function kstMonth(month) {
  const [year, mon] = month.split('-').map(Number);
  return new Date(Date.UTC(year, mon - 1, 1) - KST_OFFSET);
}
/** The first Wednesday 10:00 KST strictly after `after` (the weekly payout time). */
function nextWednesday10(after) {
  const dayStart = startOfKstDay(after);
  const ahead = (3 - kstWeekday(after) + 7) % 7;
  const candidate = plus(dayStart, ahead * DAY + 10 * HOUR);
  return candidate > after ? candidate : plus(candidate, 7 * DAY);
}

// Settlement calendar. A period runs Monday 00:00 → next Monday 00:00 KST; its batch runs at
// Monday 03:00 and pays out on Wednesday 10:00. `settledUntil` is the end of the newest period whose
// batch has already run, so items approved before it are in a settlement and items approved after
// it are still unsettled — whichever day of the week the seed runs.
const BATCH_DELAY = 3 * HOUR;
const PAYOUT_DELAY = 2 * DAY + 10 * HOUR;
const PAYOUT_RETRY = DAY;
const thisMonday = plus(startOfKstDay(now), -((kstWeekday(now) + 6) % 7) * DAY);
const lastBatchAt = now >= plus(thisMonday, BATCH_DELAY) ? plus(thisMonday, BATCH_DELAY) : plus(thisMonday, BATCH_DELAY - 7 * DAY);
const settledUntil = plus(lastBatchAt, -BATCH_DELAY);
/** Monday 00:00 KST of the n-th settled week back (1 = the week that ended at `settledUntil`). */
const weekStart = (n) => plus(settledUntil, -n * 7 * DAY);
/** A KST wall-clock instant in week n: day 0 = Monday. */
const inWeek = (n, day, hour, minute = 0) => plus(weekStart(n), day * DAY + hour * HOUR + minute * MINUTE);
/** A point in the still-unsettled window [settledUntil, now): 0 = its start, 1 = now. */
const recent = (fraction) => new Date(settledUntil.getTime() + (now.getTime() - settledUntil.getTime()) * fraction);

/** The default auto-approval delay (MILESTONE_AUTO_APPROVE_DAYS unset). */
const AUTO_APPROVE_MS = 7 * DAY;

// ─── Money ────────────────────────────────────────────
// Same constants and integer arithmetic as src/lib/money.ts.
const PLATFORM_FEE_RATE_BPS = 1000;
const FEE_VAT_RATE_BPS = 1000;
function payoutBreakdown(gross) {
  const fee = Math.floor((gross * PLATFORM_FEE_RATE_BPS) / 10000);
  const vat = Math.floor((fee * FEE_VAT_RATE_BPS) / 10000);
  return { gross, fee, vat, net: gross - fee - vat };
}
const won = (amount) => `${amount.toLocaleString('ko-KR')}원`;

// Same entries as src/lib/banks.ts.
const BANKS = { '004': 'KB국민', '088': '신한', '090': '카카오뱅크' };
const maskAccountNumber = (digits) => '*'.repeat(Math.max(digits.length - 4, 0)) + digits.slice(-4);

// Placeholder images that load without a storage bucket.
const placeholder = (text, color = '2563eb') => `https://placehold.co/800x500/${color}/ffffff/png?text=${encodeURIComponent(text)}`;

function check(condition, message) {
  if (!condition) throw new Error(`Seed invariant violated: ${message}`);
}

// ─── Notification wording ─────────────────────────────
// Copies of src/lib/notifications/templates.ts and of the inline wording of the four types that keep
// their strings in their controllers (applications.controller.ts). Only the types the seed uses.
const milestoneHref = (contractId, milestoneId) => `/contracts/${contractId}/milestones/${milestoneId}`;
const TEMPLATES = {
  APPLICATION_CREATED: (v) => ({
    title: '새 지원자가 있습니다',
    message: `${v.applicantName}님이 '${v.projectTitle}' 프로젝트에 지원했습니다.`,
    href: `/projects/${v.projectId}/applications`,
  }),
  APPLICATION_ACCEPTED: (v) => ({
    title: '지원이 수락되었습니다',
    message: `'${v.projectTitle}' 프로젝트 지원이 수락되었습니다. 계약서를 확인해 주세요.`,
    href: `/contracts/${v.contractId}`,
  }),
  APPLICATION_REJECTED: (v) => ({
    title: '지원 결과를 알려 드립니다',
    message: `'${v.projectTitle}' 프로젝트 지원이 거절되었습니다.`,
    href: '/my/applications',
  }),
  CONTRACT_ACTIVATED: (v) => ({
    title: '계약이 체결되었습니다',
    message: `'${v.projectTitle}' 계약에 양측이 서명했습니다. 첫 마일스톤 결제부터 진행해 주세요.`,
    href: `/contracts/${v.contractId}`,
  }),
  MILESTONE_FUNDED: (v) => ({
    title: '마일스톤 결제가 완료되었습니다',
    message: `마일스톤 '${v.milestoneTitle}'의 ${won(v.amount)}이 안전결제로 결제되었습니다. 작업을 시작해 주세요.`,
    href: milestoneHref(v.contractId, v.milestoneId),
  }),
  MILESTONE_SUBMITTED: (v) => ({
    title: '결과물이 제출되었습니다',
    message: `마일스톤 '${v.milestoneTitle}'의 결과물이 제출되었습니다. 검수 후 승인하거나 수정을 요청해 주세요.`,
    href: milestoneHref(v.contractId, v.milestoneId),
  }),
  MILESTONE_REVISION_REQUESTED: (v) => ({
    title: '수정 요청이 있습니다',
    message: `마일스톤 '${v.milestoneTitle}'에 수정 요청이 있습니다: ${v.reason}`,
    href: milestoneHref(v.contractId, v.milestoneId),
  }),
  MILESTONE_APPROVED: (v) => ({
    title: '마일스톤이 승인되었습니다',
    message: `'${v.milestoneTitle}' 마일스톤이 승인되었습니다. 다음 정산에 포함됩니다.`,
    href: milestoneHref(v.contractId, v.milestoneId),
  }),
  MILESTONE_AUTO_APPROVED: (v) => ({
    title: '마일스톤이 자동 승인되었습니다',
    message: `검수 기간이 지나 '${v.milestoneTitle}' 마일스톤이 자동으로 승인되었습니다.`,
    href: milestoneHref(v.contractId, v.milestoneId),
  }),
  MILESTONE_AUTO_APPROVE_REMINDER: (v) => ({
    title: '곧 자동 승인됩니다',
    message: `'${v.milestoneTitle}' 마일스톤이 48시간 뒤 자동 승인됩니다. 그 전에 검수해 주세요.`,
    href: milestoneHref(v.contractId, v.milestoneId),
  }),
  CONTRACT_COMPLETED: (v) => ({
    title: '계약이 완료되었습니다',
    message: `'${v.projectTitle}' 계약의 모든 마일스톤이 승인되었습니다. 리뷰를 남겨 주세요.`,
    href: `/contracts/${v.contractId}#review`,
  }),
  SETTLEMENT_SCHEDULED: (v) => ({
    title: '정산이 예정되었습니다',
    message: `${won(v.amount)} 정산이 예정되었습니다.`,
    href: `/settlements/${v.settlementId}`,
  }),
  SETTLEMENT_PAID: (v) => ({
    title: '정산금이 지급되었습니다',
    message: `${won(v.amount)}이 지급 계좌로 입금되었습니다.`,
    href: `/settlements/${v.settlementId}`,
  }),
  SETTLEMENT_ON_HOLD: (v) => ({
    title: '정산이 보류되었습니다',
    message: `지급 계좌가 없어 ${won(v.amount)} 정산이 보류되었습니다. 지급 계좌를 등록해 주세요.`,
    href: '/settlements/account',
  }),
  SETTLEMENT_FAILED: (v) => ({
    title: '정산 지급에 실패했습니다',
    message: `${won(v.amount)} 지급이 반복해서 실패했습니다. 지급 계좌 정보(은행, 계좌번호, 예금주)를 확인해 주세요.`,
    href: `/settlements/${v.settlementId}`,
  }),
  MESSAGE_UNREAD_DIGEST: (v) => ({
    title: '읽지 않은 메시지가 있습니다',
    message: `'${v.projectTitle}' 대화방에 읽지 않은 메시지가 ${v.unreadCount}개 있습니다.`,
    href: `/messages/${v.conversationId}`,
  }),
};

// System message bodies: a copy of SYSTEM_BODIES in src/services/messaging.service.ts.
const msTitle = (v) => `마일스톤 '${v.milestoneTitle}'`;
const SYSTEM_BODIES = {
  CONTRACT_CREATED: () => '계약이 생성되었습니다. 마일스톤 계획을 확인해 주세요.',
  MILESTONE_PLAN_UPDATED: (v) => (v.signaturesReset
    ? '마일스톤 계획이 변경되어 서명이 초기화되었습니다. 다시 확인하고 서명해 주세요.'
    : '마일스톤 계획이 변경되었습니다. 확인한 뒤 서명해 주세요.'),
  CONTRACT_ACTIVATED: () => '양측이 서명해 계약이 시작되었습니다. 첫 마일스톤 결제부터 진행해 주세요.',
  MILESTONE_FUNDED: (v) => `${msTitle(v)} 결제가 완료되었습니다. 작업을 시작해 주세요.`,
  MILESTONE_SUBMITTED: (v) => `${msTitle(v)} 결과물이 제출되었습니다 (${v.round}차). 검수 후 승인하거나 수정을 요청해 주세요.`,
  MILESTONE_REVISION_REQUESTED: (v) => `${msTitle(v)} 수정이 요청되었습니다.\n요청 사항: ${v.reason}`,
  MILESTONE_APPROVED: (v) => `${msTitle(v)} 결과물이 승인되었습니다.`,
  MILESTONE_AUTO_APPROVED: (v) => `${msTitle(v)} 결과물이 검수 기한이 지나 자동 승인되었습니다.`,
  CONTRACT_COMPLETED: () => '모든 마일스톤이 승인되어 계약이 완료되었습니다. 서로 리뷰를 남겨 주세요.',
};

// Email rendering (src/lib/notifications/templates.ts `renderEmail`).
const LINK_BASE = ((process.env.CLIENT_URL || '').split(',')[0].trim() || 'http://localhost:3000').replace(/\/+$/, '');
function renderEmail({ title, message, href }) {
  const lines = [message, ''];
  if (href) lines.push(`바로가기: ${LINK_BASE}${href}`, '');
  lines.push(`알림 설정: ${LINK_BASE}/my/notifications/settings`);
  return { subject: `[WorkBridge] ${title}`, body: lines.join('\n') };
}

// ─── Row helpers ──────────────────────────────────────
// Each mirrors one service step so the rows look exactly as if the app had produced them.

async function notifyRow(user, type, vars, createdAt, readAt = null) {
  check(createdAt <= now, `${type} notification in the future`);
  const rendered = TEMPLATES[type](vars);
  return prisma.notification.create({
    data: { userId: user.id, type, ...rendered, createdAt, readAt },
  });
}

/** An `EmailDelivery` as notify() writes it, already sent (or failed) by its `notification.email` job. */
async function emailRow(user, type, vars, { createdAt, notification = null, contextKey = null, status = 'SENT', provider = 'log', error = null, attempts = 1 }) {
  const rendered = TEMPLATES[type](vars);
  const { subject, body } = renderEmail(rendered);
  return prisma.emailDelivery.create({
    data: {
      userId: user.id,
      notificationId: notification ? notification.id : null,
      type,
      toAddress: user.email,
      subject,
      body,
      contextKey,
      status,
      attempts,
      provider,
      providerMessageId: status === 'SENT' ? `log-${uuidv4()}` : null,
      error,
      sentAt: status === 'SENT' ? plus(createdAt, 4 * 1000) : null,
      createdAt,
    },
  });
}

/** A pending job the seeded state implies (payload shapes: src/jobs/types.ts). Past run times are skipped. */
async function jobRow(type, payload, runAt, dedupeKey) {
  if (runAt <= now) return null;
  return prisma.job.create({ data: { type, payload, runAt, dedupeKey } });
}

/** Accepting an application: the PENDING contract (amount = expectedRate). */
async function createContract({ project, application, client, freelancer, acceptedAt }) {
  return prisma.contract.create({
    data: {
      projectId: project.id,
      applicationId: application.id,
      clientId: client.id,
      freelancerId: freelancer.id,
      amount: application.expectedRate,
      startDate: acceptedAt,
      endDate: acceptedAt, // replaced by the last due date once the plan exists
      createdAt: acceptedAt,
    },
  });
}

/** The plan as replaced by the client; `endDate` follows the last due date. */
async function createPlan(contract, plan, createdAt) {
  check(plan.reduce((sum, m) => sum + m.amount, 0) === Math.round(contract.amount), `plan of ${contract.id} must add up`);
  const milestones = [];
  for (const [index, m] of plan.entries()) {
    if (index > 0) check(m.dueDate >= plan[index - 1].dueDate, 'due dates must not decrease');
    milestones.push(await prisma.milestone.create({
      data: {
        contractId: contract.id,
        sequence: index + 1,
        title: m.title,
        description: m.description || null,
        amount: m.amount,
        dueDate: m.dueDate,
        createdAt,
      },
    }));
  }
  await prisma.contract.update({ where: { id: contract.id }, data: { endDate: plan[plan.length - 1].dueDate } });
  return milestones;
}

async function signContract(contract, { clientSignedAt = null, freelancerSignedAt = null }) {
  const active = Boolean(clientSignedAt && freelancerSignedAt);
  return prisma.contract.update({
    where: { id: contract.id },
    data: { clientSigned: Boolean(clientSignedAt), freelancerSigned: Boolean(freelancerSignedAt), status: active ? 'ACTIVE' : 'PENDING' },
  });
}

let paymentSerial = 0;
/** The payment completes and the milestone is funded. */
async function fund(contract, milestone, fundedAt) {
  paymentSerial += 1;
  const ymd = new Date(fundedAt.getTime() + KST_OFFSET).toISOString().slice(0, 10).replace(/-/g, '');
  await prisma.payment.create({
    data: {
      contractId: contract.id,
      milestoneId: milestone.id,
      clientId: contract.clientId,
      amount: milestone.amount,
      status: 'COMPLETED',
      paymentKey: `tgen_${ymd}_seed_${String(paymentSerial).padStart(3, '0')}`,
      orderId: uuidv4(),
      createdAt: plus(fundedAt, -2 * MINUTE),
    },
  });
  return prisma.milestone.update({ where: { id: milestone.id }, data: { status: 'FUNDED', fundedAt } });
}

/** A submission round; the milestone waits for review until `autoApproveAt`. */
async function submit(milestone, { round, at, message, links = [], attachments = [] }) {
  const submission = await prisma.milestoneSubmission.create({
    data: {
      milestoneId: milestone.id,
      round,
      message,
      links,
      submittedAt: at,
      attachments: { create: attachments.map((a) => ({ ...a, createdAt: at })) },
    },
  });
  const updated = await prisma.milestone.update({
    where: { id: milestone.id },
    data: { status: 'SUBMITTED', submittedAt: at, autoApproveAt: plus(at, AUTO_APPROVE_MS) },
  });
  return { milestone: updated, submission };
}

/** A revision request: the latest submission is rejected and the auto-approval timer cleared. */
async function requestRevision(milestone, submission, { at, by, reason }) {
  await prisma.milestoneSubmission.update({
    where: { id: submission.id },
    data: { decision: 'REJECTED', decisionReason: reason, decidedAt: at, decidedById: by.id },
  });
  return prisma.milestone.update({
    where: { id: milestone.id },
    data: { status: 'REVISION_REQUESTED', revisionCount: { increment: 1 }, autoApproveAt: null },
  });
}

/** A manual approval (by a client) or an automatic one (`by` null), plus the settlement item. */
async function approve(contract, milestone, submission, { at, by }) {
  const auto = by === null;
  await prisma.milestoneSubmission.update({
    where: { id: submission.id },
    data: { decision: 'APPROVED', decidedAt: at, decidedById: auto ? null : by.id, autoDecided: auto },
  });
  const updated = await prisma.milestone.update({
    where: { id: milestone.id },
    data: { status: 'APPROVED', approvedAt: at, approvalType: auto ? 'AUTO' : 'MANUAL', autoApproveAt: null },
  });
  const b = payoutBreakdown(milestone.amount);
  const item = await prisma.settlementItem.create({
    data: {
      milestoneId: milestone.id,
      contractId: contract.id,
      freelancerId: contract.freelancerId,
      grossAmount: b.gross,
      feeRateBps: PLATFORM_FEE_RATE_BPS,
      feeAmount: b.fee,
      feeVatAmount: b.vat,
      netAmount: b.net,
      approvedAt: at,
      createdAt: at,
    },
  });
  return { milestone: updated, item };
}

/** The weekly batch's settlement of week n, totals summed from its items. */
async function createSettlement(freelancer, n, items, data) {
  const periodStart = weekStart(n);
  const periodEnd = plus(periodStart, 7 * DAY);
  for (const item of items) check(item.approvedAt >= periodStart && item.approvedAt < periodEnd, 'item outside its settlement week');
  const totals = items.reduce(
    (t, i) => ({ gross: t.gross + i.grossAmount, fee: t.fee + i.feeAmount, vat: t.vat + i.feeVatAmount, net: t.net + i.netAmount }),
    { gross: 0, fee: 0, vat: 0, net: 0 },
  );
  const settlement = await prisma.settlement.create({
    data: {
      freelancerId: freelancer.id,
      periodStart,
      periodEnd,
      scheduledPayoutAt: plus(periodEnd, PAYOUT_DELAY),
      itemCount: items.length,
      grossAmount: totals.gross,
      feeAmount: totals.fee,
      feeVatAmount: totals.vat,
      netAmount: totals.net,
      createdAt: plus(periodEnd, BATCH_DELAY),
      ...data,
    },
  });
  await prisma.settlementItem.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { settlementId: settlement.id } });
  return settlement;
}

/** The account snapshot a payout takes on entering `PROCESSING`. */
const accountSnapshot = (account) => ({
  bankName: BANKS[account.bankCode],
  accountNumberMasked: maskAccountNumber(account.accountNumber),
  accountHolder: account.holderName,
});

/**
 * The contract's conversation, its two participants and its messages. Message times are
 * forced strictly increasing (`max(at, last + 1 ms)`, as the service does) and `lastMessageAt` follows the
 * newest one. `reads` maps a participant to the key of the newest counterpart message they have
 * read; a participant missing from it has read nothing.
 */
async function seedConversation(contract, entries, reads = {}) {
  const conversation = await prisma.conversation.create({
    data: {
      contractId: contract.id,
      createdAt: contract.createdAt,
      participants: {
        create: [
          { userId: contract.clientId, createdAt: contract.createdAt },
          { userId: contract.freelancerId, createdAt: contract.createdAt },
        ],
      },
    },
  });
  const byKey = {};
  let last = null;
  for (const entry of entries) {
    let createdAt = entry.at;
    if (last && createdAt <= last) createdAt = plus(last, 1);
    check(createdAt <= now, `message in the future in conversation of ${contract.id}`);
    const system = Boolean(entry.system);
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        kind: system ? 'SYSTEM' : 'TEXT',
        systemEvent: system ? entry.system : null,
        senderId: system ? null : entry.from.id,
        body: system ? SYSTEM_BODIES[entry.system](entry.vars || {}) : entry.body,
        deletedAt: entry.deletedAt || null,
        createdAt,
        attachments: { create: (entry.attachments || []).map((a) => ({ ...a, createdAt })) },
      },
    });
    if (entry.key) byKey[entry.key] = message;
    last = createdAt;
  }
  await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: last } });
  for (const [userId, key] of Object.entries(reads)) {
    const message = byKey[key];
    check(message && message.senderId && message.senderId !== userId, `read watermark of ${userId} must be a counterpart message`);
    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId: conversation.id, userId } },
      data: { lastReadAt: message.createdAt },
    });
  }
  return { conversation, messages: byKey };
}

async function main() {
  console.log('Seeding database...');

  // Fail before wiping anything when the payout account key is missing or malformed.
  encryptAccountNumber('0000000000', 'key-check', process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY);

  // Clean existing data (역순으로 삭제)
  // Notification must be deleted first: it holds a `userId` foreign key, so the
  // `user.deleteMany()` below fails with Prisma P2003 if any notification rows survive.
  // The app creates these whenever an application is accepted, so anyone who uses the
  // app and then re-seeds hits this.
  // Infrastructure tables have no foreign keys; cleared so a re-seed starts from an empty queue.
  // (Recurring jobs are not seeded — the worker recreates them via `ensureRecurringJobs`.)
  await prisma.job.deleteMany();
  await prisma.rateLimitCounter.deleteMany();
  // An email delivery may reference a notification, so it goes first.
  await prisma.emailDelivery.deleteMany();
  await prisma.notificationPreference.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.review.deleteMany();
  // Messaging and profile models, children first. The migration backfills a conversation for every contract,
  // so these must go before `contract` or the next seed fails with P2003.
  await prisma.messageAttachment.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversationParticipant.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.portfolioItem.deleteMany();
  await prisma.career.deleteMany();
  // Milestone and settlement models, children first (every FK is ON DELETE RESTRICT).
  await prisma.settlementItem.deleteMany();
  await prisma.settlement.deleteMany();
  await prisma.payoutAccount.deleteMany();
  await prisma.milestoneAttachment.deleteMany();
  await prisma.milestoneSubmission.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.milestone.deleteMany();
  await prisma.contract.deleteMany();
  await prisma.pricingAnalysis.deleteMany();
  await prisma.projectBookmark.deleteMany();
  await prisma.application.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();

  const password = await bcrypt.hash('password123', 10);

  // ─── Users ───────────────────────────────────────────
  const client1 = await prisma.user.create({
    data: {
      email: 'kim@example.com',
      password,
      name: '김서준',
      role: 'CLIENT',
      bio: '스타트업 대표로 다양한 IT 프로젝트를 진행하고 있습니다.',
      companyName: '넥스트랩',
      businessField: 'IT/소프트웨어',
      website: 'https://nextlab.io',
      createdAt: ago(240 * DAY),
    },
  });

  const client2 = await prisma.user.create({
    data: {
      email: 'lee@example.com',
      password,
      name: '이수현',
      role: 'CLIENT',
      bio: '마케팅 에이전시를 운영하며 웹/앱 개발 외주를 자주 의뢰합니다.',
      companyName: '브릿지마케팅',
      businessField: '마케팅/광고',
      website: 'https://bridgemkt.co.kr',
      createdAt: ago(220 * DAY),
    },
  });

  const client3 = await prisma.user.create({
    data: {
      email: 'choi@example.com',
      password,
      name: '최민호',
      role: 'CLIENT',
      bio: '교육 플랫폼 기획자입니다.',
      companyName: '에듀플러스',
      businessField: '교육/에듀테크',
      createdAt: ago(180 * DAY),
    },
  });

  const freelancer1 = await prisma.user.create({
    data: {
      email: 'park@example.com',
      password,
      name: '박지윤',
      role: 'FREELANCER',
      bio: '풀스택 개발자로 5년간 다양한 웹 서비스를 개발해왔습니다. React와 Node.js를 주로 사용합니다.',
      skills: ['React', 'Node.js', 'TypeScript', 'SQL', 'AWS'],
      activityCategory: '웹 개발',
      experienceYears: 5,
      hourlyRate: 60000,
      portfolioUrl: 'https://jiyun-dev.vercel.app',
      createdAt: ago(230 * DAY),
    },
  });

  const freelancer2 = await prisma.user.create({
    data: {
      email: 'jung@example.com',
      password,
      name: '정하은',
      role: 'FREELANCER',
      bio: 'UI/UX 디자인과 프론트엔드 개발을 모두 할 수 있는 디자인 엔지니어입니다.',
      skills: ['Figma', 'React', 'Next.js', 'Tailwind CSS', 'Framer Motion'],
      activityCategory: '디자인',
      experienceYears: 4,
      hourlyRate: 55000,
      portfolioUrl: 'https://haeun-design.com',
      createdAt: ago(210 * DAY),
    },
  });

  const freelancer3 = await prisma.user.create({
    data: {
      email: 'han@example.com',
      password,
      name: '한도윤',
      role: 'FREELANCER',
      bio: '백엔드 전문 개발자입니다. 대규모 트래픽 처리와 API 설계에 강점이 있습니다.',
      skills: ['Java', 'Spring Boot', 'Node.js', 'Docker', 'Kubernetes', 'Redis'],
      activityCategory: '웹 개발',
      experienceYears: 7,
      hourlyRate: 80000,
      portfolioUrl: 'https://github.com/handoyun',
      createdAt: ago(200 * DAY),
    },
  });

  const freelancer4 = await prisma.user.create({
    data: {
      email: 'yoon@example.com',
      password,
      name: '윤서아',
      role: 'FREELANCER',
      bio: '모바일 앱 개발 전문. React Native와 Flutter 경험이 풍부합니다.',
      skills: ['React Native', 'Flutter', 'Dart', 'Firebase', 'Swift'],
      activityCategory: '모바일 앱',
      experienceYears: 3,
      hourlyRate: 50000,
      portfolioUrl: 'https://seoa-app.dev',
      createdAt: ago(150 * DAY),
    },
  });

  const freelancer5 = await prisma.user.create({
    data: {
      email: 'song@example.com',
      password,
      name: '송민재',
      role: 'FREELANCER',
      bio: 'AI/ML 엔지니어입니다. Python과 데이터 분석 기반 솔루션을 제공합니다.',
      skills: ['Python', 'TensorFlow', 'PyTorch', 'FastAPI', 'Pandas', 'SQL'],
      activityCategory: 'AI/ML',
      experienceYears: 6,
      hourlyRate: 70000,
      createdAt: ago(190 * DAY),
    },
  });

  console.log('Users created');

  // ─── Projects ────────────────────────────────────────
  // Recruiting projects: deadlines relative to the seed time, so they stay OPEN after a re-seed.
  const project1 = await prisma.project.create({
    data: {
      title: 'AI 기반 고객 상담 챗봇 개발',
      description:
        '자사 쇼핑몰에 적용할 AI 챗봇을 개발합니다. GPT API를 연동하여 고객 문의에 자동 응답하고, 주문 조회/반품 접수 등의 기능을 포함해야 합니다. 관리자 대시보드에서 대화 이력 확인 및 챗봇 학습 데이터 관리 기능도 필요합니다.',
      category: 'AI/ML',
      budget: 8000000,
      deadline: endOfKstDay(later(18 * DAY)),
      requiredSkills: ['Python', 'React', 'OpenAI API', 'SQL'],
      status: 'OPEN',
      clientId: client1.id,
      createdAt: ago(6 * DAY),
    },
  });

  const project2 = await prisma.project.create({
    data: {
      title: '반응형 기업 홈페이지 리뉴얼',
      description:
        '기존 워드프레스 기반 홈페이지를 Next.js로 전환합니다. 모바일 퍼스트 반응형 디자인, SEO 최적화, 다국어 지원(한/영)이 필요합니다. 디자인 시안은 Figma로 제공될 예정입니다.',
      category: '웹 개발',
      budget: 5000000,
      deadline: endOfKstDay(later(12 * DAY)),
      requiredSkills: ['Next.js', 'React', 'Tailwind CSS', 'Figma'],
      status: 'OPEN',
      clientId: client2.id,
      createdAt: ago(4 * DAY),
    },
  });

  const project3 = await prisma.project.create({
    data: {
      title: '온라인 강의 플랫폼 MVP 개발',
      description:
        '강사가 강의를 등록하고 학생이 수강할 수 있는 LMS 플랫폼입니다. 영상 스트리밍, 진도 관리, 퀴즈/과제 제출, 수료증 발급 기능이 필요합니다. 결제는 토스페이먼츠를 사용합니다.',
      category: '웹 개발',
      budget: 15000000,
      deadline: endOfKstDay(later(25 * DAY)),
      requiredSkills: ['React', 'Node.js', 'SQL', 'AWS', 'FFmpeg'],
      status: 'OPEN',
      clientId: client3.id,
      createdAt: ago(9 * DAY),
    },
  });

  const project4 = await prisma.project.create({
    data: {
      title: '헬스케어 모바일 앱 개발',
      description:
        '사용자의 운동 기록, 식단 관리, 건강 데이터 시각화를 제공하는 모바일 앱입니다. iOS/Android 크로스 플랫폼으로 개발하며 웨어러블 기기 연동도 고려해주세요.',
      category: '모바일 앱',
      budget: 12000000,
      recruitmentStartDate: startOfKstDay(later(5 * DAY)),
      deadline: endOfKstDay(later(35 * DAY)),
      requiredSkills: ['React Native', 'Node.js', 'Firebase', 'HealthKit'],
      status: 'UPCOMING',
      clientId: client1.id,
      createdAt: ago(1 * DAY),
    },
  });

  const project5 = await prisma.project.create({
    data: {
      title: '소셜 미디어 대시보드 개발',
      description:
        '인스타그램, 유튜브, 블로그 등 여러 채널의 마케팅 성과를 한눈에 볼 수 있는 대시보드입니다. 각 플랫폼 API 연동, 실시간 데이터 시각화, 보고서 PDF 출력 기능이 필요합니다.',
      category: '데이터 분석',
      budget: 7000000,
      deadline: endOfKstDay(later(9 * DAY)),
      requiredSkills: ['React', 'Python', 'FastAPI', 'Chart.js', 'SQL'],
      status: 'OPEN',
      clientId: client2.id,
      createdAt: ago(12 * DAY),
    },
  });

  // 모집 기간이 지나 마감된 프로젝트 (계약 없음). The lazy sweep rejected its pending application.
  const project6 = await prisma.project.create({
    data: {
      title: '브랜드 아이덴티티 디자인',
      description:
        '신규 브랜드의 로고, 컬러 팔레트, 타이포그래피, 명함, 패키지 디자인 등 전체 BI를 작업합니다. 브랜드 가이드라인 문서도 함께 납품해야 합니다.',
      category: '디자인',
      budget: 3000000,
      deadline: endOfKstDay(ago(3 * DAY)),
      requiredSkills: ['Figma', 'Illustrator', 'Photoshop', 'Branding'],
      status: 'CLOSED',
      clientId: client1.id,
      createdAt: ago(30 * DAY),
    },
  });

  // 완료된 프로젝트 (마일스톤 3개 모두 승인, 상호 리뷰)
  const project7 = await prisma.project.create({
    data: {
      title: '사내 ERP 시스템 API 개발',
      description:
        '기존 엑셀 기반 업무 관리를 대체할 REST API 서버를 개발합니다. 인사관리, 프로젝트 관리, 비용 처리 모듈이 포함됩니다.',
      category: '웹 개발',
      budget: 10000000,
      deadline: endOfKstDay(inWeek(6, 4, 0)),
      requiredSkills: ['Node.js', 'Express', 'SQL', 'Docker'],
      status: 'COMPLETED',
      clientId: client2.id,
      createdAt: inWeek(6, 0, 10),
    },
  });

  // 계약 진행 중 (재제출된 마일스톤 검수 대기)
  const project8 = await prisma.project.create({
    data: {
      title: '이커머스 관리자 페이지 개발',
      description:
        '쇼핑몰 관리자 전용 대시보드를 개발합니다. 상품 등록/수정, 주문 관리, 매출 통계, 회원 관리 기능이 필요합니다.',
      category: '웹 개발',
      budget: 6000000,
      deadline: endOfKstDay(inWeek(4, 0, 0)),
      requiredSkills: ['React', 'TypeScript', 'Node.js', 'Prisma'],
      status: 'CLOSED',
      clientId: client3.id,
      createdAt: inWeek(5, 1, 10),
    },
  });

  // 서명 전 계약 (마일스톤 계획 편집을 확인할 수 있다)
  const project9 = await prisma.project.create({
    data: {
      title: '사내 행사 체크인 모바일 앱',
      description:
        '사내 컨퍼런스와 워크숍에서 쓸 체크인 앱입니다. QR 코드 스캔으로 참가자를 확인하고, 참가자 명단을 관리자 웹과 실시간으로 동기화해야 합니다. 네트워크가 불안정한 행사장을 고려해 오프라인 체크인도 지원해야 합니다.',
      category: '모바일 앱',
      budget: 6000000,
      deadline: endOfKstDay(later(4 * DAY)),
      requiredSkills: ['React Native', 'Firebase', 'TypeScript'],
      status: 'CLOSED',
      clientId: client1.id,
      createdAt: ago(12 * DAY),
    },
  });

  // 계약 진행 중 (자동 승인된 마일스톤, 수정 요청된 마일스톤)
  const project10 = await prisma.project.create({
    data: {
      title: '브랜드 캠페인 랜딩 페이지 제작',
      description:
        '11월 프로모션 캠페인용 랜딩 페이지를 디자인하고 퍼블리싱합니다. 모바일 퍼스트로 제작하며 스크롤 인터랙션과 이벤트 응모 폼이 필요합니다. 브랜드 가이드는 PDF로 제공합니다.',
      category: '디자인',
      budget: 4500000,
      deadline: endOfKstDay(inWeek(4, 2, 0)),
      requiredSkills: ['Figma', 'React', 'Next.js', 'Tailwind CSS'],
      status: 'CLOSED',
      clientId: client2.id,
      createdAt: inWeek(5, 2, 10),
    },
  });

  // 계약 진행 중 (결제 완료 후 작업 중인 마일스톤)
  const project11 = await prisma.project.create({
    data: {
      title: '쇼핑몰 상품 추천 모델 고도화',
      description:
        '현재 협업 필터링 기반 추천을 행동 로그 기반 딥러닝 모델로 고도화합니다. 오프라인 평가 지표 설계, 모델 학습, 추천 API 서빙과 A/B 테스트 리포트까지 포함합니다.',
      category: 'AI/ML',
      budget: 8000000,
      deadline: endOfKstDay(inWeek(3, 0, 0)),
      requiredSkills: ['Python', 'PyTorch', 'SQL', 'FastAPI'],
      status: 'CLOSED',
      clientId: client1.id,
      createdAt: inWeek(4, 0, 10),
    },
  });

  // 오래전에 완료된 프로젝트 (종료된 대화방을 확인할 수 있다)
  const project12 = await prisma.project.create({
    data: {
      title: '사내 위키 검색 기능 개선',
      description:
        '사내 위키의 검색이 느리고 정확도가 낮습니다. 검색 인덱스를 재설계하고 자동완성과 오타 보정을 넣어 검색 경험을 개선합니다.',
      category: '웹 개발',
      budget: 3000000,
      deadline: endOfKstDay(inWeek(8, 4, 0)),
      requiredSkills: ['React', 'Node.js', 'SQL'],
      status: 'COMPLETED',
      clientId: client1.id,
      createdAt: inWeek(8, 0, 10),
    },
  });

  // 추천을 확인할 수 있는 모집 중 프로젝트 (지원자 없음)
  const project13 = await prisma.project.create({
    data: {
      title: '학습 데이터 분석 대시보드 구축',
      description:
        '수강생의 학습 로그를 분석해 이탈 위험 학생을 찾아내는 대시보드입니다. 데이터 파이프라인 구성, 주요 지표 정의, 시각화 화면 개발이 필요합니다.',
      category: '데이터 분석',
      budget: 9000000,
      deadline: endOfKstDay(later(20 * DAY)),
      requiredSkills: ['Python', 'SQL', 'Pandas', 'React'],
      status: 'OPEN',
      clientId: client3.id,
      createdAt: ago(2 * DAY),
    },
  });

  const project14 = await prisma.project.create({
    data: {
      title: '이벤트 응모 모바일 앱 개발',
      description:
        '브랜드 이벤트 응모와 당첨자 발표를 처리하는 모바일 앱입니다. 푸시 알림, 소셜 로그인, 응모 내역 조회 기능이 필요합니다.',
      category: '모바일 앱',
      budget: 5500000,
      deadline: endOfKstDay(later(15 * DAY)),
      requiredSkills: ['React Native', 'Firebase', 'TypeScript'],
      status: 'OPEN',
      clientId: client2.id,
      createdAt: ago(3 * DAY),
    },
  });

  const project15 = await prisma.project.create({
    data: {
      title: 'B2B SaaS 관리자 웹 고도화',
      description:
        '고객사 관리, 권한 관리, 사용량 리포트 화면을 갖춘 B2B SaaS 관리자 웹을 고도화합니다. 기존 Express API에 엔드포인트를 추가하고 React 화면을 리팩터링합니다.',
      category: '웹 개발',
      budget: 11000000,
      deadline: endOfKstDay(later(28 * DAY)),
      requiredSkills: ['React', 'TypeScript', 'Node.js', 'SQL'],
      status: 'OPEN',
      clientId: client1.id,
      createdAt: ago(1 * DAY + 3 * HOUR),
    },
  });

  // 의뢰인이 직접 취소한 프로젝트
  await prisma.project.create({
    data: {
      title: '영어 회화 튜터 앱 기획',
      description: 'AI 튜터와 영어 회화를 연습하는 앱의 기획과 프로토타입 제작입니다. 내부 일정 변경으로 모집을 취소했습니다.',
      category: '기획',
      budget: 2000000,
      deadline: endOfKstDay(later(10 * DAY)),
      requiredSkills: ['Figma', 'Product Planning'],
      status: 'CANCELLED',
      clientId: client3.id,
      createdAt: ago(15 * DAY),
    },
  });

  console.log('Projects created');

  // ─── Applications (모집 중 프로젝트) ─────────────────
  // project1 (AI 챗봇) - 3명 지원
  const app1Park = await prisma.application.create({
    data: {
      projectId: project1.id,
      freelancerId: freelancer1.id,
      coverLetter:
        'React와 Node.js 기반 웹 서비스에 OpenAI API를 연동한 경험이 있습니다. 이전에 진행한 고객 상담 자동화 프로젝트에서 GPT-4를 활용하여 응답 정확도 85% 이상을 달성한 바 있습니다.',
      expectedRate: 7500000,
      expectedDuration: '6주',
      createdAt: ago(5 * DAY),
    },
  });

  const app1Song = await prisma.application.create({
    data: {
      projectId: project1.id,
      freelancerId: freelancer5.id,
      coverLetter:
        'AI/ML 분야 전문 엔지니어입니다. Python 기반으로 다양한 NLP 프로젝트를 수행했으며, 챗봇 개발 및 배포 경험이 풍부합니다. RAG 패턴을 적용한 고품질 챗봇을 만들어 드리겠습니다.',
      expectedRate: 8000000,
      expectedDuration: '5주',
      createdAt: ago(4 * DAY + 5 * HOUR),
    },
  });

  const app1Han = await prisma.application.create({
    data: {
      projectId: project1.id,
      freelancerId: freelancer3.id,
      coverLetter:
        '백엔드 시스템과 API 설계에 강점이 있습니다. 대화형 AI 시스템의 서버 아키텍처를 설계하고, 안정적인 서비스 운영 환경을 구축해 드리겠습니다.',
      expectedRate: 8500000,
      expectedDuration: '7주',
      createdAt: ago(20 * HOUR),
    },
  });

  // project2 (홈페이지 리뉴얼) - 2명 지원
  const app2Jung = await prisma.application.create({
    data: {
      projectId: project2.id,
      freelancerId: freelancer2.id,
      coverLetter:
        'UI/UX 디자인과 Next.js 프론트엔드를 모두 작업할 수 있습니다. 반응형 웹사이트를 여러 차례 제작했으며, Lighthouse 성능 점수 95 이상을 달성한 경험이 있습니다.',
      expectedRate: 4500000,
      expectedDuration: '4주',
      createdAt: ago(3 * DAY),
    },
  });

  const app2Park = await prisma.application.create({
    data: {
      projectId: project2.id,
      freelancerId: freelancer1.id,
      coverLetter:
        'Next.js App Router를 활용한 SSR/SSG 웹사이트 구축 경험이 풍부합니다. 다국어 처리는 next-intl을 활용하여 효율적으로 구현할 수 있습니다.',
      expectedRate: 5000000,
      expectedDuration: '5주',
      createdAt: ago(2 * DAY),
    },
  });

  // project3 (LMS) - 2명 지원
  const app3Park = await prisma.application.create({
    data: {
      projectId: project3.id,
      freelancerId: freelancer1.id,
      coverLetter:
        'LMS와 유사한 SaaS 플랫폼을 개발한 경험이 있습니다. 영상 스트리밍에는 AWS MediaConvert + CloudFront 조합을 제안드립니다.',
      expectedRate: 14000000,
      expectedDuration: '10주',
      createdAt: ago(8 * DAY),
    },
  });

  const app3Han = await prisma.application.create({
    data: {
      projectId: project3.id,
      freelancerId: freelancer3.id,
      coverLetter:
        '대규모 트래픽을 처리하는 백엔드 아키텍처 설계에 자신 있습니다. 영상 인코딩 파이프라인과 CDN 설정까지 포함하여 안정적인 서비스를 만들어 드리겠습니다.',
      expectedRate: 15000000,
      expectedDuration: '12주',
      createdAt: ago(6 * DAY),
    },
  });

  // project5 (대시보드) - 1명 지원
  const app5Song = await prisma.application.create({
    data: {
      projectId: project5.id,
      freelancerId: freelancer5.id,
      coverLetter:
        'Python + FastAPI로 데이터 수집 파이프라인을 구축하고, React 기반 실시간 대시보드를 개발해본 경험이 있습니다. 소셜 미디어 API 연동도 다수 진행했습니다.',
      expectedRate: 6500000,
      expectedDuration: '6주',
      createdAt: ago(10 * DAY),
    },
  });

  // project6 (마감) - 마감 때 지연 스윕이 대기 중 지원을 거절했다
  await prisma.application.create({
    data: {
      projectId: project6.id,
      freelancerId: freelancer2.id,
      coverLetter: 'BI 작업과 브랜드 가이드라인 문서화 경험이 있습니다. 로고부터 패키지까지 일관된 톤으로 작업하겠습니다.',
      expectedRate: 2800000,
      expectedDuration: '3주',
      status: 'REJECTED',
      createdAt: ago(25 * DAY),
    },
  });

  console.log('Applications created');

  // ─── Payout accounts ───────────────────────────────
  // 정하은·윤서아는 계좌가 없다. 정하은의 정산이 보류(ON_HOLD)된 이유다.
  // Account numbers are stored encrypted with the target environment's key, as the server stores them
  // (src/lib/payoutAccountCrypto.ts). `account.accountNumber` below stays the plain number for the masks.
  const payoutAccount = async (user, bankCode, accountNumber, holderName, createdAt) => {
    const row = await prisma.payoutAccount.create({
      data: {
        userId: user.id,
        bankCode,
        accountNumber: encryptAccountNumber(accountNumber, user.id, process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY),
        holderName,
        createdAt,
      },
    });
    return { ...row, accountNumber };
  };
  const accountHan = await payoutAccount(freelancer3, '004', '94820201234567', '한도윤', inWeek(6, 2, 20));
  const accountPark = await payoutAccount(freelancer1, '090', '3333012345678', '박지윤', inWeek(9, 0, 21));
  const accountSong = await payoutAccount(freelancer5, '088', '110123456789', '송민재', inWeek(3, 1, 22));

  // ─── project12: 오래전 완료 계약 (김서준 ↔ 박지윤) ────
  // Both milestones approved in week 5, settled together (one settlement, two items) and paid.
  const app12 = await prisma.application.create({
    data: {
      projectId: project12.id,
      freelancerId: freelancer1.id,
      coverLetter: '사내 검색 시스템을 Postgres 전문 검색으로 개선한 경험이 있습니다. 인덱스 재설계부터 자동완성 UI까지 맡겠습니다.',
      expectedRate: 2800000,
      expectedDuration: '3주',
      status: 'ACCEPTED',
      createdAt: inWeek(8, 1, 11),
    },
  });
  await prisma.application.create({
    data: {
      projectId: project12.id,
      freelancerId: freelancer3.id,
      coverLetter: 'Elasticsearch 기반 검색 서버 구축 경험이 있습니다.',
      expectedRate: 3200000,
      expectedDuration: '4주',
      status: 'REJECTED',
      createdAt: inWeek(8, 2, 9),
    },
  });
  const accept12 = inWeek(8, 3, 10);
  let contract12 = await createContract({ project: project12, application: app12, client: client1, freelancer: freelancer1, acceptedAt: accept12 });
  let [m12a, m12b] = await createPlan(contract12, [
    { title: '검색 인덱스·API 개선', description: '전문 검색 인덱스 재설계, 검색 API 응답 속도 개선', amount: 1120000, dueDate: endOfKstDay(inWeek(6, 4, 0)) },
    { title: '검색 UI·배포', description: '자동완성, 오타 보정, 검색 결과 하이라이트, 운영 배포', amount: 1680000, dueDate: endOfKstDay(inWeek(5, 4, 0)) },
  ], inWeek(8, 3, 11));
  contract12 = await signContract(contract12, { freelancerSignedAt: inWeek(8, 3, 15), clientSignedAt: inWeek(8, 4, 9) });
  m12a = await fund(contract12, m12a, inWeek(8, 4, 10));
  let s12a = await submit(m12a, { round: 1, at: inWeek(6, 3, 10), message: '검색 인덱스를 재구성하고 검색 API 평균 응답을 1.8초에서 120ms로 줄였습니다. 성능 측정 결과를 첨부합니다.', links: ['https://github.com/jiyun-dev/wiki-search/pull/12'] });
  const a12a = await approve(contract12, s12a.milestone, s12a.submission, { at: inWeek(5, 0, 10), by: client1 });
  m12b = await fund(contract12, m12b, inWeek(5, 0, 11));
  const s12b = await submit(m12b, { round: 1, at: inWeek(5, 3, 15), message: '자동완성과 오타 보정을 적용해 운영에 배포했습니다. 배포 노트를 확인해주세요.', links: ['https://wiki.nextlab.io/search', 'https://github.com/jiyun-dev/wiki-search/releases/tag/v1.0.0'] });
  const completed12 = inWeek(5, 4, 10);
  const a12b = await approve(contract12, s12b.milestone, s12b.submission, { at: completed12, by: client1 });
  contract12 = await prisma.contract.update({ where: { id: contract12.id }, data: { status: 'COMPLETED', completedAt: completed12 } });
  const settlementPark5 = await createSettlement(freelancer1, 5, [a12a.item, a12b.item], {
    status: 'PAID',
    payoutAttempts: 1,
    ...accountSnapshot(accountPark),
    providerReference: `log_${uuidv4()}`,
    paidAt: plus(plus(weekStart(4), PAYOUT_DELAY), 2 * MINUTE),
  });
  await prisma.review.create({
    data: {
      contractId: contract12.id,
      reviewerId: client1.id,
      revieweeId: freelancer1.id,
      rating: 5,
      content: '검색 속도가 체감될 만큼 빨라졌고, 진행 상황을 매번 꼼꼼하게 공유해 주셨습니다. 다음 프로젝트도 함께하고 싶습니다.',
      tags: ['기술력', '소통', '일정 준수'],
      createdAt: inWeek(5, 4, 15),
    },
  });
  await prisma.review.create({
    data: {
      contractId: contract12.id,
      reviewerId: freelancer1.id,
      revieweeId: client1.id,
      rating: 5,
      content: '요구사항 정리가 잘 되어 있었고 검수도 빨랐습니다. 덕분에 일정 안에 마무리할 수 있었습니다.',
      tags: ['명확한 요구사항', '신속한 피드백'],
      createdAt: inWeek(5, 5, 10),
    },
  });
  // Completed more than 30 days ago: the conversation is closed.
  await seedConversation(contract12, [
    { system: 'CONTRACT_CREATED', at: accept12 },
    { key: 'kim1', from: client1, at: plus(accept12, 20 * MINUTE), body: '박지윤님, 사내 위키 검색이 너무 느려서 직원들 불만이 많습니다. 인덱스 개선과 화면 개선 두 단계로 진행하시죠.' },
    { system: 'MILESTONE_PLAN_UPDATED', at: inWeek(8, 3, 11) },
    { key: 'park1', from: freelancer1, at: inWeek(8, 3, 14), body: '계획 확인했습니다. 서명 진행할게요. 검색 로그를 미리 받아볼 수 있을까요?' },
    { system: 'CONTRACT_ACTIVATED', at: inWeek(8, 4, 9) },
    { system: 'MILESTONE_FUNDED', vars: { milestoneTitle: m12a.title }, at: inWeek(8, 4, 10) },
    { system: 'MILESTONE_SUBMITTED', vars: { milestoneTitle: m12a.title, round: 1 }, at: inWeek(6, 3, 10) },
    { system: 'MILESTONE_APPROVED', vars: { milestoneTitle: m12a.title }, at: inWeek(5, 0, 10) },
    { system: 'MILESTONE_FUNDED', vars: { milestoneTitle: m12b.title }, at: inWeek(5, 0, 11) },
    { system: 'MILESTONE_SUBMITTED', vars: { milestoneTitle: m12b.title, round: 1 }, at: inWeek(5, 3, 15) },
    { system: 'MILESTONE_APPROVED', vars: { milestoneTitle: m12b.title }, at: completed12 },
    { system: 'CONTRACT_COMPLETED', at: completed12 },
    { key: 'kim2', from: client1, at: inWeek(5, 4, 11), body: '검색 속도가 확실히 빨라졌어요. 수고 많으셨습니다!' },
    { key: 'park2', from: freelancer1, at: inWeek(5, 4, 13), body: '감사합니다! 운영하면서 불편한 점 있으면 언제든 말씀 주세요.' },
  ], { [client1.id]: 'park2', [freelancer1.id]: 'kim2' });

  // ─── project7: 최근 완료된 계약 (이수현 ↔ 한도윤) ──────
  // 설계(week 3, 지급 완료) / 개발(week 1, 지급 예정) / 배포(이번 주, 미정산).
  const app7 = await prisma.application.create({
    data: {
      projectId: project7.id,
      freelancerId: freelancer3.id,
      coverLetter: 'ERP 시스템 API 개발 경험이 풍부합니다. Spring Boot와 Node.js 모두 가능하며, 확장 가능한 아키텍처를 설계해 드리겠습니다.',
      expectedRate: 9500000,
      expectedDuration: '8주',
      status: 'ACCEPTED',
      createdAt: inWeek(6, 1, 9),
    },
  });
  const accept7 = inWeek(6, 4, 15);
  let contract7 = await createContract({ project: project7, application: app7, client: client2, freelancer: freelancer3, acceptedAt: accept7 });
  let [m7a, m7b, m7c] = await createPlan(contract7, [
    { title: '설계', description: 'ERD, API 명세(Swagger), 권한 모델 설계', amount: 2850000, dueDate: endOfKstDay(inWeek(3, 2, 0)) },
    { title: '개발', description: '인사·프로젝트·비용 처리 모듈 API 구현과 테스트', amount: 4750000, dueDate: endOfKstDay(inWeek(1, 3, 0)) },
    { title: '배포', description: '운영 서버 배포, 모니터링 설정, 운영 가이드', amount: 1900000, dueDate: endOfKstDay(later(3 * DAY)) },
  ], inWeek(6, 4, 16, 30));
  const signed7 = inWeek(5, 0, 14);
  contract7 = await signContract(contract7, { clientSignedAt: inWeek(5, 0, 11), freelancerSignedAt: signed7 });
  m7a = await fund(contract7, m7a, inWeek(5, 0, 15));
  const s7a = await submit(m7a, { round: 1, at: inWeek(3, 0, 10), message: 'ERD와 API 명세서를 올립니다. 비용 처리는 팀장 → 재무 2단계 승인으로 설계했습니다.', links: ['https://github.com/handoyun/erp-api/blob/main/docs/erd.md', 'https://erp-api-docs.bridgemkt.co.kr/swagger'] });
  const a7a = await approve(contract7, s7a.milestone, s7a.submission, { at: inWeek(3, 1, 15), by: client2 });
  m7b = await fund(contract7, m7b, inWeek(3, 1, 16));
  const s7b = await submit(m7b, { round: 1, at: inWeek(1, 1, 10), message: '세 모듈 API 구현을 마쳤습니다. 통합 테스트 커버리지 87%이고, 스테이징에 배포해 두었습니다.', links: ['https://github.com/handoyun/erp-api/pull/58', 'https://staging-erp.bridgemkt.co.kr'] });
  const a7b = await approve(contract7, s7b.milestone, s7b.submission, { at: inWeek(1, 2, 17), by: client2 });
  m7c = await fund(contract7, m7c, inWeek(1, 2, 18));
  const s7c = await submit(m7c, {
    round: 1,
    at: recent(0.2),
    message: '운영 서버 배포를 마쳤습니다. 배포 가이드와 Grafana 대시보드 화면을 첨부합니다.',
    links: ['https://github.com/handoyun/erp-api/blob/main/docs/deploy.md'],
    attachments: [{ url: placeholder('ERP Grafana Dashboard', '0f766e'), fileName: '운영_모니터링_대시보드.png', mimeType: 'image/png', size: 248331 }],
  });
  const completed7 = recent(0.4);
  const a7c = await approve(contract7, s7c.milestone, s7c.submission, { at: completed7, by: client2 });
  contract7 = await prisma.contract.update({ where: { id: contract7.id }, data: { status: 'COMPLETED', completedAt: completed7 } });

  const settlementHan3 = await createSettlement(freelancer3, 3, [a7a.item], {
    status: 'PAID',
    payoutAttempts: 1,
    ...accountSnapshot(accountHan),
    providerReference: `log_${uuidv4()}`,
    paidAt: plus(plus(weekStart(2), PAYOUT_DELAY), 2 * MINUTE),
  });
  // Week 1's payout is this Wednesday 10:00. Seeded after it, the settlement would already be
  // paid, so it is shown as if rescheduled to the next Wednesday — the sample data keeps one SCHEDULED.
  const naturalPayout7 = plus(settledUntil, PAYOUT_DELAY);
  const payout7 = naturalPayout7 > now ? naturalPayout7 : nextWednesday10(now);
  const settlementHan1 = await createSettlement(freelancer3, 1, [a7b.item], { status: 'SCHEDULED', scheduledPayoutAt: payout7 });
  await jobRow('settlement.payout', { settlementId: settlementHan1.id, scheduledPayoutAt: payout7.toISOString() }, payout7, `settlement.payout:${settlementHan1.id}:${payout7.toISOString()}`);

  // 의뢰인 → 프리랜서 리뷰
  await prisma.review.create({
    data: {
      contractId: contract7.id,
      reviewerId: client2.id,
      revieweeId: freelancer3.id,
      rating: 5,
      content: '기술력이 뛰어나고 커뮤니케이션도 매우 원활했습니다. 일정 내에 완벽하게 납품해 주셨습니다. 다음에도 꼭 함께 일하고 싶습니다.',
      tags: ['기술력', '소통', '책임감', '일정 준수'],
      createdAt: recent(0.6),
    },
  });

  // 프리랜서 → 의뢰인 리뷰
  await prisma.review.create({
    data: {
      contractId: contract7.id,
      reviewerId: freelancer3.id,
      revieweeId: client2.id,
      rating: 4,
      content: '요구사항이 명확하고 피드백도 빠르게 주셔서 작업하기 좋았습니다. 중간에 소소한 스코프 변경이 있었지만 전반적으로 만족스러운 협업이었습니다.',
      tags: ['명확한 요구사항', '신속한 피드백'],
      createdAt: recent(0.7),
    },
  });

  await seedConversation(contract7, [
    { system: 'CONTRACT_CREATED', at: accept7 },
    { from: client2, at: inWeek(6, 4, 15, 20), body: '한도윤님, 지원 감사합니다. 인사·프로젝트·비용 세 모듈을 단계별로 나눠서 진행하면 좋겠습니다.' },
    { key: 'han1', from: freelancer3, at: inWeek(6, 4, 15, 45), body: '네, 설계 → 개발 → 배포 3단계로 제안드립니다. 금액은 30 / 50 / 20 비율이면 어떨까요?' },
    { system: 'MILESTONE_PLAN_UPDATED', at: inWeek(6, 4, 16, 30) },
    { system: 'CONTRACT_ACTIVATED', at: signed7 },
    { system: 'MILESTONE_FUNDED', vars: { milestoneTitle: m7a.title }, at: inWeek(5, 0, 15) },
    { system: 'MILESTONE_SUBMITTED', vars: { milestoneTitle: m7a.title, round: 1 }, at: inWeek(3, 0, 10) },
    { from: freelancer3, at: inWeek(3, 0, 10, 3), body: 'ERD와 Swagger 문서 올렸습니다. 비용 처리 승인 단계는 회의 때 말씀하신 대로 2단계로 넣었습니다.' },
    { system: 'MILESTONE_APPROVED', vars: { milestoneTitle: m7a.title }, at: inWeek(3, 1, 15) },
    { system: 'MILESTONE_FUNDED', vars: { milestoneTitle: m7b.title }, at: inWeek(3, 1, 16) },
    { system: 'MILESTONE_SUBMITTED', vars: { milestoneTitle: m7b.title, round: 1 }, at: inWeek(1, 1, 10) },
    { system: 'MILESTONE_APPROVED', vars: { milestoneTitle: m7b.title }, at: inWeek(1, 2, 17) },
    { system: 'MILESTONE_FUNDED', vars: { milestoneTitle: m7c.title }, at: inWeek(1, 2, 18) },
    { system: 'MILESTONE_SUBMITTED', vars: { milestoneTitle: m7c.title, round: 1 }, at: recent(0.2) },
    { system: 'MILESTONE_APPROVED', vars: { milestoneTitle: m7c.title }, at: completed7 },
    { system: 'CONTRACT_COMPLETED', at: completed7 },
    { key: 'lee2', from: client2, at: recent(0.5), body: '덕분에 일정 안에 잘 마무리됐습니다. 다음 분기 고도화 때도 연락드릴게요!' },
    { key: 'han2', from: freelancer3, at: recent(0.55), body: '감사합니다. 운영하면서 이슈 생기면 편하게 말씀 주세요.' },
  ], { [client2.id]: 'han2', [freelancer3.id]: 'lee2' });

  console.log('Completed contracts created');

  // ─── project8: 진행 중 (최민호 ↔ 박지윤) ──────────────
  // #1 승인(지급 완료) / #2 2차 제출 검수 대기(1차 수정 요청) / #3 결제 대기.
  const app8 = await prisma.application.create({
    data: {
      projectId: project8.id,
      freelancerId: freelancer1.id,
      coverLetter: 'React + TypeScript 기반 관리자 페이지를 다수 개발한 경험이 있습니다. Prisma와 함께 사용하면 빠르게 고품질 결과물을 만들 수 있습니다.',
      expectedRate: 5500000,
      expectedDuration: '6주',
      status: 'ACCEPTED',
      createdAt: inWeek(5, 2, 14),
    },
  });

  // 거절된 지원자
  await prisma.application.create({
    data: {
      projectId: project8.id,
      freelancerId: freelancer2.id,
      coverLetter: '프론트엔드 전문으로 관리자 대시보드 개발 경험이 있습니다.',
      expectedRate: 5000000,
      expectedDuration: '5주',
      status: 'REJECTED',
      createdAt: inWeek(5, 3, 9),
    },
  });

  const accept8 = inWeek(4, 0, 10);
  let contract8 = await createContract({ project: project8, application: app8, client: client3, freelancer: freelancer1, acceptedAt: accept8 });
  let [m8a, m8b, m8c] = await createPlan(contract8, [
    { title: '기획·화면 설계', description: '요구사항 정리, IA, 주요 화면 와이어프레임', amount: 1650000, dueDate: endOfKstDay(inWeek(2, 2, 0)) },
    { title: '관리자 기능 개발', description: '상품·주문·회원 관리와 매출 통계 화면 구현', amount: 2750000, dueDate: endOfKstDay(later(5 * DAY)) },
    { title: '배포·QA', description: '운영 배포, QA 이슈 대응, 운영 매뉴얼', amount: 1100000, dueDate: endOfKstDay(later(19 * DAY)) },
  ], inWeek(4, 0, 13));
  const signed8 = inWeek(4, 1, 9);
  contract8 = await signContract(contract8, { clientSignedAt: inWeek(4, 0, 14), freelancerSignedAt: signed8 });
  m8a = await fund(contract8, m8a, inWeek(4, 1, 10));
  const s8a = await submit(m8a, {
    round: 1,
    at: inWeek(2, 0, 10),
    message: '화면 설계서와 IA 문서를 제출합니다. 주문 관리 화면은 필터를 상단 고정으로 바꿨습니다.',
    links: ['https://www.figma.com/file/ecommerce-admin-wireframe'],
    attachments: [{ url: placeholder('Admin Wireframe v1', '7c3aed'), fileName: '관리자_화면설계서_v1.png', mimeType: 'image/png', size: 412907 }],
  });
  const a8a = await approve(contract8, s8a.milestone, s8a.submission, { at: inWeek(2, 1, 14), by: client3 });
  m8b = await fund(contract8, m8b, inWeek(2, 1, 15));
  const r1At = inWeek(1, 2, 11);
  let s8b = await submit(m8b, { round: 1, at: r1At, message: '상품·주문·회원 관리와 매출 통계 화면을 구현했습니다. 스테이징에서 확인 부탁드립니다.', links: ['https://ecommerce-admin-staging.vercel.app'] });
  const rejected8At = inWeek(1, 3, 16);
  const reason8 = '주문 관리 화면의 기간 필터가 동작하지 않고, 매출 통계의 월별 합계가 엑셀 원본과 다릅니다. 두 가지 수정 후 다시 제출 부탁드립니다.';
  m8b = await requestRevision(s8b.milestone, s8b.submission, { at: rejected8At, by: client3, reason: reason8 });
  const r2At = new Date(Math.max(ago(4 * DAY).getTime(), plus(rejected8At, 20 * HOUR).getTime()));
  s8b = await submit(m8b, {
    round: 2,
    at: r2At,
    message: '기간 필터를 주문일 기준으로 고치고, 월별 합계를 환불 건을 뺀 순매출 기준으로 맞췄습니다. 엑셀 원본과 대조한 결과를 첨부합니다.',
    links: ['https://github.com/jiyun-dev/ecommerce-admin/pull/42', 'https://ecommerce-admin-staging.vercel.app/orders'],
    attachments: [{ url: placeholder('Sales Report Check', '0369a1'), fileName: '매출통계_대조결과.png', mimeType: 'image/png', size: 183640 }],
  });
  m8b = s8b.milestone;
  // The auto-approval and its reminder for round 2, enqueued by the submission.
  await jobRow('milestone.autoApprove', { milestoneId: m8b.id, round: 2 }, m8b.autoApproveAt, `milestone.autoApprove:${m8b.id}:2`);
  const reminder8 = plus(m8b.autoApproveAt, -48 * HOUR);
  await jobRow('milestone.autoApproveReminder', { milestoneId: m8b.id, round: 2 }, reminder8, `milestone.autoApproveReminder:${m8b.id}:2`);
  // Due-date notices enqueued when it was funded (no-ops while it is SUBMITTED).
  await jobRow('milestone.dueSoon', { milestoneId: m8b.id }, plus(m8b.dueDate, -DAY), `milestone.dueSoon:${m8b.id}`);
  await jobRow('milestone.overdue', { milestoneId: m8b.id }, m8b.dueDate, `milestone.overdue:${m8b.id}`);

  const settlementPark2 = await createSettlement(freelancer1, 2, [a8a.item], {
    status: 'PAID',
    payoutAttempts: 1,
    ...accountSnapshot(accountPark),
    providerReference: `log_${uuidv4()}`,
    paidAt: plus(plus(weekStart(1), PAYOUT_DELAY), 2 * MINUTE),
  });

  // 박지윤의 마지막 두 메시지를 최민호가 아직 읽지 않았다 (안 읽은 메시지 2개).
  const unread8a = ago(2 * HOUR + 20 * MINUTE);
  const unread8b = ago(2 * HOUR + 15 * MINUTE);
  const conv8 = await seedConversation(contract8, [
    { system: 'CONTRACT_CREATED', at: accept8 },
    { key: 'choi1', from: client3, at: plus(accept8, 1 * HOUR), body: '안녕하세요 박지윤님, 최민호입니다. 계약 전에 마일스톤을 기획·설계 / 기능 개발 / 배포·QA 세 단계로 나누고 싶은데 괜찮으실까요?' },
    { key: 'park1', from: freelancer1, at: plus(accept8, 2 * HOUR), body: '네 좋습니다. 금액은 30% / 50% / 20% 비율이면 적당할 것 같아요.' },
    { system: 'MILESTONE_PLAN_UPDATED', at: inWeek(4, 0, 13) },
    { system: 'CONTRACT_ACTIVATED', at: signed8 },
    { system: 'MILESTONE_FUNDED', vars: { milestoneTitle: m8a.title }, at: inWeek(4, 1, 10) },
    { system: 'MILESTONE_SUBMITTED', vars: { milestoneTitle: m8a.title, round: 1 }, at: inWeek(2, 0, 10) },
    {
      key: 'park2',
      from: freelancer1,
      at: inWeek(2, 0, 10, 5),
      body: '화면 설계서 올렸습니다. 피그마 링크는 결과물에 같이 넣어두었어요.',
      attachments: [{ url: placeholder('Admin Wireframe v1', '7c3aed'), fileName: '관리자_화면설계서_v1.png', mimeType: 'image/png', size: 412907 }],
    },
    { system: 'MILESTONE_APPROVED', vars: { milestoneTitle: m8a.title }, at: inWeek(2, 1, 14) },
    { system: 'MILESTONE_FUNDED', vars: { milestoneTitle: m8b.title }, at: inWeek(2, 1, 15) },
    { system: 'MILESTONE_SUBMITTED', vars: { milestoneTitle: m8b.title, round: 1 }, at: r1At },
    { system: 'MILESTONE_REVISION_REQUESTED', vars: { milestoneTitle: m8b.title, reason: reason8 }, at: rejected8At },
    { key: 'choi2', from: client3, at: plus(rejected8At, 10 * MINUTE), body: '기간 필터는 주문일 기준으로 부탁드려요. 엑셀 원본은 메일로 다시 보내드렸습니다.' },
    { key: 'park3', from: freelancer1, at: plus(rejected8At, 90 * MINUTE), body: '확인했습니다. 수정해서 다시 올릴게요.' },
    { system: 'MILESTONE_SUBMITTED', vars: { milestoneTitle: m8b.title, round: 2 }, at: r2At },
    { key: 'park4', from: freelancer1, at: plus(r2At, 5 * MINUTE), body: '수정본 제출했습니다. 스테이징 주소에서 바로 확인하실 수 있어요.' },
    // Sent by mistake and deleted within 5 minutes: a tombstone.
    { from: freelancer1, at: plus(r2At, 6 * MINUTE), body: 'https://ecommerce-admin-staging.vercel.app/debug', deletedAt: plus(r2At, 7 * MINUTE) },
    { key: 'park5', from: freelancer1, at: unread8a, body: '참고로 매출 통계에 일 단위 캐시를 붙여서 첫 로딩이 2초 안쪽으로 줄었습니다.' },
    { key: 'park6', from: freelancer1, at: unread8b, body: '배포·QA 일정도 미리 맞춰보면 좋을 것 같아요. 다음 주 화요일 오후 괜찮으실까요?' },
  ], { [client3.id]: 'park4', [freelancer1.id]: 'choi2' });

  // ─── project9: 서명 전 계약 (김서준 ↔ 윤서아) ─────────
  const app9 = await prisma.application.create({
    data: {
      projectId: project9.id,
      freelancerId: freelancer4.id,
      coverLetter: 'React Native와 Firebase로 행사용 체크인 앱을 만든 경험이 있습니다. 오프라인 체크인 후 자동 동기화까지 구현해 드리겠습니다.',
      expectedRate: 5800000,
      expectedDuration: '6주',
      status: 'ACCEPTED',
      createdAt: ago(9 * DAY),
    },
  });
  const accept9 = ago(2 * DAY);
  const contract9 = await createContract({ project: project9, application: app9, client: client1, freelancer: freelancer4, acceptedAt: accept9 });
  const plan9At = ago(1 * DAY);
  await createPlan(contract9, [
    { title: '앱 설계·프로토타입', description: '화면 설계, QR 스캔·오프라인 동기화 프로토타입', amount: 2320000, dueDate: endOfKstDay(later(14 * DAY)) },
    { title: '앱 개발·스토어 배포', description: '체크인 앱과 관리자 연동 개발, 앱스토어·플레이스토어 배포', amount: 3480000, dueDate: endOfKstDay(later(35 * DAY)) },
  ], plan9At);
  const conv9 = await seedConversation(contract9, [
    { system: 'CONTRACT_CREATED', at: accept9 },
    { key: 'kim1', from: client1, at: plus(accept9, 30 * MINUTE), body: '윤서아님, 함께하게 되어 반갑습니다. 행사 체크인은 QR 스캔과 참가자 명단 동기화가 핵심입니다.' },
    { key: 'yoon1', from: freelancer4, at: plus(accept9, 3 * HOUR), body: '안녕하세요! 기획 문서 확인했습니다. 행사장 와이파이가 불안정할 수 있으니 오프라인 체크인을 먼저 설계할게요.' },
    { system: 'MILESTONE_PLAN_UPDATED', at: plan9At },
    { key: 'kim2', from: client1, at: plus(plan9At, 10 * MINUTE), body: '마일스톤을 설계·프로토타입 / 개발·스토어 배포 2단계로 나눠 두었습니다. 확인하시고 괜찮으면 서명 부탁드려요.' },
  ], { [client1.id]: 'yoon1', [freelancer4.id]: 'kim1' });

  // ─── project10: 진행 중 (이수현 ↔ 정하은) ─────────────
  // #1 자동 승인(정산 보류: 계좌 없음) / #2 수정 요청 / #3 결제 대기.
  const app10 = await prisma.application.create({
    data: {
      projectId: project10.id,
      freelancerId: freelancer2.id,
      coverLetter: '캠페인 랜딩을 시안부터 퍼블리싱까지 혼자 진행해 왔습니다. 스크롤 인터랙션은 Framer Motion으로 가볍게 구현하겠습니다.',
      expectedRate: 4200000,
      expectedDuration: '5주',
      status: 'ACCEPTED',
      createdAt: inWeek(5, 3, 10),
    },
  });
  const accept10 = inWeek(4, 1, 11);
  let contract10 = await createContract({ project: project10, application: app10, client: client2, freelancer: freelancer2, acceptedAt: accept10 });
  let [m10a, m10b, m10c] = await createPlan(contract10, [
    { title: '디자인 시안', description: '메인·이벤트 응모·완료 화면 시안 2종', amount: 1260000, dueDate: endOfKstDay(inWeek(3, 4, 0)) },
    { title: '퍼블리싱·개발', description: 'Next.js 퍼블리싱, 스크롤 인터랙션, 응모 폼 연동', amount: 2100000, dueDate: endOfKstDay(later(4 * DAY)) },
    { title: 'QA·런칭', description: '크로스 브라우징 QA, 운영 배포', amount: 840000, dueDate: endOfKstDay(later(14 * DAY)) },
  ], inWeek(4, 1, 14));
  const signed10 = inWeek(4, 2, 10);
  contract10 = await signContract(contract10, { freelancerSignedAt: inWeek(4, 1, 15), clientSignedAt: signed10 });
  m10a = await fund(contract10, m10a, inWeek(4, 2, 11));
  const s10a = await submit(m10a, {
    round: 1,
    at: inWeek(3, 3, 10),
    message: '시안 2종을 제출합니다. A안은 브랜드 컬러 중심, B안은 사진 중심입니다.',
    links: ['https://www.figma.com/file/campaign-landing-v1'],
    attachments: [{ url: placeholder('Landing Draft A/B', 'db2777'), fileName: '캠페인_랜딩_시안_AB.png', mimeType: 'image/png', size: 356201 }],
  });
  // Nobody reviewed it for 7 days: approved automatically, a minute after autoApproveAt.
  const autoApproved10 = plus(s10a.milestone.autoApproveAt, 1 * MINUTE);
  const a10a = await approve(contract10, s10a.milestone, s10a.submission, { at: autoApproved10, by: null });
  m10b = await fund(contract10, m10b, inWeek(2, 3, 15));
  const s10b = await submit(m10b, { round: 1, at: inWeek(1, 4, 15), message: 'A안으로 퍼블리싱했습니다. 응모 폼은 스테이징 API에 연결되어 있습니다.', links: ['https://campaign-landing-staging.vercel.app'] });
  const rejected10At = ago(1 * DAY);
  const reason10 = '모바일(375px)에서 히어로 영역 문구가 잘리고, CTA 버튼 색상이 브랜드 가이드(#FF5A36)와 다릅니다. 수정 부탁드립니다.';
  m10b = await requestRevision(s10b.milestone, s10b.submission, { at: rejected10At, by: client2, reason: reason10 });
  await jobRow('milestone.dueSoon', { milestoneId: m10b.id }, plus(m10b.dueDate, -DAY), `milestone.dueSoon:${m10b.id}`);
  await jobRow('milestone.overdue', { milestoneId: m10b.id }, m10b.dueDate, `milestone.overdue:${m10b.id}`);

  // 계좌가 없어 지급일에 보류됐다. 계좌를 등록하면 다음 수요일로 다시 잡힌다.
  const settlementJung2 = await createSettlement(freelancer2, 2, [a10a.item], { status: 'ON_HOLD' });

  const conv10 = await seedConversation(contract10, [
    { system: 'CONTRACT_CREATED', at: accept10 },
    { key: 'lee1', from: client2, at: plus(accept10, 20 * MINUTE), body: '정하은님, 이번 랜딩은 11월 프로모션에 맞춰 오픈해야 합니다. 시안 → 퍼블리싱 → QA 순서로 진행할게요.' },
    { key: 'jung1', from: freelancer2, at: plus(accept10, 2 * HOUR), body: '네! 레퍼런스 사이트 3개 정도 공유해주시면 시안 방향 잡는 데 도움이 될 것 같아요.' },
    { system: 'MILESTONE_PLAN_UPDATED', at: inWeek(4, 1, 14) },
    { system: 'CONTRACT_ACTIVATED', at: signed10 },
    { system: 'MILESTONE_FUNDED', vars: { milestoneTitle: m10a.title }, at: inWeek(4, 2, 11) },
    { system: 'MILESTONE_SUBMITTED', vars: { milestoneTitle: m10a.title, round: 1 }, at: inWeek(3, 3, 10) },
    { system: 'MILESTONE_AUTO_APPROVED', vars: { milestoneTitle: m10a.title }, at: autoApproved10 },
    { system: 'MILESTONE_FUNDED', vars: { milestoneTitle: m10b.title }, at: inWeek(2, 3, 15) },
    { system: 'MILESTONE_SUBMITTED', vars: { milestoneTitle: m10b.title, round: 1 }, at: inWeek(1, 4, 15) },
    { system: 'MILESTONE_REVISION_REQUESTED', vars: { milestoneTitle: m10b.title, reason: reason10 }, at: rejected10At },
    { key: 'lee2', from: client2, at: plus(rejected10At, 5 * MINUTE), body: '브랜드 가이드 PDF 다시 공유드려요. 버튼 색상은 #FF5A36 기준으로 맞춰주세요.' },
  ], { [client2.id]: 'jung1', [freelancer2.id]: 'lee1' });

  // ─── project11: 진행 중 (김서준 ↔ 송민재) ─────────────
  // #1 승인(지급 3회 실패) / #2 결제 완료, 작업 중 / #3 결제 대기.
  const app11 = await prisma.application.create({
    data: {
      projectId: project11.id,
      freelancerId: freelancer5.id,
      coverLetter: '커머스 추천 모델을 세션 기반 딥러닝 모델로 전환해 CTR을 개선한 경험이 있습니다. 오프라인 지표와 A/B 테스트 설계까지 함께하겠습니다.',
      expectedRate: 7000000,
      expectedDuration: '8주',
      status: 'ACCEPTED',
      createdAt: inWeek(4, 1, 10),
    },
  });
  const accept11 = inWeek(3, 0, 10);
  let contract11 = await createContract({ project: project11, application: app11, client: client1, freelancer: freelancer5, acceptedAt: accept11 });
  let [m11a, m11b] = await createPlan(contract11, [
    { title: '데이터 분석·베이스라인', description: '행동 로그 EDA, 오프라인 평가 지표 설계, 베이스라인 측정', amount: 2100000, dueDate: endOfKstDay(inWeek(2, 2, 0)) },
    { title: '추천 모델 개발', description: '세션 기반 추천 모델 학습과 오프라인 평가', amount: 3500000, dueDate: endOfKstDay(later(6 * DAY)) },
    { title: 'API 연동·리포트', description: '추천 API 서빙, A/B 테스트 설계와 결과 리포트', amount: 1400000, dueDate: endOfKstDay(later(20 * DAY)) },
  ], inWeek(3, 0, 11));
  const signed11 = inWeek(3, 0, 17);
  contract11 = await signContract(contract11, { freelancerSignedAt: inWeek(3, 0, 14), clientSignedAt: signed11 });
  m11a = await fund(contract11, m11a, inWeek(3, 1, 10));
  const s11a = await submit(m11a, { round: 1, at: inWeek(2, 0, 15), message: 'EDA 리포트와 베이스라인 측정 결과(CTR 3.1%, Recall@20 0.18)를 제출합니다.', links: ['https://github.com/minjae-ml/reco-baseline'] });
  const a11a = await approve(contract11, s11a.milestone, s11a.submission, { at: inWeek(2, 1, 11), by: client1 });
  m11b = await fund(contract11, m11b, inWeek(2, 1, 12));
  await jobRow('milestone.dueSoon', { milestoneId: m11b.id }, plus(m11b.dueDate, -DAY), `milestone.dueSoon:${m11b.id}`);
  await jobRow('milestone.overdue', { milestoneId: m11b.id }, m11b.dueDate, `milestone.overdue:${m11b.id}`);

  // 지급을 세 번 시도해 모두 실패했다: 수요일, 목요일, 금요일 10:00. 운영자 확인 대상.
  const firstPayout11 = plus(plus(weekStart(2), 7 * DAY), PAYOUT_DELAY);
  const lastPayout11 = plus(firstPayout11, 2 * PAYOUT_RETRY);
  const settlementSong2 = await createSettlement(freelancer5, 2, [a11a.item], {
    status: 'FAILED',
    scheduledPayoutAt: lastPayout11,
    payoutAttempts: 3,
    ...accountSnapshot(accountSong),
    failureReason: '수취 은행 응답 시간 초과로 이체가 처리되지 않았습니다.',
  });

  const conv11 = await seedConversation(contract11, [
    { system: 'CONTRACT_CREATED', at: accept11 },
    { key: 'kim1', from: client1, at: plus(accept11, 15 * MINUTE), body: '송민재님, 지금 추천은 협업 필터링 기반입니다. 행동 로그는 BigQuery 데이터셋으로 공유드릴게요.' },
    { system: 'MILESTONE_PLAN_UPDATED', at: inWeek(3, 0, 11) },
    { key: 'song1', from: freelancer5, at: inWeek(3, 0, 13), body: '확인했습니다. 첫 단계에서 데이터 분석과 베이스라인 지표를 정리하겠습니다.' },
    { system: 'CONTRACT_ACTIVATED', at: signed11 },
    { system: 'MILESTONE_FUNDED', vars: { milestoneTitle: m11a.title }, at: inWeek(3, 1, 10) },
    { system: 'MILESTONE_SUBMITTED', vars: { milestoneTitle: m11a.title, round: 1 }, at: inWeek(2, 0, 15) },
    { key: 'song2', from: freelancer5, at: inWeek(2, 0, 15, 5), body: 'EDA 리포트 올렸습니다. 재구매 고객의 세션 길이가 짧아서 최근 행동 가중치를 높이는 쪽을 제안드립니다.' },
    { system: 'MILESTONE_APPROVED', vars: { milestoneTitle: m11a.title }, at: inWeek(2, 1, 11) },
    { system: 'MILESTONE_FUNDED', vars: { milestoneTitle: m11b.title }, at: inWeek(2, 1, 12) },
    { key: 'song3', from: freelancer5, at: ago(5 * HOUR), body: '새 모델 오프라인 평가에서 CTR이 베이스라인 대비 12% 올랐습니다. 다음 주에 중간 결과 공유드릴게요.' },
  ], { [client1.id]: 'song2', [freelancer5.id]: 'kim1' });

  console.log('Active and pending contracts created');

  // Every contract has exactly one conversation.
  check((await prisma.contract.count({ where: { conversation: null } })) === 0, 'every contract has a conversation');

  // ─── Bookmarks ───────────────────────────────────────
  await prisma.projectBookmark.createMany({
    data: [
      { projectId: project15.id, userId: freelancer1.id, createdAt: ago(20 * HOUR) },
      { projectId: project13.id, userId: freelancer1.id, createdAt: ago(30 * HOUR) },
      { projectId: project14.id, userId: freelancer4.id, createdAt: ago(2 * DAY) },
      { projectId: project13.id, userId: freelancer5.id, createdAt: ago(1 * DAY) },
    ],
  });

  // ─── Portfolio and careers ───────────────────────────
  // Skills are stored normalized (no PostgreSQL/MySQL aliases). Months are KST month starts.
  const portfolio = [
    [freelancer1, [
      { title: '패션 쇼핑몰 관리자 대시보드', description: '상품·재고·주문 관리와 매출 리포트를 갖춘 관리자 웹. 대량 상품 일괄 수정 기능으로 운영 시간을 절반으로 줄였습니다.', url: 'https://github.com/jiyun-dev/fashion-admin', imageUrl: placeholder('Fashion Admin Dashboard', '1d4ed8'), role: '풀스택 개발', skills: ['React', 'TypeScript', 'Node.js', 'SQL'], startedAt: '2025-03', endedAt: '2025-06' },
      { title: '공유 오피스 좌석 예약 서비스', description: '좌석 지도에서 실시간으로 예약하는 웹 서비스. 결제와 출입 QR까지 연동했습니다.', url: 'https://desk-booking-demo.vercel.app', imageUrl: placeholder('Desk Booking', '0891b2'), role: '프론트엔드 리드', skills: ['Next.js', 'Node.js', 'AWS'], startedAt: '2024-08', endedAt: '2024-12' },
      { title: 'B2B 정산 리포트 자동화', description: '매월 수작업으로 만들던 거래처 정산 리포트를 자동 생성하는 배치와 화면.', role: '백엔드 개발', skills: ['Node.js', 'SQL', 'AWS'], startedAt: '2024-02', endedAt: '2024-05' },
      { title: '개발 블로그 플랫폼', description: 'MDX 기반 개인 블로그. 정적 생성과 검색 인덱스를 직접 구현했습니다.', url: 'https://jiyun-dev.vercel.app', role: '1인 개발', skills: ['Next.js', 'TypeScript'], startedAt: '2023-10', endedAt: '2023-12' },
    ]],
    [freelancer2, [
      { title: '뷰티 브랜드 리뉴얼 랜딩', description: '신제품 런칭 랜딩 디자인과 퍼블리싱. 스크롤 인터랙션으로 체류 시간이 40% 늘었습니다.', url: 'https://beauty-launch-demo.vercel.app', imageUrl: placeholder('Beauty Launch', 'db2777'), role: '디자인·퍼블리싱', skills: ['Figma', 'Next.js', 'Tailwind CSS', 'Framer Motion'], startedAt: '2025-05', endedAt: '2025-07' },
      { title: '핀테크 앱 디자인 시스템', description: '컬러·타이포·컴포넌트 토큰을 정의하고 React 컴포넌트 라이브러리로 옮겼습니다.', imageUrl: placeholder('Design System', '9333ea'), role: '디자인 시스템 리드', skills: ['Figma', 'React'], startedAt: '2024-09', endedAt: '2025-02' },
      { title: '모바일 커머스 UX 개선', description: '장바구니 이탈 구간 사용성 테스트와 개선안 설계.', role: 'UX 디자인', skills: ['Figma'], startedAt: '2024-03', endedAt: '2024-05' },
    ]],
    [freelancer3, [
      { title: '결제 게이트웨이 연동 API', description: 'PG사 3곳을 하나의 결제 API로 묶고 장애 시 자동 전환하도록 설계했습니다.', url: 'https://github.com/handoyun/payment-gateway', imageUrl: placeholder('Payment Gateway', '15803d'), role: '백엔드 리드', skills: ['Java', 'Spring Boot', 'Redis'], startedAt: '2024-06', endedAt: '2024-11' },
      { title: '티켓 오픈 대기열 서버', description: '초당 2만 요청을 버티는 대기열 서버. Redis 기반 토큰 발급과 오토스케일링을 구성했습니다.', imageUrl: placeholder('Ticket Queue', '4d7c0f'), role: '백엔드 개발', skills: ['Node.js', 'Redis', 'Kubernetes', 'Docker'], startedAt: '2023-03', endedAt: '2023-08' },
      { title: '레거시 모놀리스 MSA 전환', description: '주문·회원 도메인을 분리하고 무중단 배포 파이프라인을 만들었습니다.', role: '아키텍처 설계', skills: ['Spring Boot', 'Docker', 'Kubernetes'], startedAt: '2022-01', endedAt: '2022-10' },
    ]],
    [freelancer4, [
      { title: '헬스 트래커 앱', description: '걸음 수와 운동 기록을 HealthKit·Google Fit과 동기화하는 크로스 플랫폼 앱.', url: 'https://seoa-app.dev/health', imageUrl: placeholder('Health Tracker', 'ea580c'), role: '모바일 개발', skills: ['React Native', 'Firebase', 'HealthKit'], startedAt: '2025-01', endedAt: '2025-05' },
      { title: '동네 중고거래 앱', description: '위치 기반 매물 목록과 1:1 채팅을 갖춘 Flutter 앱.', imageUrl: placeholder('Local Market', 'f59e0b'), role: '1인 개발', skills: ['Flutter', 'Dart', 'Firebase'], startedAt: '2024-04', endedAt: '2024-09' },
    ]],
    [freelancer5, [
      { title: '고객 문의 자동 분류 모델', description: '상담 문의를 12개 유형으로 분류하는 모델과 서빙 API. 상담 배정 시간을 60% 줄였습니다.', url: 'https://github.com/minjae-ml/inquiry-classifier', imageUrl: placeholder('Inquiry Classifier', '4f46e5'), role: 'ML 엔지니어', skills: ['Python', 'PyTorch', 'FastAPI'], startedAt: '2025-02', endedAt: '2025-06' },
      { title: '수요 예측 대시보드', description: '매장별 일 수요 예측과 재고 알림 대시보드.', role: '데이터 분석', skills: ['Python', 'Pandas', 'SQL'], startedAt: '2024-07', endedAt: '2024-10' },
    ]],
  ];
  for (const [user, items] of portfolio) {
    for (const [index, item] of items.entries()) {
      await prisma.portfolioItem.create({
        data: {
          userId: user.id,
          ...item,
          url: item.url || null,
          imageUrl: item.imageUrl || null,
          startedAt: kstMonth(item.startedAt),
          endedAt: kstMonth(item.endedAt),
          sortOrder: index,
        },
      });
    }
  }

  const careers = [
    [freelancer1, [
      { company: '커머스랩', position: '프론트엔드 개발자', employmentType: 'FULL_TIME', startDate: '2019-03', endDate: '2022-02', description: '자사몰 프론트엔드와 관리자 웹 개발' },
      { company: '프리랜서', position: '풀스택 개발자', employmentType: 'FREELANCE', startDate: '2022-03', endDate: null, description: '스타트업 웹 서비스 외주 개발' },
    ]],
    [freelancer2, [
      { company: '스튜디오 오브제', position: 'UI/UX 디자이너', employmentType: 'FULL_TIME', startDate: '2020-01', endDate: '2023-06', description: '브랜드 웹사이트와 앱 UI 디자인' },
      { company: '프리랜서', position: '디자인 엔지니어', employmentType: 'FREELANCE', startDate: '2023-07', endDate: null, description: null },
    ]],
    [freelancer3, [
      { company: '페이플러스', position: '백엔드 개발자', employmentType: 'FULL_TIME', startDate: '2016-01', endDate: '2020-12', description: '결제 API와 정산 시스템 개발' },
      { company: '티켓온', position: '백엔드 리드', employmentType: 'FULL_TIME', startDate: '2021-01', endDate: '2023-12', description: '대기열 서버와 예매 API 설계, 5인 팀 리드' },
      { company: '프리랜서', position: '백엔드 아키텍트', employmentType: 'FREELANCE', startDate: '2024-01', endDate: null, description: null },
    ]],
    [freelancer4, [
      { company: '앱공방', position: '모바일 개발자', employmentType: 'CONTRACT', startDate: '2022-05', endDate: null, description: '고객사 앱 개발 계약직, React Native·Flutter' },
    ]],
    [freelancer5, [
      { company: '인사이트AI', position: 'ML 엔지니어', employmentType: 'FULL_TIME', startDate: '2018-07', endDate: '2023-08', description: '추천·분류 모델 개발과 MLOps' },
      { company: '프리랜서', position: 'AI/ML 엔지니어', employmentType: 'FREELANCE', startDate: '2023-09', endDate: null, description: null },
    ]],
  ];
  for (const [user, entries] of careers) {
    for (const entry of entries) {
      await prisma.career.create({
        data: {
          userId: user.id,
          ...entry,
          startDate: kstMonth(entry.startDate),
          endDate: entry.endDate ? kstMonth(entry.endDate) : null,
        },
      });
    }
  }

  console.log('Portfolio and careers created');

  // ─── Notification preferences (only values that differ from the default) ──
  await prisma.notificationPreference.createMany({
    data: [
      // 박지윤: 결제 완료 메일은 끄고(기본 on), 정산 예정 메일은 켰다(기본 off).
      { userId: freelancer1.id, type: 'MILESTONE_FUNDED', inApp: null, email: false, createdAt: inWeek(6, 0, 20) },
      { userId: freelancer1.id, type: 'SETTLEMENT_SCHEDULED', inApp: null, email: true, createdAt: inWeek(6, 0, 20) },
      // 이수현: 지원 알림 메일과 미확인 메시지 메일을 껐다.
      { userId: client2.id, type: 'APPLICATION_CREATED', inApp: null, email: false, createdAt: inWeek(7, 2, 9) },
      { userId: client2.id, type: 'MESSAGE_UNREAD_DIGEST', inApp: null, email: false, createdAt: inWeek(7, 2, 9) },
    ],
  });

  // ─── Notifications (representative, not one per event) ─
  const v = (contract, project, milestone, extra = {}) => ({
    contractId: contract.id,
    projectTitle: project.title,
    ...(milestone ? { milestoneId: milestone.id, milestoneTitle: milestone.title, amount: milestone.amount } : {}),
    ...extra,
  });
  const read = (at) => plus(at, 2 * HOUR);

  // 김서준 (의뢰인)
  await notifyRow(client1, 'APPLICATION_CREATED', { applicantName: freelancer1.name, projectTitle: project1.title, projectId: project1.id }, app1Park.createdAt, read(app1Park.createdAt));
  await notifyRow(client1, 'APPLICATION_CREATED', { applicantName: freelancer5.name, projectTitle: project1.title, projectId: project1.id }, app1Song.createdAt, read(app1Song.createdAt));
  await notifyRow(client1, 'APPLICATION_CREATED', { applicantName: freelancer3.name, projectTitle: project1.title, projectId: project1.id }, app1Han.createdAt);
  await notifyRow(client1, 'CONTRACT_ACTIVATED', v(contract11, project11), signed11, read(signed11));
  await notifyRow(client1, 'MILESTONE_SUBMITTED', v(contract11, project11, m11a), inWeek(2, 0, 15), read(inWeek(2, 0, 15)));
  await notifyRow(client1, 'CONTRACT_COMPLETED', v(contract12, project12), completed12, read(completed12));

  // 이수현 (의뢰인)
  await notifyRow(client2, 'APPLICATION_CREATED', { applicantName: freelancer5.name, projectTitle: project5.title, projectId: project5.id }, app5Song.createdAt, read(app5Song.createdAt));
  await notifyRow(client2, 'APPLICATION_CREATED', { applicantName: freelancer2.name, projectTitle: project2.title, projectId: project2.id }, app2Jung.createdAt);
  await notifyRow(client2, 'APPLICATION_CREATED', { applicantName: freelancer1.name, projectTitle: project2.title, projectId: project2.id }, app2Park.createdAt);
  await notifyRow(client2, 'MILESTONE_AUTO_APPROVE_REMINDER', v(contract10, project10, m10a), plus(autoApproved10, -48 * HOUR - MINUTE), read(plus(autoApproved10, -48 * HOUR)));
  await notifyRow(client2, 'MILESTONE_AUTO_APPROVED', v(contract10, project10, m10a), autoApproved10, read(autoApproved10));
  await notifyRow(client2, 'MILESTONE_SUBMITTED', v(contract10, project10, m10b), inWeek(1, 4, 15), read(inWeek(1, 4, 15)));
  await notifyRow(client2, 'CONTRACT_COMPLETED', v(contract7, project7), completed7);

  // 최민호 (의뢰인)
  await notifyRow(client3, 'APPLICATION_CREATED', { applicantName: freelancer1.name, projectTitle: project3.title, projectId: project3.id }, app3Park.createdAt, read(app3Park.createdAt));
  await notifyRow(client3, 'APPLICATION_CREATED', { applicantName: freelancer3.name, projectTitle: project3.title, projectId: project3.id }, app3Han.createdAt, read(app3Han.createdAt));
  await notifyRow(client3, 'MILESTONE_SUBMITTED', v(contract8, project8, m8b), r1At, read(r1At));
  await notifyRow(client3, 'MILESTONE_SUBMITTED', v(contract8, project8, m8b), r2At);

  // 박지윤 (프리랜서)
  await notifyRow(freelancer1, 'APPLICATION_ACCEPTED', v(contract8, project8), accept8, read(accept8));
  await notifyRow(freelancer1, 'CONTRACT_ACTIVATED', v(contract8, project8), signed8, read(signed8));
  await notifyRow(freelancer1, 'MILESTONE_FUNDED', v(contract8, project8, m8b), inWeek(2, 1, 15), read(inWeek(2, 1, 15)));
  await notifyRow(freelancer1, 'SETTLEMENT_SCHEDULED', { settlementId: settlementPark2.id, amount: settlementPark2.netAmount }, settlementPark2.createdAt, read(settlementPark2.createdAt));
  await notifyRow(freelancer1, 'SETTLEMENT_PAID', { settlementId: settlementPark2.id, amount: settlementPark2.netAmount }, settlementPark2.paidAt, read(settlementPark2.paidAt));
  const revisionNotice8 = await notifyRow(freelancer1, 'MILESTONE_REVISION_REQUESTED', v(contract8, project8, m8b, { reason: reason8 }), rejected8At, read(rejected8At));

  // 정하은 (프리랜서)
  await notifyRow(freelancer2, 'APPLICATION_REJECTED', { projectTitle: project8.title }, accept8, read(accept8));
  await notifyRow(freelancer2, 'MILESTONE_AUTO_APPROVED', v(contract10, project10, m10a), autoApproved10, read(autoApproved10));
  await notifyRow(freelancer2, 'SETTLEMENT_SCHEDULED', { settlementId: settlementJung2.id, amount: settlementJung2.netAmount }, settlementJung2.createdAt, read(settlementJung2.createdAt));
  const onHoldNotice10 = await notifyRow(freelancer2, 'SETTLEMENT_ON_HOLD', { amount: settlementJung2.netAmount }, settlementJung2.scheduledPayoutAt);
  await notifyRow(freelancer2, 'MILESTONE_FUNDED', v(contract10, project10, m10b), inWeek(2, 3, 15), read(inWeek(2, 3, 15)));
  await notifyRow(freelancer2, 'MILESTONE_REVISION_REQUESTED', v(contract10, project10, m10b, { reason: reason10 }), rejected10At);

  // 한도윤 (프리랜서)
  await notifyRow(freelancer3, 'MILESTONE_APPROVED', v(contract7, project7, m7b), inWeek(1, 2, 17), read(inWeek(1, 2, 17)));
  await notifyRow(freelancer3, 'SETTLEMENT_SCHEDULED', { settlementId: settlementHan1.id, amount: settlementHan1.netAmount }, settlementHan1.createdAt);
  await notifyRow(freelancer3, 'MILESTONE_APPROVED', v(contract7, project7, m7c), completed7);
  const completedNotice7 = await notifyRow(freelancer3, 'CONTRACT_COMPLETED', v(contract7, project7), plus(completed7, 1));

  // 윤서아 (프리랜서)
  await notifyRow(freelancer4, 'APPLICATION_ACCEPTED', v(contract9, project9), accept9);

  // 송민재 (프리랜서)
  await notifyRow(freelancer5, 'MILESTONE_APPROVED', v(contract11, project11, m11a), inWeek(2, 1, 11), read(inWeek(2, 1, 11)));
  await notifyRow(freelancer5, 'MILESTONE_FUNDED', v(contract11, project11, m11b), inWeek(2, 1, 12), read(inWeek(2, 1, 12)));
  await notifyRow(freelancer5, 'SETTLEMENT_SCHEDULED', { settlementId: settlementSong2.id, amount: settlementSong2.netAmount }, settlementSong2.createdAt, read(settlementSong2.createdAt));
  const failedNotice11 = await notifyRow(freelancer5, 'SETTLEMENT_FAILED', { settlementId: settlementSong2.id, amount: settlementSong2.netAmount }, lastPayout11);

  console.log('Notifications created');

  // ─── Email deliveries ──────────────────────────────
  // A few rows of the audit trail, as their `notification.email` jobs left them.
  await emailRow(freelancer1, 'MILESTONE_REVISION_REQUESTED', v(contract8, project8, m8b, { reason: reason8 }), { createdAt: rejected8At, notification: revisionNotice8 });
  await emailRow(freelancer3, 'CONTRACT_COMPLETED', v(contract7, project7), { createdAt: plus(completed7, 1), notification: completedNotice7 });
  await emailRow(freelancer5, 'SETTLEMENT_FAILED', { settlementId: settlementSong2.id, amount: settlementSong2.netAmount }, { createdAt: lastPayout11, notification: failedNotice11 });
  // MAIL_PROVIDER was briefly set to an unsupported value: FAILED without a provider call.
  await emailRow(freelancer2, 'SETTLEMENT_ON_HOLD', { amount: settlementJung2.netAmount }, {
    createdAt: settlementJung2.scheduledPayoutAt,
    notification: onHoldNotice10,
    status: 'FAILED',
    provider: 'ses',
    attempts: 0,
    error: 'Unsupported MAIL_PROVIDER "ses"',
  });
  // Unread-message digests: sent 10 minutes after each still-unread message.
  const digests = [
    [client3, conv8, project8, unread8a, 2],
    [freelancer4, conv9, project9, conv9.messages.kim2.createdAt, 1],
    [freelancer2, conv10, project10, conv10.messages.lee2.createdAt, 1],
    [client1, conv11, project11, conv11.messages.song3.createdAt, 1],
  ];
  for (const [user, conv, project, firstUnreadAt, unreadCount] of digests) {
    const conversationId = conv.conversation.id;
    await emailRow(user, 'MESSAGE_UNREAD_DIGEST', { projectTitle: project.title, conversationId, unreadCount }, {
      createdAt: plus(firstUnreadAt, 10 * MINUTE),
      contextKey: `conversation:${conversationId}`,
    });
  }

  console.log('Email deliveries created');

  // ─── AI 분석 결과 (project1) ─────────────────────────
  await prisma.pricingAnalysis.create({
    data: {
      projectId: project1.id,
      features: [
        {
          name: 'GPT API 연동 챗봇 엔진',
          description: 'OpenAI API 기반 대화 처리 엔진 개발',
          estimatedCost: 2500000,
          rationale: 'GPT API 연동 및 프롬프트 엔지니어링, 컨텍스트 관리 포함',
          duration: '2주',
        },
        {
          name: '주문 조회/반품 접수 기능',
          description: '기존 쇼핑몰 DB와 연동하여 주문 조회, 반품 접수 처리',
          estimatedCost: 1500000,
          rationale: '외부 시스템 API 연동 및 비즈니스 로직 구현',
          duration: '1주',
        },
        {
          name: '고객 채팅 UI',
          description: '실시간 채팅 인터페이스 (웹 위젯 형태)',
          estimatedCost: 1200000,
          rationale: 'WebSocket 기반 실시간 통신 및 반응형 UI 구현',
          duration: '1주',
        },
        {
          name: '관리자 대시보드',
          description: '대화 이력 조회, 통계, 챗봇 학습 데이터 관리',
          estimatedCost: 2000000,
          rationale: '데이터 시각화 및 관리 기능 포함 어드민 페이지',
          duration: '1.5주',
        },
        {
          name: '배포 및 인프라 설정',
          description: 'AWS/GCP 배포, CI/CD 파이프라인 구성',
          estimatedCost: 800000,
          rationale: '컨테이너화 및 자동 배포 환경 구성',
          duration: '0.5주',
        },
      ],
      totalAmount: 8000000,
      summary:
        '전체 프로젝트는 약 6주 소요 예상이며, GPT API 연동 챗봇 엔진이 가장 핵심적인 작업입니다. 예산 800만원은 시장 평균 대비 적정한 수준입니다.',
      marketReference:
        '유사 AI 챗봇 프로젝트의 시장 평균 단가는 700만원~1,200만원 범위입니다. 관리자 대시보드 포함 시 상위 범위에 해당합니다.',
      createdAt: ago(5 * DAY + 2 * HOUR),
    },
  });

  console.log('Pricing analysis created');
  console.log('Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
