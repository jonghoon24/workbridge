import type { Role } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

import { uploadToSupabase } from '../src/middlewares/upload';
import { api, authed, tokenFor } from './helpers/api';
import { prisma } from './helpers/db';
import {
  daysFromNow,
  makeApplication,
  makeCareer,
  makeClient,
  makeContract,
  makeFreelancer,
  makePortfolioItem,
  makeProject,
} from './helpers/factories';

/**
 * The Supabase boundary is mocked at the SDK, not at `src/middlewares/upload`, because that
 * module also exports the multer instance `users.routes` needs — replacing the module would
 * break the route. Mocking `createClient` leaves multer untouched while making a network call
 * impossible: no real client is ever constructed.
 */
const { supabaseUpload, supabasePublicUrl } = vi.hoisted(() => ({
  supabaseUpload: vi.fn(),
  supabasePublicUrl: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        upload: supabaseUpload,
        getPublicUrl: supabasePublicUrl,
      }),
    },
  }),
}));

const PUBLIC_URL_BASE = 'https://test.supabase.co/storage/v1/object/public/workbridge/';

beforeEach(() => {
  supabaseUpload.mockReset();
  supabasePublicUrl.mockReset();
  supabaseUpload.mockImplementation(async (path: string) => ({ data: { path }, error: null }));
  supabasePublicUrl.mockImplementation((path: string) => ({
    data: { publicUrl: `${PUBLIC_URL_BASE}${path}` },
  }));
});

const PNG = Buffer.from('89504e470d0a1a0a-not-really-a-png', 'utf8');

/** Reviews need a contract, and a contract needs a project and an application behind it. */
async function makeCompletedContract(clientId: string, freelancerId: string) {
  const project = await makeProject(clientId, { status: 'COMPLETED' });
  const application = await makeApplication(project.id, freelancerId, { status: 'ACCEPTED' });
  return makeContract(
    { projectId: project.id, applicationId: application.id, clientId, freelancerId },
    { status: 'COMPLETED' },
  );
}

function makeReview(args: {
  contractId: string;
  reviewerId: string;
  revieweeId: string;
  rating: number;
  content?: string;
  tags?: string[];
  createdAt?: Date;
}) {
  const { content = '좋은 협업이었습니다.', tags = ['성실함'], ...rest } = args;
  return prisma.review.create({ data: { content, tags, ...rest } });
}

describe('GET /api/users/me', () => {
  it('returns the caller\'s own profile including the private email field', async () => {
    const freelancer = await makeFreelancer({ bio: '백엔드 개발자' });

    const res = await authed(freelancer).get('/api/users/me');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: freelancer.id,
      email: freelancer.email,
      name: freelancer.name,
      role: 'FREELANCER',
      bio: '백엔드 개발자',
      skills: ['React', 'Node.js'],
      activityCategory: '웹 개발',
      experienceYears: 3,
      hourlyRate: 50_000,
    });
  });

  it('never exposes the password hash or deletedAt', async () => {
    const client = await makeClient();

    const res = await authed(client).get('/api/users/me');

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('password');
    expect(res.body).not.toHaveProperty('deletedAt');
  });

  it('tells whether the account has a password without exposing it', async () => {
    const withPassword = await makeFreelancer();
    const googleOnly = await makeFreelancer({ password: null, googleId: 'google-only-uid' });

    const first = await authed(withPassword).get('/api/users/me');
    const second = await authed(googleOnly).get('/api/users/me');

    expect(first.body.hasPassword).toBe(true);
    expect(second.body.hasPassword).toBe(false);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: withPassword.id } });
    expect(JSON.stringify(first.body)).not.toContain(stored.password);
  });

  it('404s when the record behind a still-valid token is gone', async () => {
    const user = await makeFreelancer();
    const token = tokenFor(user);
    await prisma.user.delete({ where: { id: user.id } });

    const res = await api().get('/api/users/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'User not found' } });
  });
});

describe('PATCH /api/users/me', () => {
  // The body schema is picked by the token's role. A role with no schema must be refused, not let
  // through to the update unvalidated.
  it('refuses a token whose role has no profile schema with 403 and changes nothing', async () => {
    const client = await makeClient({ name: 'Old Name' });
    const unknownRole = tokenFor({ id: client.id, email: client.email, role: 'ADMIN' as Role });

    const res = await api()
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${unknownRole}`)
      .send({ name: 'New Name', hourlyRate: 'not a number' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { message: 'Insufficient permissions' } });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: client.id } });
    expect(stored.name).toBe('Old Name');
  });

  it('updates name and bio for a CLIENT and persists them', async () => {
    const client = await makeClient({ name: 'Old Name', bio: null });

    const res = await authed(client).patch('/api/users/me').send({ name: '새 이름', bio: '소개' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: '새 이름', bio: '소개', hasPassword: true });
    expect(res.body).not.toHaveProperty('password');

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: client.id } });
    expect(stored.name).toBe('새 이름');
    expect(stored.bio).toBe('소개');
  });

  it('lets a CLIENT set companyName, businessField and website', async () => {
    const client = await makeClient();

    const res = await authed(client).patch('/api/users/me').send({
      companyName: '코드잇',
      businessField: '교육',
      website: 'https://codeit.kr',
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      companyName: '코드잇',
      businessField: '교육',
      website: 'https://codeit.kr',
    });

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: client.id } });
    expect(stored).toMatchObject({
      companyName: '코드잇',
      businessField: '교육',
      website: 'https://codeit.kr',
    });
  });

  it('silently ignores freelancer-only fields sent by a CLIENT', async () => {
    const client = await makeClient();

    const res = await authed(client).patch('/api/users/me').send({
      name: '이름만 반영',
      skills: ['React', 'PostgreSQL'],
      activityCategory: '웹 개발',
      experienceYears: 9,
      hourlyRate: 123,
      portfolioUrl: 'https://example.com',
    });

    // Ignored, not rejected — intentional (docs/domain/accounts.md).
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('이름만 반영');
    expect(res.body.skills).toEqual([]);
    expect(res.body.activityCategory).toBeNull();

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: client.id } });
    expect(stored.name).toBe('이름만 반영');
    expect(stored.skills).toEqual([]);
    expect(stored.activityCategory).toBeNull();
    expect(stored.experienceYears).toBeNull();
    expect(stored.hourlyRate).toBeNull();
    expect(stored.portfolioUrl).toBeNull();
  });

  it('silently ignores client-only fields sent by a FREELANCER', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).patch('/api/users/me').send({
      name: '이름만 반영',
      companyName: '있을 수 없는 회사',
      businessField: 'IT',
      website: 'https://example.com',
    });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('이름만 반영');
    expect(res.body.companyName).toBeNull();

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored.name).toBe('이름만 반영');
    expect(stored.companyName).toBeNull();
    expect(stored.businessField).toBeNull();
    expect(stored.website).toBeNull();
  });

  it('lets a FREELANCER set every freelancer-scoped field', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).patch('/api/users/me').send({
      skills: ['React', 'Node.js', 'TypeScript'],
      activityCategory: '데이터 분석',
      experienceYears: 7,
      hourlyRate: 88_000,
      portfolioUrl: 'https://portfolio.example',
    });

    expect(res.status).toBe(200);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored).toMatchObject({
      skills: ['React', 'Node.js', 'TypeScript'],
      activityCategory: '데이터 분석',
      experienceYears: 7,
      hourlyRate: 88_000,
      portfolioUrl: 'https://portfolio.example',
    });
  });

  it('normalizes skills through SKILL_ALIASES and de-duplicates them', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .patch('/api/users/me')
      .send({ skills: ['PostgreSQL', 'MySQL'] });

    expect(res.status).toBe(200);
    expect(res.body.skills).toEqual(['SQL']);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored.skills).toEqual(['SQL']);
  });

  it('leaves omitted fields untouched', async () => {
    const freelancer = await makeFreelancer({
      name: 'Keep Me',
      bio: 'keep this bio',
      portfolioUrl: 'https://keep.example',
    });

    const res = await authed(freelancer).patch('/api/users/me').send({ activityCategory: '기획' });

    expect(res.status).toBe(200);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored).toMatchObject({
      name: 'Keep Me',
      bio: 'keep this bio',
      portfolioUrl: 'https://keep.example',
      activityCategory: '기획',
      skills: ['React', 'Node.js'],
      experienceYears: 3,
      hourlyRate: 50_000,
    });
  });

  it('ignores a non-numeric experienceYears from a CLIENT, since the field is out of scope', async () => {
    const client = await makeClient();

    const res = await authed(client)
      .patch('/api/users/me')
      .send({ experienceYears: 'abc', hourlyRate: 'abc' });

    expect(res.status).toBe(200);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: client.id } });
    expect(stored.experienceYears).toBeNull();
    expect(stored.hourlyRate).toBeNull();
  });

  /*
   * Fixed by the zod schema (#1). `parseInt('abc')` used to be NaN, which Prisma serializes
   * to `null` on the nullable column: the request answered **200**, persisted the other fields
   * and silently wiped `experienceYears` — which also made the profile incomplete, so every later
   * application 403'd on `requireCompleteProfile`. Now the whole request is a 400 and nothing is
   * written.
   */
  it('rejects a non-numeric experienceYears with 400 and does not null it', async () => {
    const freelancer = await makeFreelancer({ experienceYears: 3 });

    const res = await authed(freelancer).patch('/api/users/me').send({ experienceYears: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { message: 'experienceYears: Experience years must be a non-negative integer' },
    });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored.experienceYears).toBe(3);
  });

  // Same on the money field: `parseFloat('abc')` used to replace the stored rate with null.
  it('rejects a non-numeric hourlyRate with 400 and does not null it', async () => {
    const freelancer = await makeFreelancer({ hourlyRate: 50_000 });

    const res = await authed(freelancer).patch('/api/users/me').send({ hourlyRate: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'hourlyRate: Hourly rate must be a positive whole number of won' } });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored.hourlyRate).toBe(50_000);
  });

  // The blast radius: the whole request used to be applied, so `name` was written *and*
  // `experienceYears` nulled. A rejected request must leave every field as it was.
  it('leaves the profile untouched when a non-numeric experienceYears is submitted', async () => {
    const freelancer = await makeFreelancer({ name: 'Unchanged', experienceYears: 3 });

    await authed(freelancer)
      .patch('/api/users/me')
      .send({ name: 'Should not stick', experienceYears: 'abc' });

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored.name).toBe('Unchanged');
    expect(stored.experienceYears).toBe(3);
  });

  it('leaves the profile untouched when a non-numeric hourlyRate is submitted', async () => {
    const freelancer = await makeFreelancer({ name: 'Unchanged', hourlyRate: 50_000 });

    await authed(freelancer)
      .patch('/api/users/me')
      .send({ name: 'Should not stick', hourlyRate: 'abc' });

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored.name).toBe('Unchanged');
    expect(stored.hourlyRate).toBe(50_000);
  });

  // `experienceYears` is a non-negative integer — the range `requireCompleteProfile` accepts.
  // An empty multipart field is a present, non-numeric value, not "absent": 400, not a wipe.
  it.each([
    ['a fractional number', 1.5],
    ['a fractional string', '1.5'],
    ['a negative number', -1],
    ['a negative string', '-1'],
    ['trailing garbage', '3abc'],
    ['an empty string', ''],
    ['null', null],
    ['a value beyond the Int column', 2_147_483_648],
  ])('rejects %s as experienceYears with 400, row unchanged', async (_label, experienceYears) => {
    const freelancer = await makeFreelancer({ experienceYears: 3 });

    const res = await authed(freelancer).patch('/api/users/me').send({ experienceYears });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { message: 'experienceYears: Experience years must be a non-negative integer' },
    });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored.experienceYears).toBe(3);
  });

  it.each([
    ['an empty multipart field', 'experienceYears', ''],
    ['a fractional multipart value', 'experienceYears', '2.5'],
    ['an empty multipart field', 'hourlyRate', ''],
    ['a non-numeric multipart value', 'hourlyRate', '5만원'],
    ['a fractional multipart value', 'hourlyRate', '45000.5'],
    ['a comma-grouped multipart value', 'hourlyRate', '45,000'],
  ])('rejects %s for %s with 400, row unchanged', async (_label, field, value) => {
    const freelancer = await makeFreelancer({ experienceYears: 3, hourlyRate: 50_000 });

    const res = await authed(freelancer).patch('/api/users/me').field(field, value);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(new RegExp(`^${field}: `));
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored).toMatchObject({ experienceYears: 3, hourlyRate: 50_000 });
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['an object', { amount: 1 }],
    ['a value that overflows to Infinity', '1e400'],
    // Money rule: amounts are whole won.
    ['a fractional number', 45_000.5],
    ['a fractional string', '45000.5'],
    ['a negative number', -1],
    ['a negative string', '-1'],
    // A rate is at least 1 won.
    ['zero', 0],
    ['a zero string', '0'],
  ])('rejects %s as hourlyRate with 400, row unchanged', async (_label, hourlyRate) => {
    const freelancer = await makeFreelancer({ hourlyRate: 50_000 });

    const res = await authed(freelancer).patch('/api/users/me').send({ hourlyRate });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'hourlyRate: Hourly rate must be a positive whole number of won' } });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored.hourlyRate).toBe(50_000);
  });

  it('accepts experienceYears 0 and a digit-string hourlyRate', async () => {
    const freelancer = await makeFreelancer({ experienceYears: 3, hourlyRate: 50_000 });

    const res = await authed(freelancer)
      .patch('/api/users/me')
      .send({ experienceYears: '0', hourlyRate: '12000' });

    expect(res.status).toBe(200);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored).toMatchObject({ experienceYears: 0, hourlyRate: 12_000 });
  });

  it.each([1, 100_000_000])('accepts the boundary hourlyRate %s', async (hourlyRate) => {
    const freelancer = await makeFreelancer({ hourlyRate: 50_000 });

    const res = await authed(freelancer).patch('/api/users/me').send({ hourlyRate });

    expect(res.status).toBe(200);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored.hourlyRate).toBe(hourlyRate);
  });

  it('rejects an hourlyRate above 100,000,000 won with 400, row unchanged', async () => {
    const freelancer = await makeFreelancer({ hourlyRate: 50_000 });

    const res = await authed(freelancer).patch('/api/users/me').field('hourlyRate', '100000001');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'hourlyRate: Hourly rate must be at most 100,000,000 won' } });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored.hourlyRate).toBe(50_000);
  });

  it.each([
    ['an empty name', { name: '' }, 'name: Name is required'],
    ['a blank name', { name: '   ' }, 'name: Name is required'],
    ['a numeric name', { name: 7 }, 'name: Name must be a string'],
    ['an object bio', { bio: { text: 'x' } }, 'bio: Bio must be a string'],
  ])('rejects %s with 400 rather than 500 and writes nothing', async (_label, body, message) => {
    const client = await makeClient({ name: 'Unchanged', bio: 'kept' });

    const res = await authed(client).patch('/api/users/me').send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message } });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: client.id } });
    expect(stored).toMatchObject({ name: 'Unchanged', bio: 'kept' });
  });

  it('rejects a repeated multipart name with 400', async () => {
    const freelancer = await makeFreelancer({ name: 'Unchanged' });

    const res = await authed(freelancer).patch('/api/users/me').field('name', 'a').field('name', 'b');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'name: Name must be a string' } });
  });

  it('stores the name trimmed and lets JSON null clear an optional text field', async () => {
    const client = await makeClient({ website: 'https://old.example' });

    const res = await authed(client).patch('/api/users/me').send({ name: '  새 이름  ', website: null });

    expect(res.status).toBe(200);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: client.id } });
    expect(stored.name).toBe('새 이름');
    expect(stored.website).toBeNull();
  });

  it('validates the CLIENT fields but not the freelancer ones for a CLIENT', async () => {
    const client = await makeClient({ companyName: '코드잇' });

    const res = await authed(client).patch('/api/users/me').send({ companyName: 42, experienceYears: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'companyName: Company name must be a string' } });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: client.id } });
    expect(stored.companyName).toBe('코드잇');
  });

  it('ignores a malformed client-only field from a FREELANCER', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer)
      .patch('/api/users/me')
      .send({ activityCategory: '기획', companyName: { not: 'a string' } });

    expect(res.status).toBe(200);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored.activityCategory).toBe('기획');
    expect(stored.companyName).toBeNull();
  });

  // Fixed by the zod schema (#11): `normalizeSkillList` used to call `.trim()` on every element,
  // so a non-string element threw a TypeError → 500.
  it('rejects a skills array of non-strings with 400', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).patch('/api/users/me').send({ skills: [1, 2] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'skills: Skills must be strings' } });
  });

  it.each([
    ['a number', 7],
    ['an object', { a: 'React' }],
    ['a nested array', [['React']]],
  ])('rejects skills given as %s with 400', async (_label, skills) => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).patch('/api/users/me').send({ skills });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'skills: Skills must be strings' } });
  });

  it('clears skills with JSON null', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).patch('/api/users/me').send({ skills: null });

    expect(res.status).toBe(200);
    expect(res.body.skills).toEqual([]);
  });

  // The half that already held before the fix: a malformed `skills` writes nothing at all —
  // not even the sibling `name`.
  it('writes nothing when skills contains non-strings', async () => {
    const freelancer = await makeFreelancer({ name: 'Unchanged' });

    const res = await authed(freelancer)
      .patch('/api/users/me')
      .send({ name: 'Should not stick', skills: [1, 2], activityCategory: '기획' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).toEqual({ error: { message: expect.any(String) } });
    // No error body, whatever its status, leaks a source path.
    expect(res.body.error.message).not.toMatch(/workbridge-server|\.ts:/);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored.name).toBe('Unchanged');
    expect(stored.skills).toEqual(['React', 'Node.js']);
    expect(stored.activityCategory).toBe('웹 개발');
  });

  /*
   * This route is documented as `multipart/form-data`, and the client does send that —
   * it is the only way to attach `profileImage`. A JSON body nevertheless works: `express.json()`
   * is mounted before the router, and `upload.single()` passes a non-multipart request straight
   * through without touching `req.body`. The two are *not* equivalent, because
   * `normalizeSkillList` splits on commas only when the value is not already an array. Both paths
   * are pinned below so that difference is documented rather than incidental.
   */
  describe('JSON body vs multipart/form-data', () => {
    it('accepts a JSON body even though the route is documented as multipart/form-data', async () => {
      const freelancer = await makeFreelancer();

      const res = await authed(freelancer)
        .patch('/api/users/me')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ name: 'JSON 경로', activityCategory: '데이터 분석' }));

      expect(res.status).toBe(200);
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
      expect(stored).toMatchObject({ name: 'JSON 경로', activityCategory: '데이터 분석' });
    });

    it('keeps a JSON skills array verbatim, so a skill may contain a comma', async () => {
      const freelancer = await makeFreelancer();

      const res = await authed(freelancer)
        .patch('/api/users/me')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ skills: ['React, Node.js'] }));

      expect(res.status).toBe(200);
      // One skill, not two: the array branch of `normalizeSkillList` only trims.
      expect(res.body.skills).toEqual(['React, Node.js']);

      const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
      expect(stored.skills).toEqual(['React, Node.js']);
    });

    it('splits a multipart skills field on commas, so a comma-containing skill is impossible', async () => {
      const freelancer = await makeFreelancer();

      const res = await authed(freelancer)
        .patch('/api/users/me')
        .field('skills', 'React, Node.js');

      expect(res.status).toBe(200);
      // The same characters that stayed one skill over JSON become two here.
      expect(res.body.skills).toEqual(['React', 'Node.js']);

      const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
      expect(stored.skills).toEqual(['React', 'Node.js']);
    });

    it('treats repeated multipart skills fields as separate skills', async () => {
      const freelancer = await makeFreelancer();

      const res = await authed(freelancer)
        .patch('/api/users/me')
        .field('skills', 'PostgreSQL')
        .field('skills', 'React');

      // multer collects repeated text fields into an array of strings, which then takes the
      // array branch — so no comma splitting, but aliases still apply.
      expect(res.status).toBe(200);
      expect(res.body.skills).toEqual(['SQL', 'React']);
    });

    it('splits a JSON skills *string* on commas, exactly as multipart does', async () => {
      const freelancer = await makeFreelancer();

      const res = await authed(freelancer)
        .patch('/api/users/me')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ skills: 'PostgreSQL, MySQL , React' }));

      expect(res.status).toBe(200);
      // The split is driven by the *value's* type, not the content type of the request.
      expect(res.body.skills).toEqual(['SQL', 'React']);
    });

    it('agrees on the numeric fields: a JSON number and a multipart string both persist', async () => {
      const viaJson = await makeFreelancer({ experienceYears: 1, hourlyRate: 1 });
      const viaMultipart = await makeFreelancer({ experienceYears: 1, hourlyRate: 1 });

      const jsonRes = await authed(viaJson)
        .patch('/api/users/me')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ experienceYears: 7, hourlyRate: 45_000 }));
      const multipartRes = await authed(viaMultipart)
        .patch('/api/users/me')
        .field('experienceYears', '7')
        .field('hourlyRate', '45000');

      expect([jsonRes.status, multipartRes.status]).toEqual([200, 200]);
      for (const user of [viaJson, viaMultipart]) {
        const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        expect(stored.experienceYears).toBe(7);
        expect(stored.hourlyRate).toBe(45_000);
      }
    });
  });

  describe('profileImage upload', () => {
    it('mocks the Supabase SDK, not the upload middleware, so no real request can leave', async () => {
      // The `vi.mock` above replaces `createClient`, so the client `src/middlewares/upload`
      // builds at module-evaluation time is this stub: the real SDK is never constructed and
      // there is no code path to a network call.
      const bucket = (createClient('https://unused.invalid', 'unused-key') as unknown as {
        storage: { from: (bucket: string) => { upload: unknown; getPublicUrl: unknown } };
      }).storage.from('workbridge');
      expect(bucket.upload).toBe(supabaseUpload);
      expect(bucket.getPublicUrl).toBe(supabasePublicUrl);

      // `uploadToSupabase` and the multer instance beside it are the real implementations —
      // mocking the middleware module would have replaced the `upload` that `users.routes`
      // needs, and multipart parsing would silently stop happening.
      expect(vi.isMockFunction(uploadToSupabase)).toBe(false);

      const freelancer = await makeFreelancer();
      const res = await authed(freelancer)
        .patch('/api/users/me')
        .attach('profileImage', PNG, { filename: 'me.png', contentType: 'image/png' });

      // Real multer parsed the body: the stub received the exact bytes that were attached.
      expect(res.status).toBe(200);
      expect(supabaseUpload).toHaveBeenCalledTimes(1);
      expect((supabaseUpload.mock.calls[0] as [string, Buffer])[1].equals(PNG)).toBe(true);
    });

    it('stores the uploaded image URL returned by storage', async () => {
      const freelancer = await makeFreelancer();

      const res = await authed(freelancer)
        .patch('/api/users/me')
        .field('name', '이미지 업로드')
        .attach('profileImage', PNG, { filename: 'me.png', contentType: 'image/png' });

      expect(res.status).toBe(200);
      expect(res.body.profileImage).toMatch(
        new RegExp(`^${PUBLIC_URL_BASE}profiles/${freelancer.id}-[0-9a-f-]+\\.png$`),
      );

      const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
      expect(stored.profileImage).toBe(res.body.profileImage);
      expect(stored.name).toBe('이미지 업로드');

      expect(supabaseUpload).toHaveBeenCalledTimes(1);
      const [path, buffer, options] = supabaseUpload.mock.calls[0] as [string, Buffer, unknown];
      expect(path).toMatch(/^profiles\//);
      expect(buffer.equals(PNG)).toBe(true);
      expect(options).toMatchObject({ contentType: 'image/png', upsert: true });
    });

    it('leaves profileImage untouched when no file is attached', async () => {
      const freelancer = await makeFreelancer({ profileImage: 'https://old.example/a.png' });

      const res = await authed(freelancer).patch('/api/users/me').send({ name: 'no file' });

      expect(res.status).toBe(200);
      expect(res.body.profileImage).toBe('https://old.example/a.png');
      expect(supabaseUpload).not.toHaveBeenCalled();
    });

    // Validation runs after multer (which fills `req.body`) and before the controller uploads, so
    // a malformed field never reaches storage.
    it('rejects a malformed field with 400 before uploading the attached image', async () => {
      const freelancer = await makeFreelancer({ experienceYears: 3 });

      const res = await authed(freelancer)
        .patch('/api/users/me')
        .field('experienceYears', 'abc')
        .attach('profileImage', PNG, { filename: 'me.png', contentType: 'image/png' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('experienceYears: Experience years must be a non-negative integer');
      expect(supabaseUpload).not.toHaveBeenCalled();
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
      expect(stored).toMatchObject({ experienceYears: 3, profileImage: null });
    });

    it('never reaches storage for a non-image upload', async () => {
      const freelancer = await makeFreelancer();

      await authed(freelancer)
        .patch('/api/users/me')
        .attach('profileImage', Buffer.from('hello'), {
          filename: 'notes.txt',
          contentType: 'text/plain',
        });

      expect(supabaseUpload).not.toHaveBeenCalled();
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
      expect(stored.profileImage).toBeNull();
    });

    it('does not modify the profile when storage fails', async () => {
      const freelancer = await makeFreelancer({ name: 'Unchanged' });
      supabaseUpload.mockResolvedValue({ data: null, error: new Error('bucket unavailable') });

      await authed(freelancer)
        .patch('/api/users/me')
        .field('name', 'Should not stick')
        .attach('profileImage', PNG, { filename: 'me.png', contentType: 'image/png' });

      const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
      expect(stored.name).toBe('Unchanged');
      expect(stored.profileImage).toBeNull();
    });
  });
});

describe('GET /api/users/:id', () => {
  it('returns the public profile without authentication and never includes email', async () => {
    const freelancer = await makeFreelancer({ bio: '공개 프로필' });

    const res = await api().get(`/api/users/${freelancer.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: freelancer.id,
      name: freelancer.name,
      role: 'FREELANCER',
      bio: '공개 프로필',
      skills: ['React', 'Node.js'],
    });
    expect(res.body).not.toHaveProperty('email');
    expect(res.body).not.toHaveProperty('password');
    expect(res.body).not.toHaveProperty('deletedAt');
  });

  it('still withholds email when the caller is the user themselves', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).get(`/api/users/${freelancer.id}`);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('email');
  });

  it('reports avgRating null and reviewCount 0 when there are no reviews', async () => {
    const freelancer = await makeFreelancer();

    const res = await api().get(`/api/users/${freelancer.id}`);

    expect(res.status).toBe(200);
    expect(res.body.avgRating).toBeNull();
    expect(res.body.reviewCount).toBe(0);
    expect(res.body.receivedReviews).toEqual([]);
  });

  it('computes avgRating and reviewCount from received reviews, newest first', async () => {
    const client = await makeClient();
    const freelancer = await makeFreelancer();
    const [c1, c2, c3] = [
      await makeCompletedContract(client.id, freelancer.id),
      await makeCompletedContract(client.id, freelancer.id),
      await makeCompletedContract(client.id, freelancer.id),
    ];

    await makeReview({
      contractId: c1.id,
      reviewerId: client.id,
      revieweeId: freelancer.id,
      rating: 5,
      content: 'oldest',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await makeReview({
      contractId: c2.id,
      reviewerId: client.id,
      revieweeId: freelancer.id,
      rating: 4,
      content: 'middle',
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    await makeReview({
      contractId: c3.id,
      reviewerId: client.id,
      revieweeId: freelancer.id,
      rating: 3,
      content: 'newest',
      createdAt: new Date('2026-03-01T00:00:00Z'),
    });

    const res = await api().get(`/api/users/${freelancer.id}`);

    expect(res.status).toBe(200);
    expect(res.body.reviewCount).toBe(3);
    expect(res.body.avgRating).toBe(4);
    expect(res.body.receivedReviews.map((r: { content: string }) => r.content)).toEqual([
      'newest',
      'middle',
      'oldest',
    ]);
    expect(res.body.receivedReviews[0]).toMatchObject({
      rating: 3,
      content: 'newest',
      tags: ['성실함'],
      reviewer: { id: client.id, name: client.name },
    });
    expect(res.body.receivedReviews[0].reviewer).not.toHaveProperty('email');
  });

  it('computes a fractional avgRating', async () => {
    const client = await makeClient();
    const freelancer = await makeFreelancer();
    const c1 = await makeCompletedContract(client.id, freelancer.id);
    const c2 = await makeCompletedContract(client.id, freelancer.id);
    const c3 = await makeCompletedContract(client.id, freelancer.id);

    for (const [contract, rating] of [[c1, 5], [c2, 4], [c3, 4]] as const) {
      await makeReview({
        contractId: contract.id,
        reviewerId: client.id,
        revieweeId: freelancer.id,
        rating,
      });
    }

    const res = await api().get(`/api/users/${freelancer.id}`);

    expect(res.status).toBe(200);
    expect(res.body.avgRating).toBeCloseTo(13 / 3, 6);
    expect(res.body.reviewCount).toBe(3);
  });

  it('counts only reviews received, not reviews written by the user', async () => {
    const client = await makeClient();
    const freelancer = await makeFreelancer();
    const contract = await makeCompletedContract(client.id, freelancer.id);

    // The freelancer reviews the client, so it is the client's received review.
    await makeReview({
      contractId: contract.id,
      reviewerId: freelancer.id,
      revieweeId: client.id,
      rating: 2,
    });

    const freelancerRes = await api().get(`/api/users/${freelancer.id}`);
    expect(freelancerRes.body.reviewCount).toBe(0);
    expect(freelancerRes.body.avgRating).toBeNull();

    const clientRes = await api().get(`/api/users/${client.id}`);
    expect(clientRes.body.reviewCount).toBe(1);
    expect(clientRes.body.avgRating).toBe(2);
  });

  it('404s for an unknown id', async () => {
    const res = await api().get('/api/users/00000000-0000-0000-0000-000000000000');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'User not found' } });
  });

  it('adds portfolioItems, careers and careerSummary exactly as the public routes return them', async () => {
    const freelancer = await makeFreelancer();
    await makePortfolioItem(freelancer.id, { sortOrder: 1, title: 'Second' });
    await makePortfolioItem(freelancer.id, { sortOrder: 0, title: 'First', startedAt: new Date('2025-02-28T15:00:00.000Z') });
    await makeCareer(freelancer.id); // 2020-01 … 2021-12
    await makeCareer(freelancer.id, {
      startDate: new Date('2021-05-31T15:00:00.000Z'), // 2021-06
      endDate: new Date('2022-05-31T15:00:00.000Z'), // 2022-06
    });

    const [profile, portfolio, careers] = await Promise.all([
      api().get(`/api/users/${freelancer.id}`),
      api().get(`/api/users/${freelancer.id}/portfolio`),
      api().get(`/api/users/${freelancer.id}/careers`),
    ]);

    expect(profile.status).toBe(200);
    expect(profile.body.portfolioItems).toEqual(portfolio.body.items);
    expect(profile.body.portfolioItems.map((item: { title: string }) => item.title)).toEqual(['First', 'Second']);
    expect(profile.body.portfolioItems[0].startedAt).toBe('2025-03');
    expect(profile.body.careers).toEqual(careers.body.careers);
    expect(profile.body.careers.map((c: { startDate: string }) => c.startDate)).toEqual(['2021-06', '2020-01']);
    expect(profile.body.careerSummary).toEqual({ totalMonths: 30, years: 2, months: 6 });
    // Additive: the pre-existing fields are still there.
    expect(profile.body).toMatchObject({ id: freelancer.id, avgRating: null, reviewCount: 0, receivedReviews: [] });
  });

  it('gives a CLIENT empty lists and a zero summary', async () => {
    const client = await makeClient();

    const res = await api().get(`/api/users/${client.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      portfolioItems: [],
      careers: [],
      careerSummary: { totalMonths: 0, years: 0, months: 0 },
    });
  });

  it('404s a soft-deleted user even with portfolio and careers kept', async () => {
    const freelancer = await makeFreelancer({ deletedAt: new Date() });
    await makePortfolioItem(freelancer.id);
    await makeCareer(freelancer.id);

    const res = await api().get(`/api/users/${freelancer.id}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'User not found' } });
  });
});

describe('GET /api/users/me/applications', () => {
  it('returns the caller\'s applications newest first with project and contract', async () => {
    const client = await makeClient();
    const freelancer = await makeFreelancer();
    const older = await makeProject(client.id, { title: '오래된 프로젝트' });
    const newer = await makeProject(client.id, { title: '최신 프로젝트' });

    await makeApplication(older.id, freelancer.id, {
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const newApp = await makeApplication(newer.id, freelancer.id, {
      createdAt: new Date('2026-02-01T00:00:00Z'),
      status: 'ACCEPTED',
    });
    const contract = await makeContract({
      projectId: newer.id,
      applicationId: newApp.id,
      clientId: client.id,
      freelancerId: freelancer.id,
    });

    const res = await authed(freelancer).get('/api/users/me/applications');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      id: newApp.id,
      status: 'ACCEPTED',
      contract: { id: contract.id, status: 'PENDING' },
      project: {
        id: newer.id,
        title: '최신 프로젝트',
        budget: 5_000_000,
        client: { id: client.id, name: client.name, companyName: 'Test Company' },
      },
    });
    expect(res.body[1]).toMatchObject({ project: { title: '오래된 프로젝트' } });
    expect(res.body[1].contract).toBeNull();
  });

  it('returns an empty array when the freelancer has not applied to anything', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).get('/api/users/me/applications');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('excludes another freelancer\'s applications', async () => {
    const client = await makeClient();
    const mine = await makeFreelancer();
    const theirs = await makeFreelancer();
    const project = await makeProject(client.id);
    await makeApplication(project.id, theirs.id);

    const res = await authed(mine).get('/api/users/me/applications');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('runs the lifecycle sweep first, so an expired project reads as CLOSED and its application as REJECTED', async () => {
    const client = await makeClient();
    const freelancer = await makeFreelancer();
    const expired = await makeProject(client.id, {
      status: 'OPEN',
      recruitmentStartDate: daysFromNow(-10),
      deadline: daysFromNow(-1),
    });
    const application = await makeApplication(expired.id, freelancer.id);

    const res = await authed(freelancer).get('/api/users/me/applications');

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      status: 'REJECTED',
      project: { status: 'CLOSED' },
    });

    // The sweep writes: this GET is not read-only.
    expect((await prisma.project.findUniqueOrThrow({ where: { id: expired.id } })).status)
      .toBe('CLOSED');
    expect((await prisma.application.findUniqueOrThrow({ where: { id: application.id } })).status)
      .toBe('REJECTED');
  });

  it('rejects only the caller\'s stale pending applications on an already-CLOSED project', async () => {
    const client = await makeClient();
    const mine = await makeFreelancer();
    const theirs = await makeFreelancer();
    const closed = await makeProject(client.id, { status: 'CLOSED' });
    const myApp = await makeApplication(closed.id, mine.id);
    const theirApp = await makeApplication(closed.id, theirs.id);

    const res = await authed(mine).get('/api/users/me/applications');

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ id: myApp.id, status: 'REJECTED' });
    expect((await prisma.application.findUniqueOrThrow({ where: { id: theirApp.id } })).status)
      .toBe('PENDING');
  });
});

describe('GET /api/users/me/bookmarks', () => {
  it('returns each bookmarked project with isBookmarked and bookmarkedAt, newest first', async () => {
    const client = await makeClient();
    const freelancer = await makeFreelancer();
    const first = await makeProject(client.id, { title: '먼저 북마크' });
    const second = await makeProject(client.id, { title: '나중 북마크' });
    await prisma.projectBookmark.create({
      data: {
        projectId: first.id,
        userId: freelancer.id,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    await prisma.projectBookmark.create({
      data: {
        projectId: second.id,
        userId: freelancer.id,
        createdAt: new Date('2026-02-01T00:00:00Z'),
      },
    });

    const res = await authed(freelancer).get('/api/users/me/bookmarks');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((p: { title: string }) => p.title)).toEqual(['나중 북마크', '먼저 북마크']);
    expect(res.body[0]).toMatchObject({
      id: second.id,
      title: '나중 북마크',
      isBookmarked: true,
      bookmarkedAt: '2026-02-01T00:00:00.000Z',
      client: { id: client.id, name: client.name },
    });
    expect(res.body[0].client).not.toHaveProperty('email');
  });

  it('returns an empty array when there are no bookmarks', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).get('/api/users/me/bookmarks');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('excludes bookmarks whose project is soft-deleted', async () => {
    const client = await makeClient();
    const freelancer = await makeFreelancer();
    const kept = await makeProject(client.id, { title: '살아있는 프로젝트' });
    const removed = await makeProject(client.id, {
      title: '삭제된 프로젝트',
      deletedAt: new Date(),
    });
    await prisma.projectBookmark.create({ data: { projectId: kept.id, userId: freelancer.id } });
    await prisma.projectBookmark.create({ data: { projectId: removed.id, userId: freelancer.id } });

    const res = await authed(freelancer).get('/api/users/me/bookmarks');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(kept.id);
    // The bookmark row itself is untouched — it is filtered on read, not deleted.
    expect(await prisma.projectBookmark.count({ where: { userId: freelancer.id } })).toBe(2);
  });

  it('excludes another user\'s bookmarks', async () => {
    const client = await makeClient();
    const mine = await makeFreelancer();
    const theirs = await makeFreelancer();
    const project = await makeProject(client.id);
    await prisma.projectBookmark.create({ data: { projectId: project.id, userId: theirs.id } });

    const res = await authed(mine).get('/api/users/me/bookmarks');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('GET /api/users/me/projects', () => {
  it('returns the caller\'s projects newest first with an application count', async () => {
    const client = await makeClient();
    const freelancerA = await makeFreelancer();
    const freelancerB = await makeFreelancer();
    const older = await makeProject(client.id, {
      title: '오래된 프로젝트',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const newer = await makeProject(client.id, {
      title: '최신 프로젝트',
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    await makeApplication(newer.id, freelancerA.id);
    await makeApplication(newer.id, freelancerB.id);

    const res = await authed(client).get('/api/users/me/projects');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      id: newer.id,
      title: '최신 프로젝트',
      _count: { applications: 2 },
    });
    expect(res.body[1]).toMatchObject({ id: older.id, _count: { applications: 0 } });
  });

  it('returns an empty array when the client has no projects', async () => {
    const client = await makeClient();

    const res = await authed(client).get('/api/users/me/projects');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('excludes soft-deleted projects', async () => {
    const client = await makeClient();
    const kept = await makeProject(client.id);
    await makeProject(client.id, { deletedAt: new Date() });

    const res = await authed(client).get('/api/users/me/projects');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(kept.id);
  });

  it('excludes another client\'s projects', async () => {
    const mine = await makeClient();
    const theirs = await makeClient();
    await makeProject(theirs.id);

    const res = await authed(mine).get('/api/users/me/projects');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('runs the lifecycle sweep first, promoting UPCOMING and closing expired projects', async () => {
    const client = await makeClient();
    const due = await makeProject(client.id, {
      status: 'UPCOMING',
      recruitmentStartDate: daysFromNow(-1),
      deadline: daysFromNow(10),
    });
    const expired = await makeProject(client.id, {
      status: 'OPEN',
      recruitmentStartDate: daysFromNow(-10),
      deadline: daysFromNow(-1),
    });
    const future = await makeProject(client.id, {
      status: 'UPCOMING',
      recruitmentStartDate: daysFromNow(5),
      deadline: daysFromNow(20),
    });

    const res = await authed(client).get('/api/users/me/projects');

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(
      (res.body as { id: string; status: string }[]).map((p) => [p.id, p.status]),
    );
    expect(byId[due.id]).toBe('OPEN');
    expect(byId[expired.id]).toBe('CLOSED');
    expect(byId[future.id]).toBe('UPCOMING');

    expect((await prisma.project.findUniqueOrThrow({ where: { id: due.id } })).status).toBe('OPEN');
    expect((await prisma.project.findUniqueOrThrow({ where: { id: expired.id } })).status)
      .toBe('CLOSED');
  });
});
