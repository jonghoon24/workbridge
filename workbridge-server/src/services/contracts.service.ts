import type { ContractStatus, Prisma, Role } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { CONTRACT_CANCELLED, CONTRACT_NOT_CANCELLABLE } from '../lib/contractMessages';
import { logger } from '../lib/logger';
import { notifyRecipients } from '../lib/notifications/notify';
import { renderTemplate } from '../lib/notifications/templates';
import { postSystemMessage, unreadByContract } from './messaging.service';
import { isValidPlan, milestoneInclude, milestoneSummary, serializeMilestone } from './milestones.service';
import { presignAttachments } from './attachments.service';

/**
 * Contracts (docs/domain/projects-contracts.md): the caller's contract list (`GET /api/contracts`),
 * one contract (`GET /:id`), signing it, and cancelling it before it is signed ("서명 전 철회").
 */

/** The full contract. `satisfies` keeps literal types like `'desc'` for Prisma. */
export const contractInclude = {
  project: {
    select: {
      id: true,
      title: true,
      description: true,
      category: true,
      status: true,
      // `hasLiveContract`: whether the client could recruit again (no contract but cancelled ones).
      _count: { select: { contracts: { where: { status: { not: 'CANCELLED' } } } } },
    },
  },
  // No email: parties reach each other through in-app messages.
  client: { select: { id: true, name: true, companyName: true, profileImage: true } },
  freelancer: { select: { id: true, name: true, skills: true, profileImage: true } },
  milestones: { include: milestoneInclude, orderBy: { sequence: 'asc' } },
  reviews: {
    include: {
      reviewer: { select: { id: true, name: true, profileImage: true } },
      reviewee: { select: { id: true, name: true, profileImage: true } },
    },
    orderBy: { createdAt: 'desc' },
  },
} satisfies Prisma.ContractInclude;

export type ContractWithRelations = Prisma.ContractGetPayload<{ include: typeof contractInclude }>;

/**
 * Milestones serialized (each with its own `payment`) plus `milestoneSummary`; the contract has no
 * `payment` key. The project carries `hasLiveContract` instead of its contract count. The latest
 * submissions' attachments get signed download URLs.
 */
export function serializeContract(contract: ContractWithRelations) {
  const { _count, ...project } = contract.project;
  return presignAttachments({
    ...contract,
    project: { ...project, hasLiveContract: _count.contracts > 0 },
    milestones: contract.milestones.map(serializeMilestone),
    milestoneSummary: milestoneSummary(contract.milestones, contract.amount),
  });
}

export interface ContractListQuery {
  status?: ContractStatus;
  page: number;
  limit: number;
}

/** The caller's contracts as client or freelancer, paginated, each with `unreadMessageCount`. */
export async function listContracts(userId: string, query: ContractListQuery) {
  const where: Prisma.ContractWhereInput = {
    OR: [{ clientId: userId }, { freelancerId: userId }],
    project: { deletedAt: null },
    ...(query.status ? { status: query.status } : {}),
  };
  const party = { select: { id: true, name: true, profileImage: true } } as const;

  const [total, contracts] = await Promise.all([
    prisma.contract.count({ where }),
    prisma.contract.findMany({
      where,
      include: {
        project: { select: { id: true, title: true, status: true } },
        client: party,
        freelancer: party,
        milestones: { select: { status: true, amount: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
  ]);
  const unread = await unreadByContract(userId, contracts.map((c) => c.id));

  return {
    contracts: contracts.map((c) => {
      const myRole = c.clientId === userId ? 'CLIENT' : 'FREELANCER';
      return {
        id: c.id,
        status: c.status,
        amount: c.amount,
        startDate: c.startDate,
        endDate: c.endDate,
        completedAt: c.completedAt,
        cancelledAt: c.cancelledAt,
        cancelledBy: c.cancelledBy,
        clientSigned: c.clientSigned,
        freelancerSigned: c.freelancerSigned,
        createdAt: c.createdAt,
        myRole,
        project: c.project,
        counterpart: myRole === 'CLIENT' ? c.freelancer : c.client,
        milestoneSummary: milestoneSummary(c.milestones, c.amount),
        unreadMessageCount: unread.get(c.id) ?? 0,
      };
    }),
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}

/**
 * `POST /api/contracts/:id/cancel`: either party withdraws a contract that is still `PENDING` —
 * unsigned, or signed by one side only. Nothing has been paid or done yet (payments need an
 * `ACTIVE` contract), so the row just becomes `CANCELLED` and stays as the record; its milestones,
 * signatures and conversation are left as they were. The project stays `CLOSED` — whether to
 * recruit again is the client's call (`reopenProject`). The counterpart is notified.
 *
 * Missing or project deleted → 404, not a party → 403, already cancelled or no longer `PENDING`
 * → 409. The transition is a conditional write on the contract row, which also serializes it
 * with a signature, a plan replacement and the other party's cancel: whichever takes the row
 * first wins and the loser is a 409 (it re-reads the status to say why).
 *
 * Lock order: `Contract` → the notification's `User` key-share → `Conversation` (last). The
 * contract row is written exactly once — writing it a second time in the same transaction makes
 * Postgres re-check its foreign keys and key-share the parties' `User` rows early, which can
 * cycle with a withdrawal (`Project` → `Application` → `User`; docs/DATABASE.md, #79). For the
 * same reason `cancelledBy` is a role, not a user id with a foreign key.
 */
export async function cancelContract(contractId: string, actorId: string, now: Date) {
  const party = { select: { id: true, deletedAt: true } } as const;
  const contract = await prisma.contract.findFirst({
    where: { id: contractId, project: { deletedAt: null } },
    select: {
      status: true,
      clientId: true,
      freelancerId: true,
      project: { select: { title: true } },
      client: party,
      freelancer: party,
    },
  });
  if (!contract) throw new AppError('CONTRACT_NOT_FOUND', 'Contract not found');
  if (contract.clientId !== actorId && contract.freelancerId !== actorId) {
    throw new AppError('FORBIDDEN_RESOURCE', 'Not authorized');
  }
  if (contract.status === 'CANCELLED') throw new AppError('CONTRACT_CANCELLED', CONTRACT_CANCELLED);
  if (contract.status !== 'PENDING') throw new AppError('CONTRACT_NOT_CANCELLABLE', CONTRACT_NOT_CANCELLABLE);

  const cancelledBy: Role = contract.clientId === actorId ? 'CLIENT' : 'FREELANCER';
  const counterpart = cancelledBy === 'CLIENT' ? contract.freelancer : contract.client;

  const cancelled = await prisma.$transaction(async (tx) => {
    const { count } = await tx.contract.updateMany({
      where: { id: contractId, status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt: now, cancelledBy },
    });
    if (count === 0) {
      // Lost to the other party's cancel, or to the signature that activated it.
      const current = await tx.contract.findUniqueOrThrow({ where: { id: contractId }, select: { status: true } });
      throw current.status === 'CANCELLED'
        ? new AppError('CONTRACT_CANCELLED', CONTRACT_CANCELLED)
        : new AppError('CONTRACT_NOT_CANCELLABLE', CONTRACT_NOT_CANCELLABLE);
    }

    await notifyRecipients(tx, [counterpart], {
      type: 'CONTRACT_CANCELLED',
      ...renderTemplate('CONTRACT_CANCELLED', { projectTitle: contract.project.title, contractId, cancelledBy }),
    }, now);
    // The last write: the conversation row is locked last.
    await postSystemMessage(tx, contractId, 'CONTRACT_CANCELLED', { cancelledBy });

    return tx.contract.findUniqueOrThrow({ where: { id: contractId }, include: contractInclude });
  });

  logger.info('contract cancelled', { contractId, cancelledBy });
  return serializeContract(cancelled);
}

/** `GET /api/contracts/:id`: the full contract, for either party. */
export async function getContractDetail(contractId: string, userId: string) {
  // A contract whose project is soft-deleted is invisible.
  const contract = await prisma.contract.findFirst({
    where: { id: contractId, project: { deletedAt: null } },
    include: contractInclude,
  });

  if (!contract) {
    throw new AppError('CONTRACT_NOT_FOUND', 'Contract not found');
  }

  if (contract.clientId !== userId && contract.freelancerId !== userId) {
    throw new AppError('FORBIDDEN_RESOURCE', 'Not authorized');
  }

  return serializeContract(contract);
}

/**
 * `POST /api/contracts/:id/sign`: records the caller's signature; the second signature activates
 * the contract and moves the project to `IN_PROGRESS`.
 */
export async function recordSignature(contractId: string, userId: string) {
  const contract = await prisma.contract.findFirst({
    where: { id: contractId, project: { deletedAt: null } },
    include: { milestones: { select: { status: true, amount: true } } },
  });

  if (!contract) {
    throw new AppError('CONTRACT_NOT_FOUND', 'Contract not found');
  }

  if (contract.clientId !== userId && contract.freelancerId !== userId) {
    throw new AppError('FORBIDDEN_RESOURCE', 'Not authorized');
  }

  if (contract.status === 'COMPLETED') {
    throw new AppError('CONTRACT_ALREADY_COMPLETED', 'A completed contract cannot be signed again');
  }

  if (contract.status === 'CANCELLED') {
    throw new AppError('CONTRACT_CANCELLED', CONTRACT_CANCELLED);
  }

  // A PENDING contract needs a valid plan, or the signature is not recorded at all. The API
  // cannot create an invalid plan; this guards rows edited directly in the database.
  if (contract.status === 'PENDING' && !isValidPlan(contract.milestones, contract.amount)) {
    throw new AppError('MILESTONE_PLAN_INVALID', 'Cannot sign a contract without a valid milestone plan');
  }

  const isClient = contract.clientId === userId;
  const updateData: Prisma.ContractUpdateInput = isClient
    ? { clientSigned: true }
    : { freelancerSigned: true };

  // Both writes in one transaction. Postgres serializes the two parties on the row lock the
  // UPDATE takes — verified: 15 concurrent sign pairs all activated correctly — so this is not
  // fixing a live race. It closes the window where a failure between the two statements leaves
  // a contract signed-but-inactive, and keeps activation and its notifications atomic.
  const updated = await prisma.$transaction(async (tx) => {
    const signed = await tx.contract.update({
      where: { id: contract.id },
      data: updateData,
      include: {
        project: { select: { title: true } },
        client: { select: { id: true, deletedAt: true } },
        freelancer: { select: { id: true, deletedAt: true } },
      },
    });

    // A cancel that committed while this waited for the row lock: the UPDATE above saw the
    // cancelled row. Refuse, which rolls the signature back.
    if (signed.status === 'CANCELLED') {
      throw new AppError('CONTRACT_CANCELLED', CONTRACT_CANCELLED);
    }

    // Guarded on PENDING so activation can never overwrite a later status.
    if (signed.clientSigned && signed.freelancerSigned && signed.status === 'PENDING') {
      // The work has started: the project moves from "recruitment closed" to "in progress".
      // Before the contract re-read below, so the response carries the new project status.
      await tx.project.updateMany({
        where: { id: contract.projectId, status: 'CLOSED', deletedAt: null },
        data: { status: 'IN_PROGRESS' },
      });
      const activated = await tx.contract.update({
        where: { id: contract.id },
        data: { status: 'ACTIVE' },
        include: contractInclude,
      });
      await notifyRecipients(tx, [signed.client, signed.freelancer], {
        type: 'CONTRACT_ACTIVATED',
        ...renderTemplate('CONTRACT_ACTIVATED', { projectTitle: signed.project.title, contractId: contract.id }),
      });
      // A system message for the activating signature only, as the transaction's last write
      // (the conversation lock is taken last).
      await postSystemMessage(tx, contract.id, 'CONTRACT_ACTIVATED');
      return activated;
    }

    return tx.contract.findUniqueOrThrow({
      where: { id: contract.id },
      include: contractInclude,
    });
  });

  return serializeContract(updated);
}

/**
 * `PATCH /api/contracts/:id`: always refused. Completion happens automatically when the last
 * milestone is approved; the route stays so callers get the envelope.
 */
export function refuseManualCompletion(): never {
  throw new AppError('MANUAL_COMPLETION_REMOVED', 'Contracts are completed automatically when every milestone is approved');
}
