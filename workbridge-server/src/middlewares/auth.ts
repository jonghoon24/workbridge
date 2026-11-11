import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@prisma/client';
import { AppError } from '../lib/errors';
import { env } from '../env';
import { getRequestContext } from '../lib/requestContext';
import type { JwtUserPayload } from '../types/index';

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new AppError('AUTH_REQUIRED', 'Authentication required'));
  }

  const token = authHeader.split(' ')[1];

  try {
    // `jwt.verify` is typed `string | JwtPayload`; every token we mint carries the
    // `JwtUserPayload` shape, so the cast reflects what is on the wire.
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtUserPayload;
    req.user = decoded;
    const context = getRequestContext();
    if (context) context.userId = decoded.id;
    next();
  } catch {
    return next(new AppError('TOKEN_INVALID', 'Invalid or expired token'));
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError('AUTH_REQUIRED', 'Authentication required'));
    }
    if (!roles.includes(req.user.role)) {
      return next(new AppError('FORBIDDEN_ROLE', 'Insufficient permissions'));
    }
    next();
  };
}
