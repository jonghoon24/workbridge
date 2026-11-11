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
      throw new AppError('AUTH_REQUIRED', 'Authentication required');
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: profileSelect,
    });

    if (!isProfileComplete(user)) {
      throw new AppError('PROFILE_INCOMPLETE', '프로필을 먼저 완성해주세요');
    }

    next();
  } catch (err) {
    next(err);
  }
}
