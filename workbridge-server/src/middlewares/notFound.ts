import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../lib/errors';

export const NOT_FOUND_MESSAGE = 'Not found';

/**
 * The answer to a request no route matched — an unknown path, a known path with a method it does
 * not serve, or a route that stepped aside with `next('router')` (the internal job endpoint without
 * `INTERNAL_JOB_TOKEN`, the API reference in production). Passed to `errorHandler`, so it is the
 * same `{ error: { message } }` envelope as every other error rather than Express's HTML page
 * (docs/domain/README.md "오류 응답").
 *
 * Mounted in `src/index.ts` after **every** router and before `errorHandler`. Anything mounted
 * after it is unreachable.
 */
export function notFound(_req: Request, _res: Response, next: NextFunction) {
  next(new AppError(NOT_FOUND_MESSAGE, 404));
}
