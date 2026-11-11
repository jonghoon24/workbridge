import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';

import { api, authed } from './helpers/api';
import { prisma } from './helpers/db';
import { makeClient, makeFreelancer, makePortfolioItem } from './helpers/factories';
import { kstMonthString } from '../src/lib/time';
import type { FieldErrorCode } from '../src/lib/errorCodes';
import { invalidBody, invalidBodyFor } from './helpers/errors';

/**
 * Portfolio items. The 401/403 role matrix and the
 * 404-vs-403 ownership rows live in `authorization.test.ts`; the soft-deleted writer in
 * `soft-delete.test.ts`.
 *
 * Supabase is mocked at the SDK (as in `users.test.ts`) so no upload leaves the process.
 */
const { supabaseUpload, supabasePublicUrl } = vi.hoisted(() => ({
  supabaseUpload: vi.fn(),
  supabasePublicUrl: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    storage: {
      from: () => ({ upload: supabaseUpload, getPublicUrl: supabasePublicUrl }),
    },
  }),
}));

const PUBLIC_URL_BASE = 'https://test.supabase.co/storage/v1/object/public/workbridge/';
const PNG = Buffer.from('89504e470d0a1a0a-not-really-a-png', 'utf8');

beforeEach(() => {
  supabaseUpload.mockReset();
  supabasePublicUrl.mockReset();
  supabaseUpload.mockImplementation(async (path: string) => ({ data: { path }, error: null }));
  supabasePublicUrl.mockImplementation((path: string) => ({ data: { publicUrl: `${PUBLIC_URL_BASE}${path}` } }));
});

/** The KST month `offset` months from the current one, as `YYYY-MM`. */
function monthFromNow(offset: number): string {
  const [year, month] = kstMonthString(new Date()).split('-').map(Number);
  const index = year * 12 + month - 1 + offset;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

const post = (user: User, body: Record<string, unknown>) => authed(user).post('/api/users/me/portfolio').send(body);
const patch = (user: User, id: string, body: Record<string, unknown>) =>
  authed(user).patch(`/api/users/me/portfolio/${id}`).send(body);
const reorder = (user: User, ids: unknown) => authed(user).put('/api/users/me/portfolio/order').send({ ids });

async function fillPortfolio(userId: string, count: number) {
  for (let i = 0; i < count; i += 1) await makePortfolioItem(userId);
}

describe('POST /api/users/me/portfolio', () => {
  it('creates an item from a JSON body and returns the item object with YYYY-MM months', async () => {
    const freelancer = await makeFreelancer();

    const res = await post(freelancer, {
      title: '  쇼핑몰 리뉴얼  ',
      description: '결제 흐름 개편',
      url: 'https://example.com/work',
      role: '프론트엔드 리드',
      skills: ['React', 'PostgreSQL', 'MySQL', 'React'],
      startedAt: '2025-03',
      endedAt: '2025-08',
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      item: {
        id: expect.any(String),
        userId: freelancer.id,
        title: '쇼핑몰 리뉴얼',
        description: '결제 흐름 개편',
        url: 'https://example.com/work',
        imageUrl: null,
        role: '프론트엔드 리드',
        skills: ['React', 'SQL'],
        startedAt: '2025-03',
        endedAt: '2025-08',
        sortOrder: 0,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    });
    const stored = await prisma.portfolioItem.findUniqueOrThrow({ where: { id: res.body.item.id } });
    expect(stored.startedAt?.toISOString()).toBe('2025-02-28T15:00:00.000Z');
    expect(stored.endedAt?.toISOString()).toBe('2025-07-31T15:00:00.000Z');
  });

  it('stores optional text sent empty as null and defaults skills to []', async () => {
    const freelancer = await makeFreelancer();

    const res = await post(freelancer, { title: 'Minimal', description: '', url: '', role: '   ' });

    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({
      description: null,
      url: null,
      role: null,
      skills: [],
      startedAt: null,
      endedAt: null,
    });
  });

  it('accepts multipart with an image stored under portfolio/<uuid>.<ext>', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post('/api/users/me/portfolio')
      .field('title', '이미지 작업')
      .field('skills', 'React, Node.js')
      .attach('image', PNG, { filename: '포트폴리오 이미지.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(supabaseUpload).toHaveBeenCalledTimes(1);
    const key = supabaseUpload.mock.calls[0][0] as string;
    expect(key).toMatch(/^portfolio\/[0-9a-f-]{36}\.png$/);
    expect(res.body.item.imageUrl).toBe(`${PUBLIC_URL_BASE}${key}`);
    expect(res.body.item.skills).toEqual(['React', 'Node.js']);
  });

  it('takes repeated multipart skills fields as a list', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post('/api/users/me/portfolio')
      .field('title', 'Repeated')
      .field('skills', 'React')
      .field('skills', 'PostgreSQL');

    expect(res.status).toBe(201);
    expect(res.body.item.skills).toEqual(['React', 'SQL']);
  });

  const longSkill = 'x'.repeat(51);
  const VALIDATION: { name: string; body: Record<string, unknown>; message: string; code: FieldErrorCode }[] = [
    { name: 'missing title', body: {}, message: 'title: Title is required', code: 'REQUIRED' },
    { name: 'blank title', body: { title: '   ' }, message: 'title: Title is required', code: 'REQUIRED' },
    { name: 'title of 101', body: { title: 'x'.repeat(101) }, message: 'title: Title must be at most 100 characters', code: 'TOO_LARGE' },
    { name: 'description of 2001', body: { title: 't', description: 'x'.repeat(2001) }, message: 'description: Description must be at most 2000 characters', code: 'TOO_LARGE' },
    { name: 'ftp url', body: { title: 't', url: 'ftp://example.com' }, message: 'url: URL must be an http or https URL', code: 'INVALID' },
    { name: 'relative url', body: { title: 't', url: 'example.com' }, message: 'url: URL must be an http or https URL', code: 'INVALID' },
    { name: 'url over 2000', body: { title: 't', url: `https://e.com/${'x'.repeat(2000)}` }, message: 'url: URL must be an http or https URL', code: 'INVALID' },
    { name: 'role of 101', body: { title: 't', role: 'x'.repeat(101) }, message: 'role: Role must be at most 100 characters', code: 'TOO_LARGE' },
    {
      name: '11 skills after normalization',
      body: { title: 't', skills: Array.from({ length: 11 }, (_, i) => `Skill${i}`) },
      message: 'skills: At most 10 skills are allowed', code: 'TOO_LARGE',
    },
    { name: 'a 51-character skill', body: { title: 't', skills: [longSkill] }, message: 'skills: Each skill must be at most 50 characters', code: 'TOO_LARGE' },
    { name: 'month 13', body: { title: 't', startedAt: '2025-13' }, message: 'startedAt: Month must be a YYYY-MM month', code: 'INVALID' },
    { name: 'a full date', body: { title: 't', startedAt: '2025-03-01' }, message: 'startedAt: Month must be a YYYY-MM month', code: 'INVALID' },
    { name: 'a future start', body: { title: 't', startedAt: monthFromNow(1) }, message: 'startedAt: Month cannot be in the future', code: 'TOO_LARGE' },
    {
      name: 'a future end',
      body: { title: 't', startedAt: '2025-01', endedAt: monthFromNow(1) },
      message: 'endedAt: Month cannot be in the future', code: 'TOO_LARGE',
    },
    {
      name: 'an end before the start',
      body: { title: 't', startedAt: '2025-05', endedAt: '2025-04' },
      message: 'endedAt: End month must not be before start month', code: 'CONFLICT',
    },
    { name: 'an end without a start', body: { title: 't', endedAt: '2025-04' }, message: 'endedAt: Start month is required with an end month', code: 'CONFLICT' },
  ];

  it.each(VALIDATION)('400 for $name, with the exact message', async ({ body, message, code }) => {
    const freelancer = await makeFreelancer();

    const res = await post(freelancer, body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual(invalidBodyFor(code, message));
    expect(await prisma.portfolioItem.count()).toBe(0);
  });

  it('400s a year before 1900 on create and update — 0000 never reaches the database', async () => {
    const freelancer = await makeFreelancer();
    const item = await makePortfolioItem(freelancer.id);

    const created = await post(freelancer, { title: 't', startedAt: '0000-01' });
    const old = await post(freelancer, { title: 't', startedAt: '1899-12' });
    const patched = await patch(freelancer, item.id, { startedAt: '0000-01' });
    const career = await authed(freelancer).post('/api/users/me/careers')
      .send({ company: 'C', position: 'P', employmentType: 'FULL_TIME', startDate: '0000-01' });
    const earliest = await post(freelancer, { title: 't', startedAt: '1900-01' });

    expect(created.body).toEqual(invalidBody('startedAt', 'INVALID', 'startedAt: Month must be a YYYY-MM month'));
    expect(old.status).toBe(400);
    expect(patched.body).toEqual(invalidBody('startedAt', 'INVALID', 'startedAt: Month must be a YYYY-MM month'));
    expect(career.body).toEqual(invalidBody('startDate', 'INVALID', 'startDate: Month must be a YYYY-MM month'));
    expect(earliest.status).toBe(201);
  });

  it('allows the current month and an end equal to the start', async () => {
    const freelancer = await makeFreelancer();
    const current = monthFromNow(0);

    const res = await post(freelancer, { title: 't', startedAt: current, endedAt: current });

    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({ startedAt: current, endedAt: current });
  });

  it('counts the 10-skill limit after de-duplication through SKILL_ALIASES', async () => {
    const freelancer = await makeFreelancer();
    const skills = [...Array.from({ length: 9 }, (_, i) => `Skill${i}`), 'PostgreSQL', 'MySQL', 'SQL'];

    const res = await post(freelancer, { title: 't', skills });

    expect(res.status).toBe(201);
    expect(res.body.item.skills).toHaveLength(10);
  });

  it.each([
    ['a non-string skill', { title: 't', skills: [1, 2] }, 'skills: '],
    ['a non-string title', { title: 42 }, 'title: '],
    ['a non-string month', { title: 't', startedAt: 202503 }, 'startedAt: '],
  ])('400 for %s, never a 500 — only the path prefix is asserted', async (_name, body, prefix) => {
    const freelancer = await makeFreelancer();

    const res = await post(freelancer, body);

    expect(res.status).toBe(400);
    expect(res.body.error.message.startsWith(prefix)).toBe(true);
  });

  it('gives the first item sortOrder 0 and later ones the highest + 1, gaps kept', async () => {
    const freelancer = await makeFreelancer();
    await makePortfolioItem(freelancer.id, { sortOrder: 0 });
    await makePortfolioItem(freelancer.id, { sortOrder: 7 });

    const res = await post(freelancer, { title: 'Next' });

    expect(res.body.item.sortOrder).toBe(8);
  });

  it('409s at 20 items before storing the image', async () => {
    const freelancer = await makeFreelancer();
    await fillPortfolio(freelancer.id, 20);

    const res = await authed(freelancer)
      .post('/api/users/me/portfolio')
      .field('title', 'One too many')
      .attach('image', PNG, { filename: 'a.png', contentType: 'image/png' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'PORTFOLIO_LIMIT_REACHED', message: 'Portfolio is limited to 20 items' } });
    expect(supabaseUpload).not.toHaveBeenCalled();
    expect(await prisma.portfolioItem.count({ where: { userId: freelancer.id } })).toBe(20);
  });

  it('serializes concurrent creates on the user row: two at 19 items end at 20 and one 409', async () => {
    const freelancer = await makeFreelancer();
    await fillPortfolio(freelancer.id, 19);

    const results = await Promise.all([post(freelancer, { title: 'A' }), post(freelancer, { title: 'B' })]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const items = await prisma.portfolioItem.findMany({ where: { userId: freelancer.id } });
    expect(items).toHaveLength(20);
    expect(new Set(items.map((item) => item.sortOrder)).size).toBe(20);
  });

  it('answers 502 and writes nothing when storage fails', async () => {
    const freelancer = await makeFreelancer();
    supabaseUpload.mockResolvedValueOnce({ data: null, error: new Error('bucket offline') });

    const res = await authed(freelancer)
      .post('/api/users/me/portfolio')
      .field('title', 'Upload fails')
      .attach('image', PNG, { filename: 'a.png', contentType: 'image/png' });

    expect(res.status).toBe(502);
    expect(await prisma.portfolioItem.count()).toBe(0);
  });

  it('applies the image upload policy: 413 over 5 MB, 400 for a non-image, nothing stored', async () => {
    const freelancer = await makeFreelancer();

    const big = await authed(freelancer)
      .post('/api/users/me/portfolio')
      .field('title', 'Big')
      .attach('image', Buffer.alloc(5 * 1024 * 1024 + 1), { filename: 'big.png', contentType: 'image/png' });
    const pdf = await authed(freelancer)
      .post('/api/users/me/portfolio')
      .field('title', 'Pdf')
      .attach('image', Buffer.from('%PDF-1.4'), { filename: 'doc.pdf', contentType: 'application/pdf' });

    expect(big.status).toBe(413);
    expect(pdf.status).toBe(400);
    expect(supabaseUpload).not.toHaveBeenCalled();
    expect(await prisma.portfolioItem.count()).toBe(0);
  });

  it('checks the role before the upload policy and validation', async () => {
    const client = await makeClient();

    const res = await authed(client)
      .post('/api/users/me/portfolio')
      .attach('image', Buffer.from('%PDF-1.4'), { filename: 'doc.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: 'FORBIDDEN_ROLE', message: 'Insufficient permissions' } });
  });

  it('checks the upload policy before validation', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .post('/api/users/me/portfolio')
      .attach('image', Buffer.from('%PDF-1.4'), { filename: 'doc.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).not.toMatch(/^title:/);
  });
});

describe('PATCH /api/users/me/portfolio/:itemId', () => {
  it('changes only the fields present and clears optional ones sent empty', async () => {
    const freelancer = await makeFreelancer();
    const item = await makePortfolioItem(freelancer.id, {
      title: 'Before',
      description: 'keep me?',
      url: 'https://before.example.com',
      skills: ['React'],
    });

    const res = await patch(freelancer, item.id, { description: '', skills: 'Vue.js, MySQL' });

    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      id: item.id,
      title: 'Before',
      description: null,
      url: 'https://before.example.com',
      skills: ['Vue.js', 'SQL'],
      sortOrder: item.sortOrder,
    });
  });

  it('cannot clear the title', async () => {
    const freelancer = await makeFreelancer();
    const item = await makePortfolioItem(freelancer.id);

    const res = await patch(freelancer, item.id, { title: '' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(invalidBody('title', 'REQUIRED', 'title: Title is required'));
  });

  it('replaces the image, keeping the old file in storage', async () => {
    const freelancer = await makeFreelancer();
    const item = await makePortfolioItem(freelancer.id, { imageUrl: `${PUBLIC_URL_BASE}portfolio/old.png` });

    const res = await authed(freelancer)
      .patch(`/api/users/me/portfolio/${item.id}`)
      .attach('image', PNG, { filename: 'new.webp', contentType: 'image/webp' });

    expect(res.status).toBe(200);
    expect(res.body.item.imageUrl).toMatch(/portfolio\/[0-9a-f-]{36}\.webp$/);
    expect(supabaseUpload).toHaveBeenCalledTimes(1);
  });

  it('removeImage=true clears imageUrl; "false" leaves it', async () => {
    const freelancer = await makeFreelancer();
    const item = await makePortfolioItem(freelancer.id, { imageUrl: `${PUBLIC_URL_BASE}portfolio/old.png` });

    const kept = await authed(freelancer).patch(`/api/users/me/portfolio/${item.id}`).field('removeImage', 'false');
    const removed = await authed(freelancer).patch(`/api/users/me/portfolio/${item.id}`).field('removeImage', 'true');

    expect(kept.body.item.imageUrl).toBe(`${PUBLIC_URL_BASE}portfolio/old.png`);
    expect(removed.status).toBe(200);
    expect(removed.body.item.imageUrl).toBeNull();
  });

  it('400s an image together with removeImage=true — validation, so even for a missing item', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .patch('/api/users/me/portfolio/missing-item-id')
      .field('removeImage', 'true')
      .attach('image', PNG, { filename: 'a.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(invalidBody('removeImage', 'CONFLICT', 'removeImage: Cannot upload and remove an image at once'));
    expect(supabaseUpload).not.toHaveBeenCalled();
  });

  it('400s a removeImage that is not true/false', async () => {
    const freelancer = await makeFreelancer();
    const item = await makePortfolioItem(freelancer.id);

    const res = await patch(freelancer, item.id, { removeImage: 'yes' });

    expect(res.status).toBe(400);
    expect(res.body.error.message.startsWith('removeImage: ')).toBe(true);
  });

  it('checks the month order on the stored row merged with the patch', async () => {
    const freelancer = await makeFreelancer();
    const item = await makePortfolioItem(freelancer.id);
    expect((await patch(freelancer, item.id, { startedAt: '2024-05', endedAt: '2024-09' })).status).toBe(200);

    const before = await patch(freelancer, item.id, { endedAt: '2024-04' });
    const noStart = await patch(freelancer, item.id, { startedAt: '' });
    const fine = await patch(freelancer, item.id, { startedAt: '2024-09' });

    expect(before.status).toBe(400);
    expect(before.body).toEqual(invalidBody('endedAt', 'CONFLICT', 'endedAt: End month must not be before start month'));
    expect(noStart.status).toBe(400);
    expect(noStart.body).toEqual(invalidBody('endedAt', 'CONFLICT', 'endedAt: Start month is required with an end month'));
    expect(fine.status).toBe(200);
    expect(fine.body.item).toMatchObject({ startedAt: '2024-09', endedAt: '2024-09' });
  });

  it('orders its checks validation → existence → ownership → merged month order', async () => {
    const owner = await makeFreelancer();
    const intruder = await makeFreelancer();
    const item = await makePortfolioItem(owner.id, { startedAt: new Date('2024-04-30T15:00:00.000Z') });

    const invalidOnMissing = await patch(intruder, 'missing-item-id', { title: '' });
    const validOnMissing = await patch(intruder, 'missing-item-id', { title: 'ok' });
    const badOrderOnForeign = await patch(intruder, item.id, { endedAt: '2024-01' });

    expect(invalidOnMissing.status).toBe(400);
    expect(validOnMissing.status).toBe(404);
    expect(validOnMissing.body).toEqual({ error: { code: 'PORTFOLIO_ITEM_NOT_FOUND', message: 'Portfolio item not found' } });
    expect(badOrderOnForeign.status).toBe(403);
    expect(badOrderOnForeign.body).toEqual({ error: { code: 'FORBIDDEN_RESOURCE', message: 'Not authorized' } });
  });
});

describe('DELETE /api/users/me/portfolio/:itemId', () => {
  it('hard-deletes, keeps the others\' sortOrder, then 404s', async () => {
    const freelancer = await makeFreelancer();
    const [a, b, c] = [
      await makePortfolioItem(freelancer.id),
      await makePortfolioItem(freelancer.id),
      await makePortfolioItem(freelancer.id),
    ];

    const res = await authed(freelancer).delete(`/api/users/me/portfolio/${b.id}`);
    const again = await authed(freelancer).delete(`/api/users/me/portfolio/${b.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: b.id, deleted: true });
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ error: { code: 'PORTFOLIO_ITEM_NOT_FOUND', message: 'Portfolio item not found' } });
    const left = await prisma.portfolioItem.findMany({ where: { userId: freelancer.id }, orderBy: { sortOrder: 'asc' } });
    expect(left.map((item) => [item.id, item.sortOrder])).toEqual([[a.id, a.sortOrder], [c.id, c.sortOrder]]);
  });
});

describe('PUT /api/users/me/portfolio/order', () => {
  it('sets each sortOrder to its 0-based position and returns the items in that order', async () => {
    const freelancer = await makeFreelancer();
    const items = [
      await makePortfolioItem(freelancer.id, { sortOrder: 4 }),
      await makePortfolioItem(freelancer.id, { sortOrder: 9 }),
      await makePortfolioItem(freelancer.id, { sortOrder: 11 }),
    ];
    const ids = [items[2].id, items[0].id, items[1].id];

    const res = await reorder(freelancer, ids);

    expect(res.status).toBe(200);
    expect(res.body.items.map((item: { id: string; sortOrder: number }) => [item.id, item.sortOrder]))
      .toEqual([[ids[0], 0], [ids[1], 1], [ids[2], 2]]);
    const publicList = await api().get(`/api/users/${freelancer.id}/portfolio`);
    expect(publicList.body.items.map((item: { id: string }) => item.id)).toEqual(ids);
  });

  it('accepts an empty list for a caller with no items', async () => {
    const freelancer = await makeFreelancer();

    const res = await reorder(freelancer, []);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('400s anything but a permutation of the caller\'s items, changing nothing', async () => {
    const freelancer = await makeFreelancer();
    const other = await makeFreelancer();
    const a = await makePortfolioItem(freelancer.id);
    const b = await makePortfolioItem(freelancer.id);
    const foreign = await makePortfolioItem(other.id);

    const cases = [[a.id], [a.id, a.id], [a.id, b.id, 'unknown-id'], [a.id, foreign.id], [b.id, a.id, a.id]];
    for (const ids of cases) {
      const res = await reorder(freelancer, ids);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { code: 'PORTFOLIO_ORDER_MISMATCH', message: 'ids: Must list each of your portfolio items exactly once' } });
    }
    const stored = await prisma.portfolioItem.findMany({ where: { userId: freelancer.id }, orderBy: { sortOrder: 'asc' } });
    expect(stored.map((item) => item.id)).toEqual([a.id, b.id]);
  });

  it.each([
    ['ids missing', undefined],
    ['ids a string', 'abc'],
    ['ids of numbers', [1, 2]],
  ])('400s %s', async (_name, ids) => {
    const freelancer = await makeFreelancer();

    const res = await reorder(freelancer, ids);

    expect(res.status).toBe(400);
    expect(res.body.error.message.startsWith('ids')).toBe(true);
  });

  it('never interleaves with a delete: no 500, and the final order is consistent', async () => {
    for (let round = 0; round < 5; round += 1) {
      const freelancer = await makeFreelancer();
      const items = [
        await makePortfolioItem(freelancer.id),
        await makePortfolioItem(freelancer.id),
        await makePortfolioItem(freelancer.id),
      ];
      const reversed = items.map((item) => item.id).reverse();

      const [order, removal] = await Promise.all([
        reorder(freelancer, reversed),
        authed(freelancer).delete(`/api/users/me/portfolio/${items[1].id}`),
      ]);

      expect(removal.status).toBe(200);
      // Either the reorder ran first (200, then the delete) or saw the item gone (400).
      expect([200, 400]).toContain(order.status);
      const left = await prisma.portfolioItem.findMany({ where: { userId: freelancer.id }, orderBy: { sortOrder: 'asc' } });
      expect(left.map((item) => item.id)).toEqual(
        order.status === 200 ? [items[2].id, items[0].id] : [items[0].id, items[2].id],
      );
    }
  });
});

describe('GET /api/users/:id/portfolio', () => {
  it('is public and lists in display order: sortOrder asc, then createdAt desc, then id asc', async () => {
    const freelancer = await makeFreelancer();
    const late = await makePortfolioItem(freelancer.id, { sortOrder: 1, createdAt: new Date('2025-01-02T00:00:00Z') });
    const early = await makePortfolioItem(freelancer.id, { sortOrder: 1, createdAt: new Date('2025-01-01T00:00:00Z') });
    const first = await makePortfolioItem(freelancer.id, { sortOrder: 0 });
    const tieA = await makePortfolioItem(freelancer.id, { sortOrder: 2, createdAt: new Date('2025-01-01T00:00:00Z') });
    const tieB = await makePortfolioItem(freelancer.id, { sortOrder: 2, createdAt: new Date('2025-01-01T00:00:00Z') });
    const [lowId, highId] = [tieA.id, tieB.id].sort();

    const res = await api().get(`/api/users/${freelancer.id}/portfolio`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((item: { id: string }) => item.id)).toEqual([first.id, late.id, early.id, lowId, highId]);
  });

  it('is [] for a CLIENT and 404 for an unknown user, for "me" and for a soft-deleted user', async () => {
    const client = await makeClient();
    const gone = await makeFreelancer({ deletedAt: new Date() });
    await makePortfolioItem(gone.id);

    const clientList = await api().get(`/api/users/${client.id}/portfolio`);
    const unknown = await api().get('/api/users/missing-user-id/portfolio');
    const me = await authed(client).get('/api/users/me/portfolio');
    const deleted = await api().get(`/api/users/${gone.id}/portfolio`);

    expect(clientList.status).toBe(200);
    expect(clientList.body).toEqual({ items: [] });
    for (const res of [unknown, me, deleted]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    }
    // Kept, only invisible.
    expect(await prisma.portfolioItem.count({ where: { userId: gone.id } })).toBe(1);
  });
});
