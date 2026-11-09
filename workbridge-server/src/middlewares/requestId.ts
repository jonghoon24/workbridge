import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { requestContext } from '../lib/requestContext';

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Assigns the request id: a well-formed incoming `X-Request-Id` is kept,
 * anything else is replaced by a UUID v4. Always echoed in the response header, never in a
 * body. Mounted first so even CORS rejections and body-parse errors carry it.
 */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.get('x-request-id');
  const id = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();

  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/**
 * Enters the async context that the logger and `enqueueJob` read.
 *
 * Mounted **after** `express.json()` and `cookieParser()`, not alongside `requestId`: the body
 * parser resumes from stream events that fire in the socket's async context, so a context
 * entered before it would be lost by the time the routes run. (Multer has the same problem;
 * `createUpload` re-enters the context around it.)
 */
export function bindRequestContext(req: Request, res: Response, next: NextFunction) {
  requestContext.run({ requestId: res.locals.requestId as string | undefined }, () => next());
}
