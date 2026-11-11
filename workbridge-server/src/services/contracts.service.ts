import type { ContractStatus, Prisma, Role } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { CONTRACT_CANCELLED, CONTRACT_NOT_CANCELLABLE } from '../lib/contractMessages';
import { logger } from '../lib/logger';
import { notifyRecipients } from '../lib/notifications/notify';
import { renderTemplate } from '../lib/notifications/templates';
import { postSystemMessage, unreadByContract } from './messaging.service';
import { milestoneInclude, milestoneSummary, serializeMilestone } from './milestones.service';
import { presignAttachments } from './attachments.service';

/**
 * Contract reads shared by the contract controller (`GET /:id`, sign) and the contract list
 * route (`GET /api/contracts`), and cancelling a contract before it is signed
 * (docs/domain/projects-contracts.md "서명 전 철회").
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
  if (!contract) throw new AppError('Contract not found', 404);
  if (contract.clientId !== actorId && contract.freelancerId !== actorId) {
    throw new AppError('Not authorized', 403);
  }
  if (contract.status === 'CANCELLED') throw new AppError(CONTRACT_CANCELLED, 409);
  if (contract.status !== 'PENDING') throw new AppError(CONTRACT_NOT_CANCELLABLE, 409);

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
      throw new AppError(current.status === 'CANCELLED' ? CONTRACT_CANCELLED : CONTRACT_NOT_CANCELLABLE, 409);
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
