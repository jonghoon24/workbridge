import { describe, expect, it } from 'vitest';

import { authed } from './helpers/api';
import { prisma } from './helpers/db';
import { makeClient, makeFreelancer, makeProject } from './helpers/factories';

/**
 * Bookmarks — `GET|POST|DELETE /api/projects/:id/bookmark`, all FREELANCER-only.
 *
 * Unlike `POST`, `GET` and `DELETE` do not look the project up, so an id that never existed is
 * answered as "no bookmark" rather than 404. Whether they should 404 is an open product
 * question; the tests below pin today's behavior.
 */

/** A project id that is guaranteed not to exist (the db was truncated before this test). */
const MISSING_PROJECT_ID = '00000000-0000-4000-8000-000000000000';

const bookmarkPath = (projectId: string) => `/api/projects/${projectId}/bookmark`;

async function freelancerWithProject() {
  const client = await makeClient();
  const freelancer = await makeFreelancer();
  const project = await makeProject(client.id);
  return { client, freelancer, project };
}

const countBookmarks = (where: { projectId?: string; userId?: string } = {}) =>
  prisma.projectBookmark.count({ where });

describe('GET /api/projects/:id/bookmark', () => {
  it('returns { bookmarked: false } when the freelancer has not bookmarked the project', async () => {
    const { freelancer, project } = await freelancerWithProject();

    const res = await authed(freelancer).get(bookmarkPath(project.id));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bookmarked: false });
  });

  it('returns { bookmarked: true } after the project has been bookmarked', async () => {
    const { freelancer, project } = await freelancerWithProject();

    const before = await authed(freelancer).get(bookmarkPath(project.id));
    expect(before.body).toEqual({ bookmarked: false });

    const created = await authed(freelancer).post(bookmarkPath(project.id));
    expect(created.status).toBe(201);

    const after = await authed(freelancer).get(bookmarkPath(project.id));
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ bookmarked: true });
  });

  it('reflects a bookmark row created directly in the database', async () => {
    const { freelancer, project } = await freelancerWithProject();
    await prisma.projectBookmark.create({ data: { projectId: project.id, userId: freelancer.id } });

    const res = await authed(freelancer).get(bookmarkPath(project.id));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bookmarked: true });
  });

  it('does not leak another freelancer\'s bookmark', async () => {
    const { freelancer, project } = await freelancerWithProject();
    const other = await makeFreelancer();
    await authed(other).post(bookmarkPath(project.id));

    const mine = await authed(freelancer).get(bookmarkPath(project.id));
    const theirs = await authed(other).get(bookmarkPath(project.id));

    expect(mine.body).toEqual({ bookmarked: false });
    expect(theirs.body).toEqual({ bookmarked: true });
  });

  // ---- GET does not verify the project, unlike POST ----------------------------------------
  // Current behavior: the handler only looks up the (projectId, userId) bookmark row, so an
  // unknown id simply has no bookmark and answers 200 instead of 404.
  it('GET bookmark for a non-existent project currently succeeds with { bookmarked: false }', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).get(bookmarkPath(MISSING_PROJECT_ID));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bookmarked: false });
  });
});

describe('POST /api/projects/:id/bookmark', () => {
  it('returns 201 { bookmarked: true } and persists exactly one row', async () => {
    const { freelancer, project } = await freelancerWithProject();

    const res = await authed(freelancer).post(bookmarkPath(project.id));

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ bookmarked: true });

    const rows = await prisma.projectBookmark.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectId: project.id, userId: freelancer.id });
  });

  it('is idempotent: bookmarking twice still leaves exactly one row', async () => {
    const { freelancer, project } = await freelancerWithProject();

    const first = await authed(freelancer).post(bookmarkPath(project.id));
    const created = await prisma.projectBookmark.findFirstOrThrow();

    const second = await authed(freelancer).post(bookmarkPath(project.id));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual({ bookmarked: true });

    const rows = await prisma.projectBookmark.findMany();
    expect(rows).toHaveLength(1);
    // The upsert's `update: {}` must not replace the row, so identity and timestamp survive.
    expect(rows[0].id).toBe(created.id);
    expect(rows[0].createdAt.getTime()).toBe(created.createdAt.getTime());
  });

  it('stays idempotent across three calls', async () => {
    const { freelancer, project } = await freelancerWithProject();

    for (let i = 0; i < 3; i += 1) {
      const res = await authed(freelancer).post(bookmarkPath(project.id));
      expect(res.status).toBe(201);
    }

    expect(await countBookmarks()).toBe(1);
  });

  it('returns 404 for a non-existent project and writes nothing', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).post(bookmarkPath(MISSING_PROJECT_ID));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Project not found' } });
    expect(await countBookmarks()).toBe(0);
  });

  it('bookmarks a project whose recruitment is CLOSED — status is not a constraint', async () => {
    const client = await makeClient();
    const freelancer = await makeFreelancer();
    const project = await makeProject(client.id, { status: 'CLOSED' });

    const res = await authed(freelancer).post(bookmarkPath(project.id));

    expect(res.status).toBe(201);
    expect(await countBookmarks({ projectId: project.id })).toBe(1);
  });

  it('allows a freelancer with an incomplete profile — bookmarking is not profile-gated', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const freelancer = await makeFreelancer({
      skills: [],
      activityCategory: null,
      experienceYears: null,
      hourlyRate: null,
    });

    const res = await authed(freelancer).post(bookmarkPath(project.id));

    expect(res.status).toBe(201);
    expect(await countBookmarks({ userId: freelancer.id })).toBe(1);
  });

  it('keeps two freelancers\' bookmarks of the same project separate', async () => {
    const { freelancer, project } = await freelancerWithProject();
    const other = await makeFreelancer();

    expect((await authed(freelancer).post(bookmarkPath(project.id))).status).toBe(201);
    expect((await authed(other).post(bookmarkPath(project.id))).status).toBe(201);

    expect(await countBookmarks({ projectId: project.id })).toBe(2);
    expect(await countBookmarks({ projectId: project.id, userId: freelancer.id })).toBe(1);
    expect(await countBookmarks({ projectId: project.id, userId: other.id })).toBe(1);
  });

  it('never stores a second row when the same bookmark is posted concurrently', async () => {
    const { freelancer, project } = await freelancerWithProject();

    await Promise.all([
      authed(freelancer).post(bookmarkPath(project.id)),
      authed(freelancer).post(bookmarkPath(project.id)),
    ]);

    // Whatever the statuses are, the unique constraint holds the state.
    expect(await countBookmarks()).toBe(1);
  });

  /**
   * A deterministic version of two overlapping `POST`s: the other request is an uncommitted insert
   * of the same key, held open in a transaction. The request must block on it (a `Lock` wait in
   * `pg_stat_activity`) and, once that insert commits, still answer 201 with one row.
   */
  it('answers 201 when an overlapping insert of the same bookmark commits first', async () => {
    const { freelancer, project } = await freelancerWithProject();

    let request: ReturnType<ReturnType<typeof authed>['post']> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.projectBookmark.create({ data: { projectId: project.id, userId: freelancer.id } });

      request = authed(freelancer).post(bookmarkPath(project.id));
      // supertest sends lazily; `then` starts it while this transaction still holds the row.
      void request.then(() => undefined, () => undefined);

      // Polled on another connection until the request is waiting on this transaction's insert.
      const giveUpAt = Date.now() + 5_000;
      for (;;) {
        const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (waiting > 0) break;
        if (Date.now() > giveUpAt) throw new Error('the request never blocked on the open insert');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }, { timeout: 10_000 });

    const res = await request!;
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ bookmarked: true });
    expect(await countBookmarks()).toBe(1);
  });
});

describe('DELETE /api/projects/:id/bookmark', () => {
  it('removes an existing bookmark and returns { bookmarked: false }', async () => {
    const { freelancer, project } = await freelancerWithProject();
    await authed(freelancer).post(bookmarkPath(project.id));
    expect(await countBookmarks()).toBe(1);

    const res = await authed(freelancer).delete(bookmarkPath(project.id));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bookmarked: false });
    expect(await countBookmarks()).toBe(0);
  });

  it('is idempotent: deleting a bookmark that does not exist still succeeds', async () => {
    const { freelancer, project } = await freelancerWithProject();

    const res = await authed(freelancer).delete(bookmarkPath(project.id));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bookmarked: false });
    expect(await countBookmarks()).toBe(0);
  });

  it('is idempotent: deleting twice returns 200 both times', async () => {
    const { freelancer, project } = await freelancerWithProject();
    await authed(freelancer).post(bookmarkPath(project.id));

    const first = await authed(freelancer).delete(bookmarkPath(project.id));
    const second = await authed(freelancer).delete(bookmarkPath(project.id));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ bookmarked: false });
    expect(await countBookmarks()).toBe(0);
  });

  it('can be re-created after deletion', async () => {
    const { freelancer, project } = await freelancerWithProject();

    await authed(freelancer).post(bookmarkPath(project.id));
    await authed(freelancer).delete(bookmarkPath(project.id));
    const again = await authed(freelancer).post(bookmarkPath(project.id));

    expect(again.status).toBe(201);
    expect((await authed(freelancer).get(bookmarkPath(project.id))).body).toEqual({ bookmarked: true });
    expect(await countBookmarks()).toBe(1);
  });

  it('deletes only the caller\'s bookmark, leaving another freelancer\'s intact', async () => {
    const { freelancer, project } = await freelancerWithProject();
    const other = await makeFreelancer();
    await authed(freelancer).post(bookmarkPath(project.id));
    await authed(other).post(bookmarkPath(project.id));

    const res = await authed(freelancer).delete(bookmarkPath(project.id));

    expect(res.status).toBe(200);
    expect(await countBookmarks({ userId: freelancer.id })).toBe(0);
    expect(await countBookmarks({ userId: other.id })).toBe(1);
    expect((await authed(other).get(bookmarkPath(project.id))).body).toEqual({ bookmarked: true });
  });

  // ---- DELETE does not verify the project, unlike POST -------------------------------------
  // Current behavior: `deleteMany` matches zero rows and the handler answers 200 rather than 404.
  it('DELETE bookmark for a non-existent project currently succeeds', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).delete(bookmarkPath(MISSING_PROJECT_ID));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bookmarked: false });
  });
});

/**
 * Cross-check that the rows these endpoints write are the rows the list endpoint reads. Full
 * coverage of `GET /api/users/me/bookmarks` belongs to the users unit; this only pins the link.
 */
describe('GET /api/users/me/bookmarks (reflects rows written by the bookmark endpoints)', () => {
  it('returns the bookmarked project with isBookmarked and bookmarkedAt', async () => {
    const { freelancer, project } = await freelancerWithProject();
    await authed(freelancer).post(bookmarkPath(project.id));

    const res = await authed(freelancer).get('/api/users/me/bookmarks');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: project.id,
      title: project.title,
      isBookmarked: true,
    });
    expect(res.body[0].bookmarkedAt).toBeTruthy();
  });

  it('drops an entry once its bookmark is deleted', async () => {
    const { freelancer, project } = await freelancerWithProject();
    await authed(freelancer).post(bookmarkPath(project.id));
    await authed(freelancer).delete(bookmarkPath(project.id));

    const res = await authed(freelancer).get('/api/users/me/bookmarks');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
