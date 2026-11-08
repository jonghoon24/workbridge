import type { NextFunction, Request, Response } from 'express';

import { logger } from '../lib/logger';
import type { JwtUserPayload } from '../types/index';

/**
 * One `info` line per request when the response finishes, whatever the status — a 500 included
 * (BEHAVIOR.md rule 9). Error level belongs to `errorHandler` alone.
 */
export function accessLog(req: Request, res: Response, next: NextFunction) {
  const startedAt = process.hrtime.bigint();
  // TEMP(authinfra): IP header probe — reverted after the preview check.
  logger.info('ipprobe.server', {
    path: req.originalUrl.split('?')[0],
    xff: req.get('x-forwarded-for'),
    xRealIp: req.get('x-real-ip'),
    xVercelForwardedFor: req.get('x-vercel-forwarded-for'),
    xVercelProxiedFor: req.get('x-vercel-proxied-for'),
    xClientIp: req.get('x-client-ip'),
    xVercelId: req.get('x-vercel-id'),
    socket: req.socket.remoteAddress,
    reqIp: req.ip,
    headerNames: Object.keys(req.headers).sort().join(','),
  });

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    // `req.user` is typed non-optional but is only set behind `authenticate`; this middleware
    // runs on every route, so read it as the optional value it really is here.
    const user = (req as { user?: JwtUserPayload }).user;

    logger.info('request', {
      requestId: res.locals.requestId,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      ip: req.ip,
      userId: user?.id,
    });
  });

  next();
}
