import { Prisma } from '@prisma/client';
import type { ApprovalType, Milestone, MilestoneStatus } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { env } from '../env';
import { DAY_MS, HOUR_MS, kstDateString, kstDateToEndOfDay } from '../lib/time';
import { PLATFORM_FEE_RATE_BPS, payoutBreakdown, wholeWon } from '../lib/money';
import type { PayoutBreakdown } from '../lib/money';
import { notifyRecipients } from '../lib/notifications/notify';
import type { Recipient } from '../lib/notifications/notify';
import { renderTemplate } from '../lib/notifications/templates';
import type { TemplateType, TemplateVars } from '../lib/notifications/templates';
import { enqueueJob } from '../jobs/queue';
import { postSystemMessage } from './messaging.service';
import {
  assertRequestedFiles,
  attachmentRows,
  attachmentSelect,
  consumeUploads,
  downloadUrlFor,
  issueUploads,
  presignAttachments,
  verifyUploads,
} from './attachments.service';
import type { RequestedFile } from './attachments.service';
import type { PrismaTransactionClient } from '../types/index';

/**
 * Milestones: plan, funding, submission, review and automatic approval
 * (docs/domain/milestones-payments.md). Controllers and job handlers both call into this file; the
 * transactional order of each operation is deliberate and is commented where it matters.
 */

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

/** The default milestone is due 30 KST days after acceptance. */
export const DEFAULT_MILESTONE_DAYS = 30;
export const DEFAULT_MILESTONE_TITLE = '전체 작업';
/** The client is reminded this long before auto-approval. */
export const AUTO_APPROVE_REMINDER_MS = 48 * HOUR_MS;
/** The freelancer is told this long before the due date. */
export const DUE_SOON_MS = 24 * HOUR_MS;

const FUNDED_STATUSES: readonly MilestoneStatus[] = ['FUNDED', 'SUBMITTED', 'REVISION_REQUESTED', 'APPROVED'];
const SUBMITTABLE: MilestoneStatus[] = ['FUNDED', 'REVISION_REQUESTED'];

const NOT_AWAITING_SUBMISSION = 'Milestone is not awaiting a submission';
const NOT_AWAITING_REVIEW = 'Milestone is not awaiting review';
export const PLAN_LOCKED = 'Milestone plan is locked once the contract is active';

/** `MILESTONE_AUTO_APPROVE_DAYS`: a positive integer number of days; anything else falls back to 7. */
export function autoApproveDays(): number {
  const raw = env.MILESTONE_AUTO_APPROVE_DAYS.trim();
  const days = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(days) && days >= 1 ? days : 7;
}

/** End of the KST day 30 days after `now`'s KST date. */
export function defaultMilestoneDueDate(now: Date): Date {
  return kstDateToEndOfDay(kstDateString(new Date(now.getTime() + DEFAULT_MILESTONE_DAYS * DAY_MS)));
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * An attachment row; `presignAttachments` turns it into exactly
 * `{ id, url, fileName, mimeType, size, createdAt }` before it leaves the service.
 */
const attachmentQuery = {
  select: attachmentSelect,
  orderBy: { createdAt: 'asc' },
} satisfies Prisma.MilestoneSubmission$attachmentsArgs;

export const milestoneInclude = {
  payment: true,
  settlementItem: true,
  submissions: {
    orderBy: { round: 'desc' },
    take: 1,
    include: { attachments: attachmentQuery },
  },
} satisfies Prisma.MilestoneInclude;

export type MilestoneWithRelations = Prisma.MilestoneGetPayload<{ include: typeof milestoneInclude }>;

/** The settlement item's stored values once approved, else `payoutBreakdown()` at the current rate. */
export function payoutPreviewFor(
  milestone: Pick<Milestone, 'amount'> & {
    settlementItem: { grossAmount: number; feeAmount: number; feeVatAmount: number; netAmount: number } | null;
  },
): PayoutBreakdown {
  const item = milestone.settlementItem;
  if (item) {
    return { gross: item.grossAmount, fee: item.feeAmount, vat: item.feeVatAmount, net: item.netAmount };
  }
  return payoutBreakdown(wholeWon(milestone.amount), PLATFORM_FEE_RATE_BPS);
}

/** The milestone row plus `payment`, `latestSubmission` and `payoutPreview`. */
export function serializeMilestone(milestone: MilestoneWithRelations) {
  const { submissions, settlementItem, ...row } = milestone;
  return {
    ...row,
    latestSubmission: submissions[0] ?? null,
    payoutPreview: payoutPreviewFor(milestone),
  };
}

export interface MilestoneSummary {
  count: number;
  contractAmount: number;
  fundedAmount: number;
  approvedAmount: number;
  approvedCount: number;
}

/** A contract's milestone totals, as returned with the contract. */
export function milestoneSummary(
  milestones: readonly Pick<Milestone, 'status' | 'amount'>[],
  contractAmount: number,
): MilestoneSummary {
  let fundedAmount = 0;
  let approvedAmount = 0;
  let approvedCount = 0;
  for (const m of milestones) {
    if (FUNDED_STATUSES.includes(m.status)) fundedAmount += m.amount;
    if (m.status === 'APPROVED') {
      approvedAmount += m.amount;
      approvedCount += 1;
    }
  }
  return {
    count: milestones.length,
    contractAmount: wholeWon(contractAmount),
    fundedAmount,
    approvedAmount,
    approvedCount,
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const partySelect = { select: { id: true, deletedAt: true } } as const;

const milestoneContextInclude = {
  contract: {
    include: {
      project: { select: { id: true, title: true, deletedAt: true } },
      client: partySelect,
      freelancer: partySelect,
    },
  },
} satisfies Prisma.MilestoneInclude;

type MilestoneWithContext = Prisma.MilestoneGetPayload<{ include: typeof milestoneContextInclude }>;

/** Missing, or the contract's project soft-deleted → 404 `Milestone not found`. */
async function findMilestoneForRoute(milestoneId: string): Promise<MilestoneWithContext> {
  const milestone = await prisma.milestone.findFirst({
    where: { id: milestoneId, contract: { project: { deletedAt: null } } },
    include: milestoneContextInclude,
  });
  if (!milestone) throw new AppError('Milestone not found', 404);
  return milestone;
}

function assertParty(milestone: MilestoneWithContext, userId: string): void {
  const { contract } = milestone;
  if (contract.clientId !== userId && contract.freelancerId !== userId) {
    throw new AppError('Not authorized', 403);
  }
}

/** Contract routes of the plan: missing or project soft-deleted → 404. */
async function findContractForRoute(contractId: string) {
  const contract = await prisma.contract.findFirst({
    where: { id: contractId, project: { deletedAt: null } },
    include: {
      project: { select: { id: true, title: true } },
      freelancer: partySelect,
    },
  });
  if (!contract) throw new AppError('Contract not found', 404);
  return contract;
}

function varsFor(milestone: MilestoneWithContext, extra: TemplateVars = {}): TemplateVars {
  return {
    projectTitle: milestone.contract.project.title,
    contractId: milestone.contractId,
    milestoneId: milestone.id,
    milestoneTitle: milestone.title,
    ...extra,
  };
}

async function notifyTemplate(
  tx: PrismaTransactionClient,
  recipients: readonly Recipient[],
  type: TemplateType,
  vars: TemplateVars,
  now: Date,
): Promise<void> {
  await notifyRecipients(tx, recipients, { type, ...renderTemplate(type, vars) }, now);
}

// ---------------------------------------------------------------------------
// Default milestone and plan
// ---------------------------------------------------------------------------

/** Created when an application is accepted: the contract's single default milestone. */
export function createDefaultMilestone(
  tx: PrismaTransactionClient,
  contract: { id: string; amount: number },
  dueDate: Date,
): Promise<Milestone> {
  return tx.milestone.create({
    data: {
      contractId: contract.id,
      sequence: 1,
      title: DEFAULT_MILESTONE_TITLE,
      amount: wholeWon(contract.amount),
      dueDate,
    },
  });
}

/** Either party may read the plan. */
export async function listContractMilestones(contractId: string, userId: string) {
  const contract = await findContractForRoute(contractId);
  if (contract.clientId !== userId && contract.freelancerId !== userId) {
    throw new AppError('Not authorized', 403);
  }
  const milestones = await prisma.milestone.findMany({
    where: { contractId },
    include: milestoneInclude,
    orderBy: { sequence: 'asc' },
  });
  return presignAttachments({
    milestones: milestones.map(serializeMilestone),
    milestoneSummary: milestoneSummary(milestones, contract.amount),
  });
}

export interface PlanItem {
  title: string;
  description: string | null;
  amount: number;
  /** `YYYY-MM-DD`, already validated (a KST date, not before today). */
  dueDate: string;
}

/** Replaces the whole plan of a PENDING contract. */
export async function replacePlan(contractId: string, actorId: string, items: readonly PlanItem[], now: Date = new Date()) {
  const contract = await findContractForRoute(contractId);
  if (contract.clientId !== actorId) throw new AppError('Not authorized', 403);
  if (contract.status !== 'PENDING') throw new AppError(PLAN_LOCKED, 409);

  const expected = wholeWon(contract.amount);
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  if (total !== expected) {
    throw new AppError(`Milestone amounts must add up to the contract amount (${expected})`, 400);
  }

  const dueDates = items.map((item) => kstDateToEndOfDay(item.dueDate));
  const endDate = dueDates[dueDates.length - 1];

  return prisma.$transaction(async (tx) => {
    // Lock the contract row and read its pre-image first. A concurrent signature serializes
    // on this lock, and "was a signature present" comes from the locked row, not a stale read.
    const [locked] = await tx.$queryRaw<{ status: string; clientSigned: boolean; freelancerSigned: boolean }[]>`
      SELECT "status", "clientSigned", "freelancerSigned" FROM "Contract" WHERE "id" = ${contractId} FOR UPDATE`;
    if (!locked || locked.status !== 'PENDING') throw new AppError(PLAN_LOCKED, 409);

    const updated = await tx.contract.update({
      where: { id: contractId },
      data: { clientSigned: false, freelancerSigned: false, endDate },
      select: { id: true, status: true, amount: true, endDate: true, clientSigned: true, freelancerSigned: true },
    });

    // Every milestone of a PENDING contract is PENDING and has no payment (payments need ACTIVE).
    await tx.milestone.deleteMany({ where: { contractId } });
    await tx.milestone.createMany({
      data: items.map((item, index) => ({
        contractId,
        sequence: index + 1,
        title: item.title,
        description: item.description,
        amount: item.amount,
        dueDate: dueDates[index],
      })),
    });

    if (locked.clientSigned || locked.freelancerSigned) {
      await notifyTemplate(tx, [contract.freelancer], 'MILESTONE_PLAN_UPDATED', {
        projectTitle: contract.project.title,
        contractId,
      }, now);
    }
    // Every replacement leaves a system message, signature or not. It is the last write, so the
    // conversation row is locked after the contract.
    await postSystemMessage(tx, contractId, 'MILESTONE_PLAN_UPDATED', {
      signaturesReset: locked.clientSigned || locked.freelancerSigned,
    });

    const milestones = await tx.milestone.findMany({
      where: { contractId },
      include: milestoneInclude,
      orderBy: { sequence: 'asc' },
    });
    return { contract: updated, milestones: milestones.map(serializeMilestone) };
  }, { timeout: 15_000 });
}

/** The plan a PENDING contract must have before it can be signed. */
export function isValidPlan(milestones: readonly Pick<Milestone, 'status' | 'amount'>[], contractAmount: number): boolean {
  if (milestones.length === 0) return false;
  if (milestones.some((m) => m.status !== 'PENDING')) return false;
  const total = milestones.reduce((sum, m) => sum + m.amount, 0);
  return total === wholeWon(contractAmount);
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export async function getMilestoneDetail(milestoneId: string, userId: string) {
  const context = await findMilestoneForRoute(milestoneId);
  assertParty(context, userId);

  const milestone = await prisma.milestone.findUniqueOrThrow({
    where: { id: milestoneId },
    include: {
      ...milestoneInclude,
      contract: {
        select: {
          id: true,
          status: true,
          amount: true,
          clientId: true,
          freelancerId: true,
          project: { select: { id: true, title: true } },
        },
      },
    },
  });
  const submissions = await prisma.milestoneSubmission.findMany({
    where: { milestoneId },
    orderBy: { round: 'desc' },
    include: { attachments: attachmentQuery },
  });

  const { contract, ...rest } = milestone;
  return presignAttachments({ ...serializeMilestone(rest), submissions, contract });
}

// ---------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------

/**
 * `PENDING → FUNDED`. A **no-op when the milestone is no longer PENDING** — it must not
 * throw, because the confirm path's verification catch-all would turn the error into a FAILED
 * payment and overwrite a concurrent winner's COMPLETED one.
 */
export async function markFunded(
  tx: PrismaTransactionClient,
  milestoneId: string,
  now: Date,
): Promise<{ funded: boolean }> {
  const { count } = await tx.milestone.updateMany({
    where: { id: milestoneId, status: 'PENDING' },
    data: { status: 'FUNDED', fundedAt: now },
  });
  if (count === 0) return { funded: false };

  const milestone = await tx.milestone.findUniqueOrThrow({
    where: { id: milestoneId },
    include: milestoneContextInclude,
  });

  await notifyTemplate(tx, [milestone.contract.freelancer], 'MILESTONE_FUNDED', varsFor(milestone, { amount: milestone.amount }), now);

  const dueSoonAt = new Date(milestone.dueDate.getTime() - DUE_SOON_MS);
  if (dueSoonAt > now) {
    await enqueueJob(tx, {
      type: 'milestone.dueSoon',
      payload: { milestoneId },
      runAt: dueSoonAt,
      dedupeKey: `milestone.dueSoon:${milestoneId}`,
    });
  }
  await enqueueJob(tx, {
    type: 'milestone.overdue',
    payload: { milestoneId },
    runAt: milestone.dueDate,
    dedupeKey: `milestone.overdue:${milestoneId}`,
  });

  // Only the transition posts (the no-op above returned early). Callers make this the last
  // write of their transaction, so the conversation row is locked last.
  await postSystemMessage(tx, milestone.contractId, 'MILESTONE_FUNDED', { milestoneTitle: milestone.title });

  return { funded: true };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export interface SubmissionInput {
  message: string;
  links: string[];
  /** Uploads issued by `POST /api/milestones/:id/uploads`, in display order. */
  uploadIds: string[];
}

/** The submitting freelancer of a submittable milestone: 404, 403, then 409. */
async function findSubmittableMilestone(milestoneId: string, actorId: string): Promise<MilestoneWithContext> {
  const milestone = await findMilestoneForRoute(milestoneId);
  if (milestone.contract.freelancerId !== actorId) throw new AppError('Not authorized', 403);
  if (!SUBMITTABLE.includes(milestone.status)) throw new AppError(NOT_AWAITING_SUBMISSION, 409);
  return milestone;
}

/**
 * `POST /api/milestones/:id/uploads`: the file policy (before any lookup), the submission checks,
 * then one signed upload URL per file.
 */
export async function requestSubmissionUploads(
  milestoneId: string,
  actorId: string,
  files: readonly RequestedFile[],
  now: Date,
) {
  assertRequestedFiles(files);
  await findSubmittableMilestone(milestoneId, actorId);
  return issueUploads(actorId, 'MILESTONE_SUBMISSION', milestoneId, `milestones/${milestoneId}`, files, now);
}

export async function submitMilestone(
  milestoneId: string,
  actorId: string,
  input: SubmissionInput,
  now: Date = new Date(),
) {
  const milestone = await findSubmittableMilestone(milestoneId, actorId);

  // Storage is read before the transaction; a storage failure is a 502 before anything is written.
  const uploads = await verifyUploads(actorId, 'MILESTONE_SUBMISSION', milestoneId, input.uploadIds, now);

  const autoApproveAt = new Date(now.getTime() + autoApproveDays() * DAY_MS);

  const result = await prisma.$transaction(async (tx) => {
    // The conditional status write comes first and holds the milestone's row lock, so
    // the round below is computed by one submission at a time (never a P2002 → 500).
    const { count } = await tx.milestone.updateMany({
      where: { id: milestoneId, status: { in: SUBMITTABLE } },
      data: { status: 'SUBMITTED', submittedAt: now, autoApproveAt },
    });
    if (count === 0) throw new AppError(NOT_AWAITING_SUBMISSION, 409);
    await consumeUploads(tx, actorId, uploads);

    const last = await tx.milestoneSubmission.findFirst({
      where: { milestoneId },
      orderBy: { round: 'desc' },
      select: { round: true },
    });
    const round = (last?.round ?? 0) + 1;

    const submission = await tx.milestoneSubmission.create({
      data: {
        milestoneId,
        round,
        message: input.message,
        links: input.links,
        submittedAt: now,
        attachments: { create: attachmentRows(uploads, now) },
      },
      include: { attachments: attachmentQuery },
    });

    await enqueueJob(tx, {
      type: 'milestone.autoApprove',
      payload: { milestoneId, round },
      runAt: autoApproveAt,
      dedupeKey: `milestone.autoApprove:${milestoneId}:${round}`,
    });
    const reminderAt = new Date(autoApproveAt.getTime() - AUTO_APPROVE_REMINDER_MS);
    if (reminderAt > now) {
      await enqueueJob(tx, {
        type: 'milestone.autoApproveReminder',
        payload: { milestoneId, round },
        runAt: reminderAt,
        dedupeKey: `milestone.autoApproveReminder:${milestoneId}:${round}`,
      });
    }

    await notifyTemplate(tx, [milestone.contract.client], 'MILESTONE_SUBMITTED', varsFor(milestone), now);
    await postSystemMessage(tx, milestone.contractId, 'MILESTONE_SUBMITTED', { milestoneTitle: milestone.title, round });

    const updated = await tx.milestone.findUniqueOrThrow({ where: { id: milestoneId }, include: milestoneInclude });
    return { milestone: serializeMilestone(updated), submission };
  });
  return presignAttachments(result);
}

/**
 * `GET /api/milestones/:id/attachments/:attachmentId/download`: either party, an attachment of
 * any submission of the milestone.
 */
export async function getSubmissionAttachmentDownload(
  milestoneId: string,
  attachmentId: string,
  userId: string,
  now: Date,
) {
  const milestone = await findMilestoneForRoute(milestoneId);
  assertParty(milestone, userId);
  const attachment = await prisma.milestoneAttachment.findFirst({
    where: { id: attachmentId, submission: { milestoneId } },
    select: { storageKey: true, url: true, fileName: true },
  });
  if (!attachment) throw new AppError('Attachment not found', 404);
  return downloadUrlFor(attachment, now);
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export interface ApproveOptions {
  kind: ApprovalType;
  /** Required for MANUAL (must be the contract's client); null for AUTO. */
  actorId: string | null;
  now: Date;
}

export interface ApproveResult {
  milestone: ReturnType<typeof serializeMilestone>;
  contract: { id: string; status: string; completedAt: Date | null };
}

/**
 * The single approval path for the client (MANUAL) and the auto-approval job (AUTO).
 *
 * MANUAL runs the route checks (404 for a deleted project, 403, 409). AUTO skips them — the job
 * has already re-read the state — and proceeds even when the project is soft-deleted, so money
 * already paid is never held by a deletion. An AUTO approval that loses its conditional write returns
 * `null` instead of throwing.
 */
export async function approveMilestone(milestoneId: string, opts: ApproveOptions): Promise<ApproveResult | null> {
  const { kind, actorId, now } = opts;

  let contractId: string;
  if (kind === 'MANUAL') {
    if (!actorId) throw new Error('approveMilestone: MANUAL approval needs an actorId');
    const milestone = await findMilestoneForRoute(milestoneId);
    if (milestone.contract.clientId !== actorId) throw new AppError('Not authorized', 403);
    if (milestone.status !== 'SUBMITTED') throw new AppError(NOT_AWAITING_REVIEW, 409);
    contractId = milestone.contractId;
  } else {
    const milestone = await prisma.milestone.findUnique({ where: { id: milestoneId }, select: { contractId: true } });
    if (!milestone) return null;
    contractId = milestone.contractId;
  }

  const result = await prisma.$transaction(async (tx) => {
    // Lock the contract row first, so approvals of different milestones of one contract
    // serialize and the completion count below sees the other's committed approval.
    await tx.$queryRaw`SELECT "id" FROM "Contract" WHERE "id" = ${contractId} FOR UPDATE`;

    const { count } = await tx.milestone.updateMany({
      where: {
        id: milestoneId,
        status: 'SUBMITTED',
        // A job for an earlier round must not approve a fresh resubmission.
        ...(kind === 'AUTO' ? { autoApproveAt: { lte: now } } : {}),
      },
      data: { status: 'APPROVED', approvedAt: now, approvalType: kind, autoApproveAt: null },
    });
    if (count === 0) {
      if (kind === 'MANUAL') throw new AppError(NOT_AWAITING_REVIEW, 409);
      return null;
    }

    const milestone = await tx.milestone.findUniqueOrThrow({ where: { id: milestoneId }, include: milestoneContextInclude });
    const { contract } = milestone;
    const projectDeleted = contract.project.deletedAt !== null;

    const latest = await tx.milestoneSubmission.findFirst({
      where: { milestoneId },
      orderBy: { round: 'desc' },
      select: { id: true },
    });
    if (latest) {
      await tx.milestoneSubmission.update({
        where: { id: latest.id },
        data: { decision: 'APPROVED', decidedAt: now, decidedById: actorId, autoDecided: kind === 'AUTO' },
      });
    }

    // The settlement item, with the fee rate snapshotted at approval.
    const breakdown = payoutBreakdown(wholeWon(milestone.amount), PLATFORM_FEE_RATE_BPS);
    await tx.settlementItem.create({
      data: {
        milestoneId,
        contractId,
        freelancerId: contract.freelancerId,
        grossAmount: breakdown.gross,
        feeRateBps: PLATFORM_FEE_RATE_BPS,
        feeAmount: breakdown.fee,
        feeVatAmount: breakdown.vat,
        netAmount: breakdown.net,
        approvedAt: now,
      },
    });

    // A fresh statement, after the milestone write.
    const remaining = await tx.milestone.count({ where: { contractId, status: { not: 'APPROVED' } } });
    let completed = false;
    if (remaining === 0) {
      const done = await tx.contract.updateMany({
        where: { id: contractId, status: 'ACTIVE' },
        data: { status: 'COMPLETED', completedAt: now },
      });
      completed = done.count === 1;
      if (completed && !projectDeleted) {
        await tx.project.updateMany({ where: { id: contract.projectId, deletedAt: null }, data: { status: 'COMPLETED' } });
      }
    }

    // A deleted project's approval notifies nobody and posts no system message.
    if (!projectDeleted) {
      const vars = varsFor(milestone);
      if (kind === 'MANUAL') {
        await notifyTemplate(tx, [contract.freelancer], 'MILESTONE_APPROVED', vars, now);
      } else {
        await notifyTemplate(tx, [contract.client, contract.freelancer], 'MILESTONE_AUTO_APPROVED', vars, now);
      }
      if (completed) {
        await notifyTemplate(tx, [contract.client, contract.freelancer], 'CONTRACT_COMPLETED', vars, now);
      }

      // The approval's own message, then completion — the last writes, so the conversation
      // lock comes after the contract, milestone and project. Skipped with the
      // notifications for a deleted project.
      const title = { milestoneTitle: milestone.title };
      await postSystemMessage(tx, contractId, kind === 'MANUAL' ? 'MILESTONE_APPROVED' : 'MILESTONE_AUTO_APPROVED', title);
      if (completed) await postSystemMessage(tx, contractId, 'CONTRACT_COMPLETED');
    }

    const updated = await tx.milestone.findUniqueOrThrow({ where: { id: milestoneId }, include: milestoneInclude });
    const contractAfter = await tx.contract.findUniqueOrThrow({
      where: { id: contractId },
      select: { id: true, status: true, completedAt: true },
    });
    return { milestone: serializeMilestone(updated), contract: contractAfter };
  }, { timeout: 15_000 });
  // Only a person reads the result; the auto-approval job ignores it.
  return result && kind === 'MANUAL' ? presignAttachments(result) : result;
}

// ---------------------------------------------------------------------------
// Rejection
// ---------------------------------------------------------------------------

export async function rejectMilestone(
  milestoneId: string,
  opts: { actorId: string; reason: string; now: Date },
) {
  const { actorId, reason, now } = opts;
  const milestone = await findMilestoneForRoute(milestoneId);
  if (milestone.contract.clientId !== actorId) throw new AppError('Not authorized', 403);
  if (milestone.status !== 'SUBMITTED') throw new AppError(NOT_AWAITING_REVIEW, 409);

  const result = await prisma.$transaction(async (tx) => {
    // The conditional write first; the latest submission is read after it.
    const { count } = await tx.milestone.updateMany({
      where: { id: milestoneId, status: 'SUBMITTED' },
      data: { status: 'REVISION_REQUESTED', revisionCount: { increment: 1 }, autoApproveAt: null },
    });
    if (count === 0) throw new AppError(NOT_AWAITING_REVIEW, 409);

    const latest = await tx.milestoneSubmission.findFirst({
      where: { milestoneId },
      orderBy: { round: 'desc' },
      select: { id: true },
    });
    if (latest) {
      await tx.milestoneSubmission.update({
        where: { id: latest.id },
        data: { decision: 'REJECTED', decisionReason: reason, decidedAt: now, decidedById: actorId },
      });
    }

    await notifyTemplate(tx, [milestone.contract.freelancer], 'MILESTONE_REVISION_REQUESTED', varsFor(milestone, { reason }), now);
    await postSystemMessage(tx, milestone.contractId, 'MILESTONE_REVISION_REQUESTED', { milestoneTitle: milestone.title, reason });

    const updated = await tx.milestone.findUniqueOrThrow({ where: { id: milestoneId }, include: milestoneInclude });
    return { milestone: serializeMilestone(updated) };
  });
  return presignAttachments(result);
}

// ---------------------------------------------------------------------------
// Scheduled notices
// ---------------------------------------------------------------------------

/** Loads a milestone with its context for a job handler; `null` when it does not exist. */
export function findMilestoneForJob(milestoneId: string): Promise<MilestoneWithContext | null> {
  return prisma.milestone.findUnique({ where: { id: milestoneId }, include: milestoneContextInclude });
}

export async function latestRound(milestoneId: string): Promise<number | null> {
  const last = await prisma.milestoneSubmission.findFirst({
    where: { milestoneId },
    orderBy: { round: 'desc' },
    select: { round: true },
  });
  return last?.round ?? null;
}

/**
 * The auto-approval reminder, due-soon and overdue notices. They have no state change of their
 * own, so they open a transaction: a notice's in-app rows, email deliveries and email jobs commit
 * together, and a retry after a failure does not duplicate rows.
 */
export async function sendMilestoneNotice(
  milestone: MilestoneWithContext,
  type: 'MILESTONE_AUTO_APPROVE_REMINDER' | 'MILESTONE_DUE_SOON' | 'MILESTONE_OVERDUE',
  now: Date,
): Promise<void> {
  const { client, freelancer } = milestone.contract;
  const recipients = type === 'MILESTONE_AUTO_APPROVE_REMINDER'
    ? [client]
    : type === 'MILESTONE_DUE_SOON'
      ? [freelancer]
      : [client, freelancer];
  await prisma.$transaction((tx) => notifyTemplate(tx, recipients, type, varsFor(milestone), now));
}

export type { MilestoneWithContext };
