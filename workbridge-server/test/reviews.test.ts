import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';

import { api, authed } from './helpers/api';
import { prisma } from './helpers/db';
import {
  makeApplication,
  makeClient,
  makeContract,
  makeContractScenario,
  makeFreelancer,
  makeProject,
} from './helpers/factories';

/** A COMPLETED contract — the only state in which a review may be written. */
const completedScenario = () => makeContractScenario({ contract: { status: 'COMPLETED' } });

/** Local helper: seeds a review row directly, so `createdAt` can be pinned for ordering tests. */
function makeReview(
  ids: { contractId: string; reviewerId: string; revieweeId: string },
  overrides: Partial<Prisma.ReviewUncheckedCreateInput> = {},
) {
  return prisma.review.create({
    data: {
      ...ids,
      rating: 5,
      content: 'Great collaboration.',
      ...overrides,
    },
  });
}

/**
 * `makeContractScenario` mints a fresh freelancer each call, so building several reviews
 * *received by one* freelancer needs the chain assembled by hand.
 */
async function contractFor(freelancerId: string) {
  const client = await makeClient();
  const project = await makeProject(client.id, { status: 'COMPLETED' });
  const application = await makeApplication(project.id, freelancerId, { status: 'ACCEPTED' });
  const contract = await makeContract(
    { projectId: project.id, applicationId: application.id, clientId: client.id, freelancerId },
    { status: 'COMPLETED' },
  );

  return { client, project, application, contract };
}

describe('POST /api/reviews', () => {
  it('creates the review with 201 and persists it', async () => {
    const { contract, client, freelancer } = await completedScenario();

    const res = await authed(client).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: 5,
      content: '기한을 잘 지켰습니다.',
      tags: ['빠른 응답', '전문성'],
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      contractId: contract.id,
      reviewerId: client.id,
      revieweeId: freelancer.id,
      rating: 5,
      content: '기한을 잘 지켰습니다.',
      tags: ['빠른 응답', '전문성'],
    });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.createdAt).toEqual(expect.any(String));

    const stored = await prisma.review.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored).toMatchObject({
      contractId: contract.id,
      reviewerId: client.id,
      revieweeId: freelancer.id,
      rating: 5,
      tags: ['빠른 응답', '전문성'],
    });
  });

  it('lets the freelancer review the client too', async () => {
    const { contract, client, freelancer } = await completedScenario();

    const res = await authed(freelancer).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: client.id,
      rating: 4,
      content: 'Clear requirements.',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ reviewerId: freelancer.id, revieweeId: client.id, rating: 4 });
  });

  it('lets both parties each leave exactly one review on the same contract', async () => {
    const { contract, client, freelancer } = await completedScenario();

    const fromClient = await authed(client).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: 5,
      content: 'From the client.',
    });
    const fromFreelancer = await authed(freelancer).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: client.id,
      rating: 3,
      content: 'From the freelancer.',
    });

    expect(fromClient.status).toBe(201);
    expect(fromFreelancer.status).toBe(201);

    const rows = await prisma.review.findMany({
      where: { contractId: contract.id },
      orderBy: { rating: 'desc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.reviewerId).sort()).toEqual([client.id, freelancer.id].sort());
  });

  it('rejects a second review by the same reviewer on the same contract with 409', async () => {
    const { contract, client, freelancer } = await completedScenario();
    const body = {
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: 5,
      content: 'First review.',
    };

    const first = await authed(client).post('/api/reviews').send(body);
    const second = await authed(client)
      .post('/api/reviews')
      .send({ ...body, rating: 1, content: 'Second review.' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: { message: 'You have already reviewed this contract' },
    });

    const rows = await prisma.review.findMany({ where: { contractId: contract.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('First review.');
  });

  const requiredFields = [
    ['contractId', 'contractId: Contract ID is required'],
    ['revieweeId', 'revieweeId: Reviewee ID is required'],
    ['rating', 'rating: Rating is required'],
    ['content', 'content: Content is required'],
  ] as const;

  /**
   * Every field except the one under test is a real, valid value from a real COMPLETED contract,
   * so the omitted field is the *only* reason the request can fail. Placeholder ids would pass
   * today purely because validation runs before the contract lookup — the moment that order
   * changed they would 404 and still look like a correct rejection.
   */
  it.each(requiredFields)('rejects a request missing %s with 400', async (field, message) => {
    const { contract, client, freelancer } = await completedScenario();
    const body: Record<string, unknown> = {
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: 5,
      content: 'Otherwise valid.',
    };
    delete body[field];

    const res = await authed(client).post('/api/reviews').send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message } });
    expect(await prisma.review.count()).toBe(0);
  });

  it('rejects an empty body with 400, reporting the first field', async () => {
    const client = await makeClient();

    const res = await authed(client).post('/api/reviews').send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'contractId: Contract ID is required' } });
  });

  // Validation runs before the contract lookup, so an unknown contract with a bad body
  // is a 400, not a 404.
  it('validates the body before looking the contract up', async () => {
    const client = await makeClient();

    const res = await authed(client).post('/api/reviews').send({
      contractId: '00000000-0000-4000-8000-000000000000',
      revieweeId: '00000000-0000-4000-8000-000000000001',
      rating: 9,
      content: 'Unknown contract.',
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'rating: Rating must be an integer between 1 and 5' } });
  });

  it.each([
    ['a blank content', { content: '   ' }, 'content: Content is required'],
    ['a numeric content', { content: 5 }, 'content: Content must be a string'],
    ['an empty contractId', { contractId: '' }, 'contractId: Contract ID is required'],
    ['an object contractId', { contractId: { not: '' } }, 'contractId: Contract ID must be a string'],
    ['a numeric revieweeId', { revieweeId: 12345 }, 'revieweeId: Reviewee ID must be a string'],
    // JSON only: a numeric string is not coerced (the client sends a number).
    ['a numeric-string rating', { rating: '5' }, 'rating: Rating must be an integer between 1 and 5'],
    ['a null rating', { rating: null }, 'rating: Rating must be an integer between 1 and 5'],
  ])('rejects %s with 400 rather than 500', async (_label, patch, message) => {
    const { contract, client, freelancer } = await completedScenario();

    const res = await authed(client).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: 5,
      content: 'Otherwise valid.',
      ...patch,
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message } });
    expect(await prisma.review.count()).toBe(0);
  });

  it('stores the content trimmed', async () => {
    const { contract, client, freelancer } = await completedScenario();

    const res = await authed(client).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: 4,
      content: '  좋았습니다.  ',
    });

    expect(res.status).toBe(201);
    expect(res.body.content).toBe('좋았습니다.');
  });

  it('rejects rating 0 as out of range', async () => {
    // Before the zod schema, `!rating` caught 0 as a *missing* field ("All fields are
    // required"); it is now an out-of-range value like any other.
    const { contract, client, freelancer } = await completedScenario();

    const res = await authed(client).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: 0,
      content: 'Zero rating.',
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'rating: Rating must be an integer between 1 and 5' } });
    expect(await prisma.review.count()).toBe(0);
  });

  it.each([-1, 6, 100])('rejects an out-of-range rating (%s) with 400', async (rating) => {
    const { contract, client, freelancer } = await completedScenario();

    const res = await authed(client).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating,
      content: 'Out of range.',
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'rating: Rating must be an integer between 1 and 5' } });
    expect(await prisma.review.count()).toBe(0);
  });

  it.each([1, 5])('accepts the boundary rating %s', async (rating) => {
    const { contract, client, freelancer } = await completedScenario();

    const res = await authed(client).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating,
      content: 'Boundary rating.',
    });

    expect(res.status).toBe(201);
    expect(res.body.rating).toBe(rating);
  });

  // Fixed by the zod schema (#4). `rating < 1 || rating > 5` used to run before coercion:
  // both comparisons are false for "abc", then `parseInt('abc')` was NaN and Prisma rejected it
  // with a 500.
  it('rejects a non-numeric rating with 400', async () => {
    const { contract, client, freelancer } = await completedScenario();

    const res = await authed(client).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: 'abc',
      content: 'Non-numeric rating.',
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'rating: Rating must be an integer between 1 and 5' } });
    expect(await prisma.review.count()).toBe(0);
  });

  // Same root cause with a different payload shape — an object escaped both comparisons.
  it('rejects an object rating with 400', async () => {
    const { contract, client, freelancer } = await completedScenario();

    const res = await authed(client).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: { value: 5 },
      content: 'Object rating.',
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'rating: Rating must be an integer between 1 and 5' } });
    expect(await prisma.review.count()).toBe(0);
  });

  // The third symptom: 3.7 passed the range check and `parseInt` truncated it to 3, so the review
  // was accepted with a rating the caller never sent. A rating is an integer 1–5.
  it('rejects a fractional rating with 400', async () => {
    const { contract, client, freelancer } = await completedScenario();

    const res = await authed(client).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: 3.7,
      content: 'Fractional rating.',
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'rating: Rating must be an integer between 1 and 5' } });
    expect(await prisma.review.count()).toBe(0);
  });

  it('returns 403 for an outsider even when the contract is not COMPLETED', async () => {
    // Ownership is checked before status, so the outsider learns nothing about the contract.
    const { contract, freelancer } = await makeContractScenario({ contract: { status: 'PENDING' } });
    const outsider = await makeClient();

    const res = await authed(outsider).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: 5,
      content: 'Not my contract.',
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { message: 'Not authorized' } });
  });

  it('returns 404 for an unknown contract', async () => {
    const client = await makeClient();
    const freelancer = await makeFreelancer();

    const res = await authed(client).post('/api/reviews').send({
      contractId: 'no-such-contract',
      revieweeId: freelancer.id,
      rating: 5,
      content: 'Unknown contract.',
    });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Contract not found' } });
    expect(await prisma.review.count()).toBe(0);
  });

  it('treats a completed contract whose project the client deleted as not found', async () => {
    const { contract, project, client, freelancer } = await completedScenario();
    // A completed contract does not block deletion, so the client can remove the project.
    const deleted = await authed(client).delete(`/api/projects/${project.id}`);
    expect(deleted.status).toBe(200);

    const res = await authed(freelancer).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: client.id,
      rating: 5,
      content: 'Project is gone.',
    });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Contract not found' } });
    expect(await prisma.review.count()).toBe(0);
  });

  it.each(['PENDING', 'ACTIVE'] as const)(
    'returns 400 when the contract is %s rather than COMPLETED',
    async (status) => {
      const { contract, client, freelancer } = await makeContractScenario({ contract: { status } });

      const res = await authed(client).post('/api/reviews').send({
        contractId: contract.id,
        revieweeId: freelancer.id,
        rating: 5,
        content: 'Too early.',
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: { message: 'Reviews can only be written after project completion' },
      });
      expect(await prisma.review.count()).toBe(0);
    },
  );

  it('returns 400 when the reviewee is a third party', async () => {
    const { contract, client } = await completedScenario();
    const stranger = await makeFreelancer();

    const res = await authed(client).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: stranger.id,
      rating: 5,
      content: 'Wrong reviewee.',
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Invalid reviewee' } });
    expect(await prisma.review.count()).toBe(0);
  });

  it('refuses a client reviewing themselves with 400', async () => {
    const { contract, client } = await completedScenario();

    const res = await authed(client).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: client.id,
      rating: 5,
      content: 'Self review.',
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Invalid reviewee' } });
    expect(await prisma.review.count()).toBe(0);
  });

  it('refuses a freelancer reviewing themselves with 400', async () => {
    const { contract, freelancer } = await completedScenario();

    const res = await authed(freelancer).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: 5,
      content: 'Self review.',
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Invalid reviewee' } });
    expect(await prisma.review.count()).toBe(0);
  });

  const nonArrayTagCases: Array<[string, unknown]> = [
    ['a string', 'not-an-array'],
    ['a number', 7],
    ['an object', { a: 1 }],
    ['null', null],
  ];

  it.each(nonArrayTagCases)('defaults tags to [] when tags is %s', async (_label, tags) => {
    const { contract, client, freelancer } = await completedScenario();

    const res = await authed(client).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: 5,
      content: 'Bad tags.',
      tags,
    });

    expect(res.status).toBe(201);
    expect(res.body.tags).toEqual([]);

    const stored = await prisma.review.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.tags).toEqual([]);
  });

  it('defaults tags to [] when tags is omitted', async () => {
    const { contract, client, freelancer } = await completedScenario();

    const res = await authed(client).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: 5,
      content: 'No tags.',
    });

    expect(res.status).toBe(201);
    expect(res.body.tags).toEqual([]);
  });

  // Fixed by the zod schema (#12). `Array.isArray(tags)` is true for `[1, 2]`, so the array
  // used to reach Prisma unchanged and be rejected against the `String[]` column — a 500. A
  // malformed value is a 400. (Non-array tags still default to `[]`, covered above.)
  it('rejects a tags array of non-strings with 400', async () => {
    const { contract, client, freelancer } = await completedScenario();

    const res = await authed(client).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: 5,
      content: 'Numeric tags.',
      tags: [1, 2],
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'tags.0: Tags must be strings' } });
  });

  // The half that already held before the fix: the write must not land.
  it('creates no review when tags is an array of non-strings', async () => {
    const { contract, client, freelancer } = await completedScenario();

    const res = await authed(client).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: 5,
      content: 'Numeric tags.',
      tags: [1, 2],
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.review.count()).toBe(0);
  });

  it('stores an array of tags exactly as given, including an empty array', async () => {
    const { contract, client, freelancer } = await completedScenario();

    const res = await authed(client).post('/api/reviews').send({
      contractId: contract.id,
      revieweeId: freelancer.id,
      rating: 5,
      content: 'Empty tags.',
      tags: [],
    });

    expect(res.status).toBe(201);
    const stored = await prisma.review.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.tags).toEqual([]);
  });
});

describe('GET /api/reviews/users/:id', () => {
  it('is public — no token required', async () => {
    const freelancer = await makeFreelancer();

    const res = await api().get(`/api/reviews/users/${freelancer.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns [] for an unknown user rather than 404', async () => {
    const res = await api().get('/api/reviews/users/no-such-user');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns the reviews received by that user, newest first', async () => {
    const freelancer = await makeFreelancer();
    const older = await contractFor(freelancer.id);
    const newer = await contractFor(freelancer.id);

    await makeReview(
      { contractId: older.contract.id, reviewerId: older.client.id, revieweeId: freelancer.id },
      { content: 'older', rating: 3, createdAt: new Date('2026-01-01T00:00:00.000Z') },
    );
    await makeReview(
      { contractId: newer.contract.id, reviewerId: newer.client.id, revieweeId: freelancer.id },
      { content: 'newer', rating: 5, createdAt: new Date('2026-06-01T00:00:00.000Z') },
    );

    const res = await api().get(`/api/reviews/users/${freelancer.id}`);

    expect(res.status).toBe(200);
    expect(res.body.map((r: { content: string }) => r.content)).toEqual(['newer', 'older']);
  });

  it('excludes reviews the user wrote, returning only the ones received', async () => {
    const { contract, client, freelancer } = await completedScenario();
    await makeReview(
      { contractId: contract.id, reviewerId: client.id, revieweeId: freelancer.id },
      { content: 'client → freelancer' },
    );
    await makeReview(
      { contractId: contract.id, reviewerId: freelancer.id, revieweeId: client.id },
      { content: 'freelancer → client' },
    );

    const received = await api().get(`/api/reviews/users/${freelancer.id}`);

    expect(received.status).toBe(200);
    expect(received.body).toHaveLength(1);
    expect(received.body[0].content).toBe('client → freelancer');
    expect(received.body[0].revieweeId).toBe(freelancer.id);
  });

  it('includes the reviewer snippet and nothing more of the reviewer', async () => {
    const freelancer = await makeFreelancer();
    const { contract, client } = await contractFor(freelancer.id);
    await prisma.user.update({
      where: { id: client.id },
      data: { profileImage: 'https://example.test/avatar.png' },
    });
    await makeReview({
      contractId: contract.id,
      reviewerId: client.id,
      revieweeId: freelancer.id,
    });

    const res = await api().get(`/api/reviews/users/${freelancer.id}`);

    expect(res.status).toBe(200);
    expect(res.body[0].reviewer).toEqual({
      id: client.id,
      name: client.name,
      profileImage: 'https://example.test/avatar.png',
    });
    expect(Object.keys(res.body[0].reviewer).sort()).toEqual(['id', 'name', 'profileImage']);
  });

  it('returns an identical body from the alias GET /api/users/:id/reviews', async () => {
    const freelancer = await makeFreelancer();
    const a = await contractFor(freelancer.id);
    const b = await contractFor(freelancer.id);
    await makeReview(
      { contractId: a.contract.id, reviewerId: a.client.id, revieweeId: freelancer.id },
      { content: 'first', createdAt: new Date('2026-02-01T00:00:00.000Z') },
    );
    await makeReview(
      { contractId: b.contract.id, reviewerId: b.client.id, revieweeId: freelancer.id },
      { content: 'second', createdAt: new Date('2026-03-01T00:00:00.000Z') },
    );

    const viaReviews = await api().get(`/api/reviews/users/${freelancer.id}`);
    const viaUsers = await api().get(`/api/users/${freelancer.id}/reviews`);

    expect(viaUsers.status).toBe(viaReviews.status);
    expect(viaUsers.status).toBe(200);
    expect(viaUsers.body).toHaveLength(2);
    expect(viaUsers.body).toEqual(viaReviews.body);
  });

  it('returns identical empty bodies from both mounts for an unknown user', async () => {
    const viaReviews = await api().get('/api/reviews/users/ghost');
    const viaUsers = await api().get('/api/users/ghost/reviews');

    expect(viaReviews.status).toBe(200);
    expect(viaUsers.status).toBe(200);
    expect(viaUsers.body).toEqual(viaReviews.body);
  });
});
