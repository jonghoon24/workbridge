import type { NextFunction, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { isProfileComplete } from '../lib/profileCompletion';

const profileSelect = {
  role: true,
  companyName: true,
  businessField: true,
  skills: true,
  activityCategory: true,
  experienceYears: true,
  hourlyRate: true,
};

export async function requireCompleteProfile(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: profileSelect,
    });

    if (!isProfileComplete(user)) {
      throw new AppError('프로필을 먼저 완성해주세요', 403);
    }

    next();
  } catch (err) {
    next(err);
  }
}
