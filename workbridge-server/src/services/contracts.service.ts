import type { ContractStatus, Prisma } from '@prisma/client';

import prisma from '../lib/prisma';
import { unreadByContract } from './messaging.service';
import { milestoneInclude, milestoneSummary, serializeMilestone } from './milestones.service';
import { presignAttachments } from './attachments.service';

/**
 * Contract reads shared by the contract controller (`GET /:id`, sign) and the contract list
 * route (`GET /api/contracts`).
 */

/** The full contract. `satisfies` keeps literal types like `'desc'` for Prisma. */
export const contractInclude = {
  project: { select: { id: true, title: true, description: true, category: true, status: true } },
  client: { select: { id: true, name: true, email: true, companyName: true, profileImage: true } },
  freelancer: { select: { id: true, name: true, email: true, skills: true, profileImage: true } },
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
 * `payment` key. The latest submissions' attachments get signed download URLs.
 */
export function serializeContract(contract: ContractWithRelations) {
  return presignAttachments({
    ...contract,
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
