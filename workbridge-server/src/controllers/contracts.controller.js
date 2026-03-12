import prisma from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';

export async function getContract(req, res, next) {
  try {
    const contract = await prisma.contract.findUnique({
      where: { id: req.params.id },
      include: {
        project: { select: { id: true, title: true, description: true, category: true, status: true } },
        client: { select: { id: true, name: true, email: true, companyName: true, profileImage: true } },
        freelancer: { select: { id: true, name: true, email: true, skills: true, profileImage: true } },
        payment: true,
        reviews: true,
      },
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

export async function signContract(req, res, next) {
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
    const updateData = isClient
      ? { clientSigned: true }
      : { freelancerSigned: true };

    const updated = await prisma.contract.update({
      where: { id: req.params.id },
      data: updateData,
    });

    // Activate contract if both parties signed
    if (updated.clientSigned && updated.freelancerSigned) {
      await prisma.contract.update({
        where: { id: req.params.id },
        data: { status: 'ACTIVE' },
      });
      updated.status = 'ACTIVE';
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
}
