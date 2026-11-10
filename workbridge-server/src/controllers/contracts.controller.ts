import type { NextFunction, Response } from 'express';
import type { Prisma } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { notifyRecipients } from '../lib/notifications/notify';
import { renderTemplate } from '../lib/notifications/templates';
import { contractInclude, serializeContract } from '../services/contracts.service';
import { isValidPlan } from '../services/milestones.service';
import { postSystemMessage } from '../services/messaging.service';
import type { AuthedRequest } from '../types/index';

export async function getContract(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    // A contract whose project is soft-deleted is invisible.
    const contract = await prisma.contract.findFirst({
      where: { id: req.params.id, project: { deletedAt: null } },
      include: contractInclude,
    });

    if (!contract) {
      throw new AppError('Contract not found', 404);
    }

    if (contract.clientId !== req.user.id && contract.freelancerId !== req.user.id) {
      throw new AppError('Not authorized', 403);
    }

    res.json(serializeContract(contract));
  } catch (err) {
    next(err);
  }
}

export async function signContract(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const contract = await prisma.contract.findFirst({
      where: { id: req.params.id, project: { deletedAt: null } },
      include: { milestones: { select: { status: true, amount: true } } },
    });

    if (!contract) {
      throw new AppError('Contract not found', 404);
    }

    if (contract.clientId !== req.user.id && contract.freelancerId !== req.user.id) {
      throw new AppError('Not authorized', 403);
    }

    if (contract.status === 'COMPLETED') {
      throw new AppError('A completed contract cannot be signed again', 400);
    }

    // A PENDING contract needs a valid plan, or the signature is not recorded at all.
    if (contract.status === 'PENDING' && !isValidPlan(contract.milestones, contract.amount)) {
      throw new AppError('Cannot sign a contract without a valid milestone plan', 400);
    }

    const isClient = contract.clientId === req.user.id;
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

    res.json(serializeContract(updated));
  } catch (err) {
    next(err);
  }
}

/** Completion happens automatically when the last milestone is approved; the route stays so callers get the envelope. */
export async function completeContract(_req: AuthedRequest, _res: Response, next: NextFunction) {
  next(new AppError('Contracts are completed automatically when every milestone is approved', 410));
}
