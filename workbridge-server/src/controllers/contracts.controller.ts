import type { NextFunction, Response } from 'express';
import type { Prisma } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import type { AuthedRequest } from '../types/index';

// `satisfies` (rather than a plain annotation) keeps the literal types Prisma needs —
// e.g. `orderBy: { createdAt: 'desc' }` must stay `'desc'`, not widen to `string` —
// while still letting each query infer its own result payload from this shape.
const contractInclude = {
  project: { select: { id: true, title: true, description: true, category: true, status: true } },
  client: { select: { id: true, name: true, email: true, companyName: true, profileImage: true } },
  freelancer: { select: { id: true, name: true, email: true, skills: true, profileImage: true } },
  payment: true,
  reviews: {
    include: {
      reviewer: { select: { id: true, name: true, profileImage: true } },
      reviewee: { select: { id: true, name: true, profileImage: true } },
    },
    orderBy: { createdAt: 'desc' },
  },
} satisfies Prisma.ContractInclude;

export async function getContract(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const contract = await prisma.contract.findUnique({
      where: { id: req.params.id },
      include: contractInclude,
    });

    if (!contract) {
      throw new AppError('Contract not found', 404);
    }

    if (contract.clientId !== req.user.id && contract.freelancerId !== req.user.id) {
      throw new AppError('Not authorized', 403);
    }

    res.json(contract);
  } catch (err) {
    next(err);
  }
}

export async function signContract(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const contract = await prisma.contract.findUnique({
      where: { id: req.params.id },
    });

    if (!contract) {
      throw new AppError('Contract not found', 404);
    }

    if (contract.clientId !== req.user.id && contract.freelancerId !== req.user.id) {
      throw new AppError('Not authorized', 403);
    }

    const isClient = contract.clientId === req.user.id;
    const updateData: Prisma.ContractUpdateInput = isClient
      ? { clientSigned: true }
      : { freelancerSigned: true };

    const signed = await prisma.contract.update({
      where: { id: req.params.id },
      data: updateData,
    });

    // Activate contract if both parties signed
    if (signed.clientSigned && signed.freelancerSigned) {
      const updated = await prisma.contract.update({
        where: { id: req.params.id },
        data: { status: 'ACTIVE' },
        include: contractInclude,
      });
      return res.json(updated);
    }

    const updated = await prisma.contract.findUnique({
      where: { id: req.params.id },
      include: contractInclude,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function completeContract(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { status } = req.body;

    if (status !== 'COMPLETED') {
      throw new AppError('Status must be COMPLETED', 400);
    }

    const contract = await prisma.contract.findUnique({
      where: { id: req.params.id },
      include: { payment: true },
    });

    if (!contract) {
      throw new AppError('Contract not found', 404);
    }

    if (contract.clientId !== req.user.id) {
      throw new AppError('Only the client can complete the contract', 403);
    }

    if (contract.status !== 'ACTIVE') {
      throw new AppError('Only active contracts can be completed', 400);
    }

    if (contract.payment?.status !== 'COMPLETED') {
      throw new AppError('Payment must be completed before completing the contract', 400);
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: contract.projectId },
        data: { status: 'COMPLETED' },
      });

      return tx.contract.update({
        where: { id: contract.id },
        data: { status: 'COMPLETED' },
        include: contractInclude,
      });
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
}
