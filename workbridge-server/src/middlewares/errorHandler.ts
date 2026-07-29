import type { ErrorRequestHandler } from 'express';
import type { ErrorEnvelope } from '../types/index.js';

/**
 * Global error handler, mounted last in `index.ts`.
 *
 * **Must keep all four parameters** — Express identifies error handlers by arity, so
 * dropping `next` would silently demote this to an ordinary middleware.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  const status = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  if (status === 500) {
    console.error(err);
  }

  res.status(status).json({ error: { message } } satisfies ErrorEnvelope);
};
