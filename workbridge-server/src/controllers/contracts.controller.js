import prisma from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';

const contractInclude = {
  project: { select: { id: true, title: true, description: true, category: true, status: true } },
  client: { select: { id: true, name: true, email: true, companyName: true, profileImage: true } },
  freelancer: { select: { id: true, name: true, email: true, skills: true, profileImage: true } },
  payment: true,
  reviews: true,
};

export async function getContract(req, res, next) {
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

    await prisma.contract.update({
      where: { id: req.params.id },
      data: updateData,
    });

    const signed = await prisma.contract.findUnique({
      where: { id: req.params.id },
    });

    if (signed.clientSigned && signed.freelancerSigned) {
      await prisma.contract.update({
        where: { id: req.params.id },
        data: { status: 'ACTIVE' },
      });
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

export async function completeContract(req, res, next) {
  try {
    const { status } = req.body;

    if (status !== 'COMPLETED') {
      throw new AppError('Status must be COMPLETED', 400);
    }

    const contract = await prisma.contract.findUnique({
      where: { id: req.params.id },
      include: { payment: true, project: true },
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
      throw new AppError('Payment must be completed before closing the contract', 400);
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: contract.projectId },
        data: { status: 'COMPLETED' },
      });

      await tx.contract.update({
        where: { id: contract.id },
        data: { status: 'COMPLETED' },
      });

      return tx.contract.findUnique({
        where: { id: contract.id },
        include: contractInclude,
      });
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
}
