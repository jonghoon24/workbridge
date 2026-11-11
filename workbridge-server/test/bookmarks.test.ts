import { describe, expect, it } from 'vitest';

import { authed } from './helpers/api';
import { prisma, sideClient } from './helpers/db';
import { makeClient, makeFreelancer, makeProject } from './helpers/factories';

/**
 * Bookmarks — `GET|POST|DELETE /api/projects/:id/bookmark`, all FREELANCER-only.
 *
 * All three look the project up first: a project that never existed or is soft-deleted is 404
 * (`docs/domain/projects-contracts.md`, 북마크). Removing a bookmark that does not exist on a live
 * project still succeeds — that is the idempotence rule, not a lookup.
 *
 * `GET /api/users/me/bookmarks/ids` gives a list screen every bookmarked id in one request, so its
 * cards do not ask about themselves one by one.
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

  it('returns 404 for a project that never existed', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).get(bookmarkPath(MISSING_PROJECT_ID));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Project not found' } });
  });

  it('returns 404 for a soft-deleted project even when the bookmark row is still there', async () => {
    const { freelancer, project } = await freelancerWithProject();
    await prisma.projectBookmark.create({ data: { projectId: project.id, userId: freelancer.id } });
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    const res = await authed(freelancer).get(bookmarkPath(project.id));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Project not found' } });
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

    // The open insert and the poll run on their own pool, never the app's — see `sideClient`.
    const side = sideClient();
    let release = () => {};
    let holding!: () => void;
    const held = new Promise<void>((resolve) => { holding = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const holder = side.$transaction(async (tx) => {
      await tx.projectBookmark.create({ data: { projectId: project.id, userId: freelancer.id } });
      holding();
      await released;
    }, { timeout: 10_000 });

    let request: Promise<{ status: number; body: unknown }> | undefined;
    try {
      await held;
      // supertest sends lazily; `then` starts it while the side transaction still holds the row.
      request = authed(freelancer).post(bookmarkPath(project.id)).then((res) => res);

      // Wait until the request is queued on the uncommitted insert, then commit it.
      const giveUpAt = Date.now() + 5_000;
      for (;;) {
        const [{ waiting }] = await side.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (waiting > 0) break;
        if (Date.now() > giveUpAt) throw new Error('the request never blocked on the open insert');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      release();
      await holder;

      const res = await request;
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ bookmarked: true });
      expect(await countBookmarks()).toBe(1);
    } finally {
      release();
      await holder.catch(() => {});
      await request?.catch(() => {});
      await side.$disconnect();
    }
  }, 20_000);
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

  it('returns 404 for a project that never existed', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).delete(bookmarkPath(MISSING_PROJECT_ID));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Project not found' } });
  });

  it('returns 404 for a soft-deleted project and leaves the bookmark row in place', async () => {
    const { freelancer, project } = await freelancerWithProject();
    await prisma.projectBookmark.create({ data: { projectId: project.id, userId: freelancer.id } });
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    const res = await authed(freelancer).delete(bookmarkPath(project.id));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Project not found' } });
    expect(await countBookmarks({ projectId: project.id, userId: freelancer.id })).toBe(1);
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

  it('leaves out a project whose client is soft-deleted, as the public list does', async () => {
    const { client, freelancer, project } = await freelancerWithProject();
    const otherClient = await makeClient();
    const live = await makeProject(otherClient.id);
    await prisma.projectBookmark.createMany({
      data: [
        { projectId: project.id, userId: freelancer.id },
        { projectId: live.id, userId: freelancer.id },
      ],
    });
    await prisma.user.update({ where: { id: client.id }, data: { deletedAt: new Date() } });

    const res = await authed(freelancer).get('/api/users/me/bookmarks');

    expect(res.status).toBe(200);
    expect(res.body.map((p: { id: string }) => p.id)).toEqual([live.id]);
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

describe('GET /api/users/me/bookmarks/ids', () => {
  const idsPath = '/api/users/me/bookmarks/ids';

  it('returns an empty list when the freelancer has no bookmarks', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).get(idsPath);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ projectIds: [] });
  });

  it('returns the bookmarked project ids, newest bookmark first', async () => {
    const client = await makeClient();
    const freelancer = await makeFreelancer();
    const older = await makeProject(client.id);
    const newer = await makeProject(client.id);
    const notBookmarked = await makeProject(client.id);
    await prisma.projectBookmark.create({
      data: { projectId: older.id, userId: freelancer.id, createdAt: new Date('2026-01-01T00:00:00Z') },
    });
    await prisma.projectBookmark.create({
      data: { projectId: newer.id, userId: freelancer.id, createdAt: new Date('2026-01-02T00:00:00Z') },
    });

    const res = await authed(freelancer).get(idsPath);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ projectIds: [newer.id, older.id] });
    expect(res.body.projectIds).not.toContain(notBookmarked.id);
  });

  it("leaves out another freelancer's bookmarks", async () => {
    const { freelancer, project } = await freelancerWithProject();
    const other = await makeFreelancer();
    await prisma.projectBookmark.create({ data: { projectId: project.id, userId: other.id } });

    const res = await authed(freelancer).get(idsPath);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ projectIds: [] });
  });

  it('leaves out a soft-deleted project, as the bookmark list does', async () => {
    const { client, freelancer, project } = await freelancerWithProject();
    const live = await makeProject(client.id);
    await prisma.projectBookmark.createMany({
      data: [
        { projectId: project.id, userId: freelancer.id },
        { projectId: live.id, userId: freelancer.id },
      ],
    });
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    const res = await authed(freelancer).get(idsPath);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ projectIds: [live.id] });
  });

  it('follows bookmarks added and removed through the bookmark endpoints', async () => {
    const { freelancer, project } = await freelancerWithProject();

    await authed(freelancer).post(bookmarkPath(project.id));
    expect((await authed(freelancer).get(idsPath)).body).toEqual({ projectIds: [project.id] });

    await authed(freelancer).delete(bookmarkPath(project.id));
    expect((await authed(freelancer).get(idsPath)).body).toEqual({ projectIds: [] });
  });

  it('leaves out a project whose client is soft-deleted, as the bookmark list does', async () => {
    const { client, freelancer, project } = await freelancerWithProject();
    const live = await makeProject((await makeClient()).id);
    await prisma.projectBookmark.createMany({
      data: [
        { projectId: project.id, userId: freelancer.id },
        { projectId: live.id, userId: freelancer.id },
      ],
    });
    await prisma.user.update({ where: { id: client.id }, data: { deletedAt: new Date() } });

    const res = await authed(freelancer).get(idsPath);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ projectIds: [live.id] });
  });
});
