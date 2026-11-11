import type { ErrorRequestHandler } from 'express';

import { AppError } from '../lib/errors';
import type { AppErrorCode } from '../lib/errors';
import { logger } from '../lib/logger';
import { captureError, flushSentry, isSentryEnabled } from '../lib/sentry';
import type { ErrorEnvelope } from '../types/index';

/** `express.json()` (body-parser) could not parse the body; its own message quotes the parser. */
export const INVALID_JSON_MESSAGE = 'Request body must be valid JSON';

/** Express could not percent-decode a path parameter; its own message quotes the raw input. */
export const MALFORMED_PATH_MESSAGE = 'Request path is malformed';

/**
 * The body of every 500. A 500 is a bug, and its error's message is not written for the caller:
 * a Prisma error carries the absolute source path, a source excerpt, constraint and column names,
 * even the failing row (docs/domain/README.md "오류 응답"). The original goes to the error log.
 */
export const INTERNAL_ERROR_MESSAGE = 'Internal Server Error';

/**
 * The client errors `express.json()` (body-parser, raw-body) raises before any route runs, by their
 * `type`. Only these: a library error that merely carries a 4xx `status` is not trusted to be the
 * caller's fault, nor to have a message fit to send (a storage SDK's error does both), so it is a 500.
 */
const BODY_PARSER_CODES: Record<string, AppErrorCode> = {
  'entity.parse.failed': 'MALFORMED_BODY',
  'request.aborted': 'MALFORMED_BODY',
  'request.size.invalid': 'MALFORMED_BODY',
  'entity.too.large': 'PAYLOAD_TOO_LARGE',
  'charset.unsupported': 'UNSUPPORTED_MEDIA_TYPE',
  'encoding.unsupported': 'UNSUPPORTED_MEDIA_TYPE',
};

/** `err` as the `AppError` the API answers with, or `null` for a 500. */
function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  if (typeof err !== 'object' || err === null) return null;

  const type = (err as { type?: unknown }).type;
  if (typeof type === 'string' && Object.hasOwn(BODY_PARSER_CODES, type)) {
    // A malformed JSON body's message would echo the parser (`Expected property name or '}' in
    // JSON at position 2 …`); answer one fixed sentence instead. The others are fixed sentences.
    const message = type === 'entity.parse.failed' ? INVALID_JSON_MESSAGE : String((err as Error).message);
    return new AppError(BODY_PARSER_CODES[type], message);
  }
  // Express's `decode_param` (a path parameter that is not valid percent-encoding).
  if (err instanceof URIError && (err as { status?: unknown }).status === 400) {
    return new AppError('MALFORMED_REQUEST', MALFORMED_PATH_MESSAGE);
  }
  return null;
}

/**
 * Global error handler, mounted last in `index.ts`.
 *
 * **Must keep all four parameters** — Express identifies error handlers by arity, so
 * dropping `next` would silently demote this to an ordinary middleware.
 *
 * Answers every error passed to `next(err)` with `{ error: { code, message, fields? } }`: an
 * `AppError` with its own code (`lib/errorCodes.ts`), body-parser's and Express's request errors
 * with theirs (`toAppError`), and anything else with a 500 `INTERNAL_ERROR`. The only error-level
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

  // Only an `AppError`'s own code is ever sent: other errors carry codes of their own (Prisma's
  // `P2002`, multer's `LIMIT_FILE_SIZE`, Node's `ECONNRESET`) that must not reach the caller.
  const appError = toAppError(err);
  const status = appError ? appError.statusCode : 500;
  const body: ErrorEnvelope = appError
    ? {
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.fields ? { fields: appError.fields } : {}),
      },
    }
    : { error: { code: 'INTERNAL_ERROR', message: INTERNAL_ERROR_MESSAGE } };
  const send = () => {
    res.status(status).json(body);
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
