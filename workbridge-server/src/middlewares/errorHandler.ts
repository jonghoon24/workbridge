import type { ErrorRequestHandler } from 'express';

import { logger } from '../lib/logger';
import type { ErrorEnvelope } from '../types/index';

/**
 * Global error handler, mounted last in `index.ts`.
 *
 * **Must keep all four parameters** — Express identifies error handlers by arity, so
 * dropping `next` would silently demote this to an ordinary middleware.
 *
 * The only error-level log in the request path, and only for a 500 (BEHAVIOR.md rules 1, 9).
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  const status = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  if (status === 500) {
    logger.error('unhandled error', {
      requestId: res.locals.requestId,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      err,
    });
  }

  res.status(status).json({ error: { message } } satisfies ErrorEnvelope);
};
