import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

import { AppError } from '../src/lib/errors';
import { logger, serializeError } from '../src/lib/logger';
import { runWithContext } from '../src/lib/requestContext';

/** The JSON-line logger. */

afterEach(() => {
  process.env.LOG_LEVEL = 'error';
  vi.restoreAllMocks();
});

function spies() {
  return {
    out: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    err: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  };
}

const lineOf = (spy: { mock: { calls: unknown[][] } }, i = 0) => JSON.parse(String(spy.mock.calls[i][0]));

describe('serializeError', () => {
  it('spells out the non-enumerable fields JSON.stringify would drop', () => {
    const err = new TypeError('boom');

    expect(JSON.stringify(err)).toBe('{}');
    expect(serializeError(err)).toEqual({ name: 'TypeError', message: 'boom', stack: err.stack });
  });

  it('keeps an AppError\'s code and statusCode', () => {
    expect(serializeError(new AppError('CONTRACT_CANCELLED', 'nope'))).toMatchObject({
      name: 'AppError',
      message: 'nope',
      code: 'CONTRACT_CANCELLED',
      statusCode: 409,
    });
  });

  it('keeps a Prisma error\'s code and meta', () => {
    const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '5.22.0',
      meta: { target: ['email'] },
    });

    expect(serializeError(err)).toMatchObject({
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      meta: { target: ['email'] },
      message: 'Unique constraint failed',
    });
  });

  it('serializes error-shaped objects that are not Error instances, and nested causes', () => {
    const storageError = { message: 'Bucket not found', statusCode: '404', stack: 'at storage' };
    const wrapped = new Error('upload failed', { cause: storageError });

    expect(serializeError(storageError)).toMatchObject({ message: 'Bucket not found', statusCode: '404' });
    expect(serializeError(wrapped).cause).toMatchObject({ message: 'Bucket not found' });
  });

  it('survives a cause chain that loops back on itself', () => {
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;

    expect(serializeError(err)).toMatchObject({ message: 'loop', cause: '[Circular]' });
  });

  it('turns a non-error into a message', () => {
    expect(serializeError('just a string')).toEqual({ message: 'just a string' });
  });
});

describe('logger', () => {
  it('writes one JSON line with time, level and msg; error-valued fields are serialized', () => {
    process.env.LOG_LEVEL = 'debug';
    const { err } = spies();

    logger.error('something broke', { err: new Error('kaput'), attempt: 2 });

    expect(err).toHaveBeenCalledTimes(1);
    const line = lineOf(err);
    expect(line).toMatchObject({ level: 'error', msg: 'something broke', attempt: 2, err: { name: 'Error', message: 'kaput' } });
    expect(new Date(line.time).toISOString()).toBe(line.time);
  });

  it('sends only error to console.error, everything else to console.log', () => {
    process.env.LOG_LEVEL = 'debug';
    const { out, err } = spies();

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(out.mock.calls.map((_, i) => lineOf(out, i).level)).toEqual(['debug', 'info', 'warn']);
    expect(err.mock.calls.map((_, i) => lineOf(err, i).level)).toEqual(['error']);
  });

  it.each([
    ['warn', ['warn', 'error']],
    ['error', ['error']],
    ['silent', []],
    ['nonsense', ['info', 'warn', 'error']],
  ])('LOG_LEVEL=%s lets through %j', (level, expected) => {
    process.env.LOG_LEVEL = level;
    const { out, err } = spies();

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    const levels = [
      ...out.mock.calls.map((_, i) => lineOf(out, i).level),
      ...err.mock.calls.map((_, i) => lineOf(err, i).level),
    ];
    expect(levels).toEqual(expected);
  });

  it('stamps requestId and jobId from the async context', async () => {
    process.env.LOG_LEVEL = 'info';
    const { out } = spies();

    await runWithContext({ requestId: 'req-1', jobId: 'job-1' }, async () => {
      await Promise.resolve();
      logger.info('inside');
    });
    logger.info('outside');

    expect(lineOf(out, 0)).toMatchObject({ msg: 'inside', requestId: 'req-1', jobId: 'job-1' });
    expect(lineOf(out, 1)).not.toHaveProperty('requestId');
  });

  it('does not mistake a domain object with a `message` for an error', () => {
    process.env.LOG_LEVEL = 'info';
    const { out } = spies();
    const notification = { id: 'n1', title: '제목', message: 'body', readAt: null };

    logger.info('notified', { notification });

    expect(lineOf(out).notification).toEqual(notification);
  });

  it('logs an error whose cause is itself without throwing', () => {
    const { err } = spies();
    const loop = new Error('loop') as Error & { cause?: unknown };
    loop.cause = loop;

    logger.error('looped', { err: loop });

    expect(lineOf(err).err).toMatchObject({ message: 'loop', cause: '[Circular]' });
  });

  it('prints an object referenced twice side by side, not as a cycle', () => {
    process.env.LOG_LEVEL = 'info';
    const { out } = spies();
    const shared = { a: 1 };

    logger.info('twice', { left: shared, right: shared });

    expect(lineOf(out)).toMatchObject({ left: { a: 1 }, right: { a: 1 } });
  });

  it('survives circular fields and BigInt', () => {
    process.env.LOG_LEVEL = 'info';
    const { out } = spies();
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    logger.info('odd fields', { circular, big: BigInt(10) });

    expect(lineOf(out)).toMatchObject({ circular: { a: 1, self: '[Circular]' }, big: '10' });
  });
});
