import { describe, expect, it } from 'vitest';
import type { User } from '@prisma/client';

import { api, authed } from './helpers/api';
import { prisma } from './helpers/db';
import { makeClient, makeFreelancer, makeCareer } from './helpers/factories';
import { kstMonthString, kstMonthToDate } from '../src/lib/time';

/**
 * Career entries. Role and
 * ownership rows live in `authorization.test.ts`; the soft-deleted writer in `soft-delete.test.ts`.
 */

/** The KST month `offset` months from the current one, as `YYYY-MM`. */
function monthFromNow(offset: number): string {
  const [year, month] = kstMonthString(new Date()).split('-').map(Number);
  const index = year * 12 + month - 1 + offset;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

const VALID = { company: '코드잇', position: '백엔드 개발자', employmentType: 'FULL_TIME', startDate: '2021-03' };

const post = (user: User, body: Record<string, unknown>) => authed(user).post('/api/users/me/careers').send(body);
const patch = (user: User, id: string, body: Record<string, unknown>) =>
  authed(user).patch(`/api/users/me/careers/${id}`).send(body);

/** A career stored with months given as `YYYY-MM` (stored as the first instant of the month in KST). */
function career(userId: string, start: string, end: string | null, extra: Record<string, unknown> = {}) {
  return makeCareer(userId, {
    startDate: kstMonthToDate(start),
    endDate: end === null ? null : kstMonthToDate(end),
    ...extra,
  });
}

describe('POST /api/users/me/careers', () => {
  it('creates an entry and returns the career object with YYYY-MM months', async () => {
    const freelancer = await makeFreelancer();

    const res = await post(freelancer, { ...VALID, endDate: '2023-12', description: '  결제 시스템  ' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      career: {
        id: expect.any(String),
        userId: freelancer.id,
        company: '코드잇',
        position: '백엔드 개발자',
        employmentType: 'FULL_TIME',
        startDate: '2021-03',
        endDate: '2023-12',
        description: '결제 시스템',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    });
    const stored = await prisma.career.findUniqueOrThrow({ where: { id: res.body.career.id } });
    expect(stored.startDate.toISOString()).toBe('2021-02-28T15:00:00.000Z');
    expect(stored.endDate?.toISOString()).toBe('2023-11-30T15:00:00.000Z');
  });

  it.each([
    ['absent', {}],
    ['null', { endDate: null }],
    ['empty', { endDate: '' }],
  ])('treats an endDate that is %s as a current position; several may coexist', async (_name, extra) => {
    const freelancer = await makeFreelancer();
    await career(freelancer.id, '2020-01', null);

    const res = await post(freelancer, { ...VALID, ...extra });

    expect(res.status).toBe(201);
    expect(res.body.career.endDate).toBeNull();
    expect(res.body.career.description).toBeNull();
    expect(await prisma.career.count({ where: { userId: freelancer.id, endDate: null } })).toBe(2);
  });

  const VALIDATION: { name: string; body: Record<string, unknown>; message: string }[] = [
    { name: 'missing company', body: { ...VALID, company: undefined }, message: 'company: Company is required' },
    { name: 'blank company', body: { ...VALID, company: '  ' }, message: 'company: Company is required' },
    { name: 'company of 101', body: { ...VALID, company: 'x'.repeat(101) }, message: 'company: Company must be at most 100 characters' },
    { name: 'missing position', body: { ...VALID, position: undefined }, message: 'position: Position is required' },
    { name: 'position of 101', body: { ...VALID, position: 'x'.repeat(101) }, message: 'position: Position must be at most 100 characters' },
    { name: 'startDate month 00', body: { ...VALID, startDate: '2021-00' }, message: 'startDate: Month must be a YYYY-MM month' },
    { name: 'a future startDate', body: { ...VALID, startDate: monthFromNow(1) }, message: 'startDate: Month cannot be in the future' },
    { name: 'a future endDate', body: { ...VALID, endDate: monthFromNow(2) }, message: 'endDate: Month cannot be in the future' },
    { name: 'an endDate before the start', body: { ...VALID, endDate: '2021-02' }, message: 'endDate: End month must not be before start month' },
    { name: 'description of 2001', body: { ...VALID, description: 'x'.repeat(2001) }, message: 'description: Description must be at most 2000 characters' },
  ];

  it.each(VALIDATION)('400 for $name, with the exact message', async ({ body, message }) => {
    const freelancer = await makeFreelancer();

    const res = await post(freelancer, body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message } });
    expect(await prisma.career.count()).toBe(0);
  });

  it.each([
    ['an unknown employmentType', { ...VALID, employmentType: 'PART_TIME' }],
    ['a missing employmentType', { ...VALID, employmentType: undefined }],
    ['a non-string employmentType', { ...VALID, employmentType: 3 }],
  ])('400 for %s with one sentence naming the allowed values', async (_name, body) => {
    const freelancer = await makeFreelancer();

    const res = await post(freelancer, body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { message: 'employmentType: Employment type must be one of FULL_TIME, CONTRACT, FREELANCE, INTERN' },
    });
    expect(await prisma.career.count()).toBe(0);
  });

  it.each([
    ['an unknown employmentType', { ...VALID, employmentType: 'PART_TIME' }, 'employmentType: '],
    ['a missing employmentType', { ...VALID, employmentType: undefined }, 'employmentType: '],
    ['a missing startDate', { ...VALID, startDate: undefined }, 'startDate: '],
    ['a non-string company', { ...VALID, company: 7 }, 'company: '],
  ])('400 for %s — path prefix asserted', async (_name, body, prefix) => {
    const freelancer = await makeFreelancer();

    const res = await post(freelancer, body);

    expect(res.status).toBe(400);
    expect(res.body.error.message.startsWith(prefix)).toBe(true);
  });

  it('accepts a start and end in the same month, the current month included', async () => {
    const freelancer = await makeFreelancer();
    const current = monthFromNow(0);

    const res = await post(freelancer, { ...VALID, startDate: current, endDate: current });

    expect(res.status).toBe(201);
  });

  it('409s at 30 entries', async () => {
    const freelancer = await makeFreelancer();
    for (let i = 0; i < 30; i += 1) await makeCareer(freelancer.id);

    const res = await post(freelancer, VALID);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { message: 'Careers are limited to 30 entries' } });
  });

  it('serializes concurrent creates on the user row: two at 29 end at 30 and one 409', async () => {
    const freelancer = await makeFreelancer();
    for (let i = 0; i < 29; i += 1) await makeCareer(freelancer.id);

    const results = await Promise.all([post(freelancer, VALID), post(freelancer, VALID)]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.career.count({ where: { userId: freelancer.id } })).toBe(30);
  });
});

describe('PATCH /api/users/me/careers/:careerId', () => {
  it('changes only the fields present; endDate null or "" makes the position current', async () => {
    const freelancer = await makeFreelancer();
    const entry = await career(freelancer.id, '2020-01', '2021-12', { description: 'old' });

    const renamed = await patch(freelancer, entry.id, { position: 'Tech Lead', description: '' });
    const current = await patch(freelancer, entry.id, { endDate: '' });
    const ended = await patch(freelancer, entry.id, { endDate: '2022-06' });
    const nulled = await patch(freelancer, entry.id, { endDate: null });

    expect(renamed.status).toBe(200);
    expect(renamed.body.career).toMatchObject({
      company: entry.company,
      position: 'Tech Lead',
      description: null,
      startDate: '2020-01',
      endDate: '2021-12',
    });
    expect(current.body.career.endDate).toBeNull();
    expect(ended.body.career.endDate).toBe('2022-06');
    expect(nulled.body.career.endDate).toBeNull();
  });

  it('cannot clear a required field', async () => {
    const freelancer = await makeFreelancer();
    const entry = await makeCareer(freelancer.id);

    const res = await patch(freelancer, entry.id, { company: '' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'company: Company is required' } });
  });

  it('checks the month order on the merged row, after existence and ownership', async () => {
    const owner = await makeFreelancer();
    const intruder = await makeFreelancer();
    const entry = await career(owner.id, '2022-05', '2023-01');

    const before = await patch(owner, entry.id, { endDate: '2022-04' });
    const startAfterEnd = await patch(owner, entry.id, { startDate: '2023-02' });
    const onForeign = await patch(intruder, entry.id, { endDate: '2022-04' });
    const invalidOnMissing = await patch(intruder, 'missing-career-id', { startDate: '2023-13' });
    const validOnMissing = await patch(intruder, 'missing-career-id', { startDate: '2023-01' });

    for (const res of [before, startAfterEnd]) {
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: 'endDate: End month must not be before start month' } });
    }
    expect(onForeign.status).toBe(403);
    expect(invalidOnMissing.status).toBe(400);
    expect(validOnMissing.status).toBe(404);
    expect(validOnMissing.body).toEqual({ error: { message: 'Career not found' } });
  });
});

describe('DELETE /api/users/me/careers/:careerId', () => {
  it('hard-deletes, then 404s', async () => {
    const freelancer = await makeFreelancer();
    const entry = await makeCareer(freelancer.id);

    const res = await authed(freelancer).delete(`/api/users/me/careers/${entry.id}`);
    const again = await authed(freelancer).delete(`/api/users/me/careers/${entry.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: entry.id, deleted: true });
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ error: { message: 'Career not found' } });
    expect(await prisma.career.count()).toBe(0);
  });
});

describe('GET /api/users/:id/careers', () => {
  it('is public and lists in display order: start desc, current first, end desc, createdAt desc, id asc', async () => {
    const freelancer = await makeFreelancer();
    const oldest = await career(freelancer.id, '2018-01', '2019-01');
    const endedEarly = await career(freelancer.id, '2021-01', '2021-06');
    const endedLate = await career(freelancer.id, '2021-01', '2022-06');
    const current = await career(freelancer.id, '2021-01', null);
    const newer = await career(freelancer.id, '2021-01', '2021-06', { createdAt: new Date(Date.now() + 1000) });
    const latest = await career(freelancer.id, '2023-01', '2023-02');

    const res = await api().get(`/api/users/${freelancer.id}/careers`);

    expect(res.status).toBe(200);
    expect(res.body.careers.map((c: { id: string }) => c.id))
      .toEqual([latest.id, current.id, endedLate.id, newer.id, endedEarly.id, oldest.id]);
  });

  it('returns careerSummary with overlapping and adjacent ranges merged (2020-01–2021-06 plus 2021-03–2022-02 is 26 months)', async () => {
    const freelancer = await makeFreelancer();
    await career(freelancer.id, '2020-01', '2021-06');
    await career(freelancer.id, '2021-03', '2022-02');

    const res = await api().get(`/api/users/${freelancer.id}/careers`);

    expect(res.body.careerSummary).toEqual({ totalMonths: 26, years: 2, months: 2 });
    // Display only: experienceYears is untouched.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } })).experienceYears).toBe(3);
  });

  it('counts a current position through the current KST month', async () => {
    const freelancer = await makeFreelancer();
    await career(freelancer.id, monthFromNow(-2), null);

    const res = await api().get(`/api/users/${freelancer.id}/careers`);

    expect(res.body.careerSummary).toEqual({ totalMonths: 3, years: 0, months: 3 });
  });

  it('is all zero with no entries, and 404 for unknown, "me" and soft-deleted users', async () => {
    const client = await makeClient();
    const gone = await makeFreelancer({ deletedAt: new Date() });
    await makeCareer(gone.id);

    const empty = await api().get(`/api/users/${client.id}/careers`);
    const unknown = await api().get('/api/users/missing-user-id/careers');
    const me = await authed(client).get('/api/users/me/careers');
    const deleted = await api().get(`/api/users/${gone.id}/careers`);

    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ careers: [], careerSummary: { totalMonths: 0, years: 0, months: 0 } });
    for (const res of [unknown, me, deleted]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { message: 'User not found' } });
    }
    expect(await prisma.career.count({ where: { userId: gone.id } })).toBe(1);
  });
});
