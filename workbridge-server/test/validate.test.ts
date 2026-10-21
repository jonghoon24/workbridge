import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';

import { errorHandler } from '../src/middlewares/errorHandler';
import { validate } from '../src/middlewares/validate';
import { queryEnum, queryInt, queryString } from '../src/schemas/common';

/**
 * zod validation for expansion routes — BEHAVIOR.md rule 12. Exercised on a small app so the
 * conventions are pinned before any expansion route exists.
 */

const app = express();
app.use(express.json());
app.post(
  '/items/:id',
  validate({
    params: z.object({ id: z.string().uuid() }),
    query: z.object({
      page: queryInt({ min: 1, max: 50, fallback: 1 }),
      cursor: queryInt(),
      status: queryEnum(['OPEN', 'CLOSED'] as const, 'OPEN'),
      q: queryString(),
    }),
    body: z.object({
      title: z.string().min(1),
      items: z.array(z.object({ amount: z.number().int().nonnegative() })).default([]),
    }),
  }),
  (req, res) => res.json({ body: req.body, query: res.locals.query, params: res.locals.params, rawQuery: req.query }),
);
app.post('/list', validate({ body: z.array(z.string()) }), (req, res) => res.json(req.body));
app.use(errorHandler);

const ID = '6f1d1c2e-9b7a-4c55-8f3e-2a1b3c4d5e6f';
const post = (query = '', body: unknown = { title: 't' }) => request(app).post(`/items/${ID}${query}`).send(body as object);

describe('validate()', () => {
  it('passes parsed values through: body on req.body, query and params on res.locals', async () => {
    const res = await post('?page=2&q=react&extra=1', { title: 'Hello', items: [{ amount: 1000 }], ignored: true });

    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ title: 'Hello', items: [{ amount: 1000 }] });
    expect(res.body.query).toEqual({ page: 2, status: 'OPEN', q: 'react' });
    expect(res.body.params).toEqual({ id: ID });
    // `req.query` itself is left as Express parsed it.
    expect(res.body.rawQuery).toEqual({ page: '2', q: 'react', extra: '1' });
  });

  it('reports the first failing field as `<path>: <message>`', async () => {
    const res = await post('', { title: '', items: [{ amount: 1.5 }] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'title: String must contain at least 1 character(s)' } });
  });

  it('uses the dotted path for nested fields', async () => {
    const res = await post('', { title: 'ok', items: [{ amount: 1 }, { amount: 1.5 }] });

    expect(res.body.error.message).toBe('items.1.amount: Expected integer, received float');
  });

  it('reports a missing field as Required', async () => {
    const res = await post('', {});

    expect(res.body.error.message).toBe('title: Required');
  });

  it('uses the bare message when the failure has no path', async () => {
    const res = await request(app).post('/list').send({ not: 'an array' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Expected array, received object');
  });

  it('validates params', async () => {
    const res = await request(app).post('/items/not-a-uuid').send({ title: 't' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('id: Invalid uuid');
  });
});

describe('query conventions (rule 12)', () => {
  it('treats an empty value as absent', async () => {
    const res = await post('?page=&cursor=&status=&q=');

    expect(res.status).toBe(200);
    expect(res.body.query).toEqual({ page: 1, status: 'OPEN' });
  });

  it.each([
    ['?page=1&page=2', 'page: must be a single value'],
    ['?q=a&q=b', 'q: must be a single value'],
    ['?page[x]=1', 'page: must be a single value'],
    ['?page=1.5', 'page: must be an integer'],
    ['?page=2abc', 'page: must be an integer'],
    ['?page=%201', 'page: must be an integer'],
    ['?page=0', 'page: must be at least 1'],
    ['?page=51', 'page: must be at most 50'],
    ['?cursor=-3x', 'cursor: must be an integer'],
    ['?status=ALL', 'status: must be one of OPEN, CLOSED'],
  ])('%s → 400 %j', async (query, message) => {
    const res = await post(query);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message } });
  });

  it('accepts negative integers when no minimum is set', async () => {
    const res = await post('?cursor=-3');

    expect(res.body.query.cursor).toBe(-3);
  });
});
