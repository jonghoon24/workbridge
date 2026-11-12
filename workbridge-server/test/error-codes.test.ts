import express from 'express';
import multer from 'multer';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { ALL_ERROR_CODES, ERROR_CODES } from '../src/lib/errorCodes';
import { AppError } from '../src/lib/errors';
import { errorHandler } from '../src/middlewares/errorHandler';
import { buildOpenApiDocument } from '../src/openapi/document';
import { api, authed } from './helpers/api';
import { makeClient } from './helpers/factories';

/**
 * The error codes (`src/lib/errorCodes.ts`) are the API's contract with its callers: the client
 * branches on them. These pin the table itself and how `errorHandler` turns errors into codes.
 */

/**
 * Every code ever published, with its status. **Append only**: a code the API has sent is never
 * renamed, removed or given another status (docs/domain/README.md "오류 응답"). A new code is added
 * at the end of this list in the same change that adds it to `ERROR_CODES`.
 */
const PUBLISHED: readonly (readonly [string, number])[] = [
  ['VALIDATION_FAILED', 400],
  ['MALFORMED_BODY', 400],
  ['MALFORMED_REQUEST', 400],
  ['PAYLOAD_TOO_LARGE', 413],
  ['UNSUPPORTED_MEDIA_TYPE', 415],
  ['AUTH_REQUIRED', 401],
  ['TOKEN_INVALID', 401],
  ['REFRESH_TOKEN_INVALID', 401],
  ['INVALID_CREDENTIALS', 401],
  ['ACCOUNT_INACTIVE', 401],
  ['FORBIDDEN_ROLE', 403],
  ['FORBIDDEN_RESOURCE', 403],
  ['PROFILE_INCOMPLETE', 403],
  ['ROUTE_NOT_FOUND', 404],
  ['RATE_LIMITED', 429],
  ['INTERNAL_ERROR', 500],
  ['INTERNAL_TOKEN_INVALID', 403],
  ['FILE_TOO_LARGE', 413],
  ['FILE_TYPE_UNSUPPORTED', 400],
  ['TOO_MANY_FILES', 400],
  ['UPLOAD_FAILED', 502],
  ['STORAGE_UNAVAILABLE', 502],
  ['UPLOAD_NOT_FOUND', 400],
  ['FILE_NOT_UPLOADED', 400],
  ['ATTACHMENT_NOT_FOUND', 404],
  ['USER_NOT_FOUND', 404],
  ['EMAIL_ALREADY_IN_USE', 409],
  ['ROLE_ALREADY_SELECTED', 400],
  ['PASSWORD_NOT_SET', 409],
  ['CURRENT_PASSWORD_INCORRECT', 400],
  ['PASSWORD_ALREADY_CHANGED', 409],
  ['WITHDRAWAL_BLOCKED', 409],
  ['REAUTH_REQUIRED', 400],
  ['REAUTH_INVALID', 400],
  ['PORTFOLIO_ITEM_NOT_FOUND', 404],
  ['PORTFOLIO_LIMIT_REACHED', 409],
  ['PORTFOLIO_ORDER_MISMATCH', 400],
  ['CAREER_NOT_FOUND', 404],
  ['CAREER_LIMIT_REACHED', 409],
  ['PAYOUT_ACCOUNT_LOCKED', 409],
  ['PROJECT_NOT_FOUND', 404],
  ['PROJECT_TERMS_LOCKED', 400],
  ['PROJECT_HAS_ACTIVE_CONTRACT', 409],
  ['PROJECT_HAS_CONTRACT_RECORD', 409],
  ['PROJECT_STATUS_TRANSITION_INVALID', 400],
  ['REOPEN_BLOCKED_BY_CONTRACT', 409],
  ['PROJECT_NOT_ACCEPTING_APPLICATIONS', 400],
  ['APPLICATION_NOT_FOUND', 404],
  ['APPLICATION_ALREADY_EXISTS', 409],
  ['APPLICATION_ALREADY_PROCESSED', 409],
  ['CONTRACT_ALREADY_EXISTS', 409],
  ['CONTRACT_NOT_FOUND', 404],
  ['CONTRACT_CANCELLED', 409],
  ['CONTRACT_NOT_CANCELLABLE', 409],
  ['CONTRACT_ALREADY_COMPLETED', 400],
  ['CONTRACT_NOT_ACTIVE', 400],
  ['CONTRACT_NOT_COMPLETED', 400],
  ['MANUAL_COMPLETION_REMOVED', 410],
  ['MILESTONE_NOT_FOUND', 404],
  ['MILESTONE_PLAN_INVALID', 400],
  ['MILESTONE_PLAN_LOCKED', 409],
  ['MILESTONE_NOT_AWAITING_SUBMISSION', 409],
  ['MILESTONE_NOT_AWAITING_REVIEW', 409],
  ['PAYMENT_NOT_FOUND', 404],
  ['EARLIER_MILESTONE_UNFUNDED', 400],
  ['MILESTONE_ALREADY_FUNDED', 409],
  ['MILESTONE_REFUNDED', 409],
  ['PAYMENT_ALREADY_PROCESSED', 409],
  ['PAYMENT_AMOUNT_MISMATCH', 400],
  ['PAYMENT_VERIFICATION_FAILED', 400],
  ['PAYMENT_BYPASS_DISABLED', 403],
  ['REVIEWEE_INVALID', 400],
  ['REVIEW_ALREADY_EXISTS', 409],
  ['SETTLEMENT_NOT_FOUND', 404],
  ['NOTIFICATION_NOT_FOUND', 404],
  ['CONVERSATION_NOT_FOUND', 404],
  ['CONVERSATION_CLOSED', 409],
  ['COUNTERPART_INACTIVE', 409],
  ['MESSAGE_NOT_FOUND', 404],
  ['MESSAGE_DELETE_WINDOW_EXPIRED', 409],
  ['PROJECT_NOT_RECRUITING', 409],
];

describe('the error code table', () => {
  it('still has every published code, with the same status', () => {
    for (const [code, status] of PUBLISHED) {
      expect(ERROR_CODES, code).toHaveProperty(code);
      expect(ERROR_CODES[code as keyof typeof ERROR_CODES].status, code).toBe(status);
    }
  });

  it('lists every code in PUBLISHED — append a new one there', () => {
    const published = new Set(PUBLISHED.map(([code]) => code));
    expect(ALL_ERROR_CODES.filter((code) => !published.has(code))).toEqual([]);
  });

  it('names codes in UPPER_SNAKE of at most 40 characters, each with a description', () => {
    for (const code of ALL_ERROR_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*[A-Z0-9]$/);
      expect(code.length).toBeLessThanOrEqual(40);
      expect(ERROR_CODES[code].description.length).toBeGreaterThan(0);
    }
  });

  it('documents every code on some route, except the ones no route can be documented with', () => {
    // Each error response lists its causes as "- `CODE` — <when>".
    const document = JSON.stringify(buildOpenApiDocument().paths);
    // An unmatched path has no operation to document it on; a 500 is never documented.
    const routeless = new Set(['ROUTE_NOT_FOUND', 'INTERNAL_ERROR']);
    const undocumented = ALL_ERROR_CODES.filter((code) => !routeless.has(code) && !document.includes(`- \`${code}\` — `));
    expect(undocumented).toEqual([]);
  });

  it('publishes the whole table as the ErrorCode schema', () => {
    const schema = buildOpenApiDocument().components?.schemas?.ErrorCode as { enum: string[] };
    expect(schema.enum).toEqual(ALL_ERROR_CODES);
  });
});

describe('errorHandler', () => {
  /** A bare app that hands `err` to the real handler. */
  function answer(err: unknown) {
    const app = express();
    app.get('/boom', (_req, _res, next) => next(err));
    app.use(errorHandler);
    return request(app).get('/boom');
  }

  it('answers an AppError with its code, message and status, and no fields', async () => {
    const res = await answer(new AppError('CONTRACT_CANCELLED', 'This contract has been cancelled'));

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'CONTRACT_CANCELLED', message: 'This contract has been cancelled' } });
  });

  it('answers a validation failure with its fields', async () => {
    const res = await answer(new AppError('VALIDATION_FAILED', 'title: Title is required', { fields: [{ path: 'title', code: 'REQUIRED' }] }));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'title: Title is required', fields: [{ path: 'title', code: 'REQUIRED' }] },
    });
  });

  // Other errors carry `code`s of their own. Sending them would leak Prisma's and multer's
  // internals and let callers branch on something that is not part of the API.
  it.each([
    ['a Prisma error', new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`email`)', { code: 'P2002', clientVersion: '5.22.0' })],
    ['a multer error', new multer.MulterError('LIMIT_FILE_SIZE', 'image')],
    ['a Node system error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    // A library error that only carries a 4xx status (Supabase Storage's has a string statusCode)
    // is not trusted to be the caller's fault or to have a message fit to send.
    ['a library error with a 4xx status', Object.assign(new Error('Bucket not found'), { status: 400, statusCode: '404' })],
    ['a thrown string', 'boom'],
  ])('answers %s with the generic 500 and never its own code', async (_label, err) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await answer(err);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' } });
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('request-level errors on the real app', () => {
  it('answers a JSON body over 100KB with 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await api()
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@b.com', password: 'x'.repeat(200 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'request entity too large' } });
  });

  it('answers a body in an unsupported charset with 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const res = await api().post('/api/auth/login').set('Content-Type', 'application/json; charset=latin1').send('{}');

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('answers a path parameter that is not valid percent-encoding with 400 MALFORMED_REQUEST, echoing nothing', async () => {
    const client = await makeClient();

    const res = await authed(client).get('/api/projects/%E0%A4%A');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'MALFORMED_REQUEST', message: 'Request path is malformed' } });
  });

  it('answers an unmatched path with 404 ROUTE_NOT_FOUND', async () => {
    const res = await api().get('/api/__probe');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'ROUTE_NOT_FOUND', message: 'Not found' } });
  });
});
