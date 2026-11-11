import type { NextFunction, Request, Response } from 'express';
import type { ZodIssue, ZodTypeAny } from 'zod';

import { FIELD_ERROR_CODES } from '../lib/errorCodes';
import type { FieldErrorCode } from '../lib/errorCodes';
import { invalidField } from '../lib/errors';

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

function isFieldErrorCode(value: unknown): value is FieldErrorCode {
  return (FIELD_ERROR_CODES as readonly unknown[]).includes(value);
}

/** zod reports a missing value as `invalid_type` received `undefined`. */
function isMissing(issue: ZodIssue): boolean {
  return issue.code === 'invalid_type' && issue.received === 'undefined';
}

/**
 * Why the field failed — `fields[].code` of the 400 (`FIELD_ERROR_CODES`):
 *
 * - missing → `REQUIRED`: `invalid_type` received `undefined`, a union every branch of which saw
 *   nothing (`bodyWholeWon`), or an empty string/list where at least one is needed (`.min(1)`,
 *   which is how `requiredString` reads a blank value);
 * - `too_small` / `too_big` → `TOO_SMALL` / `TOO_LARGE`;
 * - a custom issue → the `fieldCode` it states (`fieldIssue()` in `schemas/common.ts`), else `INVALID`;
 * - anything else (wrong type, format, enum value) → `INVALID`.
 */
export function fieldCodeOf(issue: ZodIssue): FieldErrorCode {
  switch (issue.code) {
    case 'invalid_type':
      return isMissing(issue) ? 'REQUIRED' : 'INVALID';
    case 'invalid_union':
      return issue.unionErrors.length > 0 && issue.unionErrors.every((e) => e.issues.length > 0 && e.issues.every(isMissing))
        ? 'REQUIRED'
        : 'INVALID';
    case 'too_small':
      return (issue.type === 'string' || issue.type === 'array') && Number(issue.minimum) === 1 && issue.inclusive
        ? 'REQUIRED'
        : 'TOO_SMALL';
    case 'too_big':
      return 'TOO_LARGE';
    case 'custom':
      return isFieldErrorCode(issue.params?.fieldCode) ? issue.params.fieldCode : 'INVALID';
    default:
      return 'INVALID';
  }
}

function parse(schema: ZodTypeAny, value: unknown): unknown {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw invalidField(issue.path.join('.'), fieldCodeOf(issue), formatZodIssue(issue));
  }
  return result.data;
}

/**
 * zod request validation for every route that reads a body or query. Mount
 * it after authentication, role and profile checks, and before the controller, so a malformed
 * request is a 400 before any lookup can 404, 403 or 409. Schemas live in `src/schemas/`.
 *
 * A failure is a 400 `VALIDATION_FAILED` about the **first** failing field: `message` is
 * `<path>: <message>`, `fields` is `[{ path, code }]` (`fieldCodeOf`).
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
