import type { ErrorRequestHandler } from 'express';

import { logger } from '../lib/logger';
import { captureError, flushSentry, isSentryEnabled } from '../lib/sentry';
import type { ErrorEnvelope } from '../types/index';

/**
 * Global error handler, mounted last in `index.ts`.
 *
 * **Must keep all four parameters** — Express identifies error handlers by arity, so
 * dropping `next` would silently demote this to an ordinary middleware.
 *
 * Answers every error passed to `next(err)` with `{ error: { message } }`. The only error-level
 * log in the request path, and only for a 500.
 *
 * A 500 is also reported to Sentry when `SENTRY_DSN` is set. The handler itself stays
 * synchronous (Express 4 ignores a returned promise, and a rejection would go unhandled); the
 * response is sent only after the event has been flushed, because Vercel may freeze the
 * function as soon as it goes out. Without a DSN the response is sent synchronously, as before.
 *
 * An error that arrives after the response has been sent (a throw after `res.json`) is not
 * answered again — a second write would throw `ERR_HTTP_HEADERS_SENT`. It is logged as an
 * unhandled error and handed to Express's default handler, which closes the connection.
 */
/** `express.json()` (body-parser) could not parse the body; its own message quotes the parser. */
export const INVALID_JSON_MESSAGE = 'Request body must be valid JSON';

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    logger.error('error after response was sent', {
      requestId: res.locals.requestId as string | undefined,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      err,
    });
    next(err);
    return;
  }

  const status = err.statusCode || 500;
  // A malformed JSON body is a 400 whose message would echo the JSON parser
  // (`Expected property name or '}' in JSON at position 2 …`); answer one fixed sentence instead.
  const message = err.type === 'entity.parse.failed' && status === 400
    ? INVALID_JSON_MESSAGE
    : err.message || 'Internal Server Error';
  const send = () => {
    res.status(status).json({ error: { message } } satisfies ErrorEnvelope);
  };

  if (status !== 500) {
    send();
    return;
  }

  const requestId = res.locals.requestId as string | undefined;
  const path = req.originalUrl.split('?')[0];

  logger.error('unhandled error', {
    requestId,
    method: req.method,
    path,
    err,
  });

  if (!isSentryEnabled()) {
    send();
    return;
  }

  // `req.user` is typed non-optional but is only set behind `authenticate`; read it as the
  // optional value it really is here, since this handler runs for every route.
  void captureError(err, {
    tags: { requestId, method: req.method, path },
    userId: req.user?.id,
  })
    .then(() => flushSentry(2000))
    .finally(() => {
      // Neither step rejects. A throw from `send` itself (headers already sent) goes to
      // Express's default handler, as it would have synchronously.
      try {
        send();
      } catch (sendErr) {
        next(sendErr);
      }
    });
};
