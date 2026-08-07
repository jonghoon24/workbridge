import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

import { uploadToSupabase } from '../src/middlewares/upload';
import { api, authed, tokenFor } from './helpers/api';
import { prisma } from './helpers/db';
import {
  daysFromNow,
  makeApplication,
  makeClient,
  makeContract,
  makeFreelancer,
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
  it('updates name and bio for a CLIENT and persists them', async () => {
    const client = await makeClient({ name: 'Old Name', bio: null });

    const res = await authed(client).patch('/api/users/me').send({ name: '새 이름', bio: '소개' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: '새 이름', bio: '소개' });

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

  it('silently ignores freelancer-only fields sent by a CLIENT [Q2]', async () => {
    const client = await makeClient();

    const res = await authed(client).patch('/api/users/me').send({
      name: '이름만 반영',
      skills: ['React', 'PostgreSQL'],
      activityCategory: '웹 개발',
      experienceYears: 9,
      hourlyRate: 123,
      portfolioUrl: 'https://example.com',
    });

    // Ignored, not rejected — intentional per Q2.
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

  it('silently ignores client-only fields sent by a FREELANCER [Q2]', async () => {
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
      hourlyRate: 88_000.5,
      portfolioUrl: 'https://portfolio.example',
    });

    expect(res.status).toBe(200);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored).toMatchObject({
      skills: ['React', 'Node.js', 'TypeScript'],
      activityCategory: '데이터 분석',
      experienceYears: 7,
      hourlyRate: 88_000.5,
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
   * [D3] There is no 500 here, contrary to what BEHAVIOR.md used to claim. `parseInt('abc')` is
   * NaN and `experienceYears` is a **nullable** column, so Prisma serializes NaN to `null` and the
   * write *succeeds*: the response is **200**, the other fields in the same request are persisted,
   * and the stored `experienceYears` is silently wiped to `null`. That is worse than a 500 —
   * it is silent data loss that also makes the profile incomplete, so every later
   * `POST /api/projects/:id/applications` 403s on `requireCompleteProfile`.
   *
   * Both assertions below flip together when a NaN guard lands: 400 instead of 200, and the
   * previously stored value still present.
   */
  it.fails('rejects a non-numeric experienceYears with 400 and does not null it [D3]', async () => {
    const freelancer = await makeFreelancer({ experienceYears: 3 });

    const res = await authed(freelancer).patch('/api/users/me').send({ experienceYears: 'abc' });

    expect(res.status).toBe(400);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored.experienceYears).toBe(3);
  });

  // [D3] `parseFloat('abc')` is NaN and `hourlyRate` is nullable too, so the same silent wipe
  // happens on the money field: 200 today, with the stored rate replaced by null.
  it.fails('rejects a non-numeric hourlyRate with 400 and does not null it [D3]', async () => {
    const freelancer = await makeFreelancer({ hourlyRate: 50_000 });

    const res = await authed(freelancer).patch('/api/users/me').send({ hourlyRate: 'abc' });

    expect(res.status).toBe(400);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored.hourlyRate).toBe(50_000);
  });

  // [D3] The blast radius: today the whole request is applied, so `name` is written *and*
  // `experienceYears` is nulled. A rejected request must leave every field as it was.
  it.fails('leaves the profile untouched when a non-numeric experienceYears is submitted [D3]', async () => {
    const freelancer = await makeFreelancer({ name: 'Unchanged', experienceYears: 3 });

    await authed(freelancer)
      .patch('/api/users/me')
      .send({ name: 'Should not stick', experienceYears: 'abc' });

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored.name).toBe('Unchanged');
    expect(stored.experienceYears).toBe(3);
  });

  // [D3] Same blast radius on the other numeric field: the sibling `name` sticks while the
  // stored `hourlyRate` is replaced by null.
  it.fails('leaves the profile untouched when a non-numeric hourlyRate is submitted [D3]', async () => {
    const freelancer = await makeFreelancer({ name: 'Unchanged', hourlyRate: 50_000 });

    await authed(freelancer)
      .patch('/api/users/me')
      .send({ name: 'Should not stick', hourlyRate: 'abc' });

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored.name).toBe('Unchanged');
    expect(stored.hourlyRate).toBe(50_000);
  });

  // [D16] `normalizeSkillList` maps `.trim()` over every element, so a non-string element throws
  // `TypeError: skill.trim is not a function` inside the controller, before Prisma is reached.
  // With no `statusCode` on the error, `errorHandler` renders it as **500**; cross-cutting rule 8
  // requires 400 for a malformed value.
  it.fails('rejects a skills array of non-strings with 400 [D16]', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).patch('/api/users/me').send({ skills: [1, 2] });

    expect(res.status).toBe(400);
  });

  // The redeeming half of D16, and true both today and after the fix: the throw happens before
  // `prisma.user.update`, so a malformed `skills` writes nothing at all — not even the sibling
  // `name`. Only the status code is wrong.
  it('writes nothing when skills contains non-strings (D16 — true before and after the fix)', async () => {
    const freelancer = await makeFreelancer({ name: 'Unchanged' });

    const res = await authed(freelancer)
      .patch('/api/users/me')
      .send({ name: 'Should not stick', skills: [1, 2], activityCategory: '기획' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).toEqual({ error: { message: expect.any(String) } });
    // Unlike the Prisma-formatted errors in D14, this plain TypeError leaks no source path.
    expect(res.body.error.message).not.toMatch(/workbridge-server|\.ts:/);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: freelancer.id } });
    expect(stored.name).toBe('Unchanged');
    expect(stored.skills).toEqual(['React', 'Node.js']);
    expect(stored.activityCategory).toBe('웹 개발');
  });

  /*
   * BEHAVIOR.md documents this route as `multipart/form-data`, and the client does send that —
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
        .send(JSON.stringify({ experienceYears: 7, hourlyRate: 45_000.5 }));
      const multipartRes = await authed(viaMultipart)
        .patch('/api/users/me')
        .field('experienceYears', '7')
        .field('hourlyRate', '45000.5');

      expect([jsonRes.status, multipartRes.status]).toEqual([200, 200]);
      for (const user of [viaJson, viaMultipart]) {
        const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        expect(stored.experienceYears).toBe(7);
        expect(stored.hourlyRate).toBe(45_000.5);
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

    // [D6] the fileFilter's plain `Error` has no statusCode, so errorHandler renders 500.
    it.fails('rejects a non-image upload with 400 [D6]', async () => {
      const freelancer = await makeFreelancer();

      const res = await authed(freelancer)
        .patch('/api/users/me')
        .attach('profileImage', Buffer.from('hello'), {
          filename: 'notes.txt',
          contentType: 'text/plain',
        });

      expect(res.status).toBe(400);
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

    // [D6] multer's LIMIT_FILE_SIZE MulterError has no statusCode, so errorHandler renders 500.
    it.fails('rejects an upload over the 5 MB limit with 413 or 400 [D6]', async () => {
      const freelancer = await makeFreelancer();

      const res = await authed(freelancer)
        .patch('/api/users/me')
        .attach('profileImage', Buffer.alloc(6 * 1024 * 1024, 7), {
          filename: 'huge.png',
          contentType: 'image/png',
        });

      expect([400, 413]).toContain(res.status);
    });

    // [D6] the raw Supabase error is rethrown as-is, so it has no statusCode and renders 500.
    it.fails('surfaces a storage failure as an upstream error, not 500 [D6]', async () => {
      const freelancer = await makeFreelancer();
      supabaseUpload.mockResolvedValue({ data: null, error: new Error('bucket unavailable') });

      const res = await authed(freelancer)
        .patch('/api/users/me')
        .attach('profileImage', PNG, { filename: 'me.png', contentType: 'image/png' });

      expect([400, 502]).toContain(res.status);
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
