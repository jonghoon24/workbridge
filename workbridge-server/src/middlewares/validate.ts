import type { NextFunction, Request, Response } from 'express';
import type { ZodIssue, ZodTypeAny } from 'zod';

import { AppError } from '../lib/errors';

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/** `items.0.amount: Expected number, received string`, or just the message at the root. */
export function formatZodIssue(issue: ZodIssue): string {
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

function parse(schema: ZodTypeAny, value: unknown): unknown {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(formatZodIssue(result.error.issues[0]), 400);
  }
  return result.data;
}

/**
 * zod request validation for every route that reads a body or query (BEHAVIOR.md rule 12). Mount
 * it after authentication, role and profile checks, and before the controller, so a malformed
 * request is a 400 before any lookup can 404, 403 or 409. Schemas live in `src/schemas/`.
 *
 * Parsed values land in `req.body`, `res.locals.query` and `res.locals.params`. Express 4's
 * `req.query` is a getter-backed object that should not be reassigned, so parsed queries go to
 * `res.locals` instead. On multipart routes mount this **after** the upload middleware, which
 * is what fills `req.body`.
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (schemas.params) res.locals.params = parse(schemas.params, req.params);
      if (schemas.query) res.locals.query = parse(schemas.query, req.query);
      if (schemas.body) req.body = parse(schemas.body, req.body);
      next();
    } catch (err) {
      next(err);
    }
  };
}
