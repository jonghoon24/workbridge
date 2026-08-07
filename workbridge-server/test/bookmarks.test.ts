import { describe, expect, it } from 'vitest';

import { authed, type Principal } from './helpers/api';
import { prisma } from './helpers/db';
import { makeClient, makeFreelancer, makeProject } from './helpers/factories';

/**
 * Bookmarks — `GET|POST|DELETE /api/projects/:id/bookmark`, all FREELANCER-only.
 * Spec: docs/BEHAVIOR.md § "Bookmarks — /:id/bookmark".
 *
 * Two separate things are in play on `GET`/`DELETE`, and the suite keeps them apart:
 *   - **D19** — neither verb filters `deletedAt: null`, so a soft-deleted project stays
 *     bookmark-visible. Cross-cutting rule 5 already decides this ("a soft-deleted project must be
 *     invisible to listing, fetching, applying, and bookmarking"), so those tests assert 404 and
 *     are marked `it.fails`.
 *   - **Q6** — whether `GET`/`DELETE` should also 404 for an id that *never existed*, as `POST`
 *     does, is deferred. Those tests pin today's behavior with a plain `it` tagged "(Q6)".
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

/** Sessions on this database currently parked on a lock — i.e. a statement waiting on another. */
async function sessionsWaitingOnALock(): Promise<number> {
  const [{ waiting }] = await prisma.$queryRaw<Array<{ waiting: number }>>`
    SELECT count(*)::int AS waiting
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND state = 'active'
      AND wait_event_type = 'Lock'`;
  return waiting;
}

/**
 * Forces a POST onto the losing side of `projectBookmark.upsert`'s find-then-insert window,
 * without depending on two requests happening to interleave.
 *
 * The test connection opens a transaction, inserts `(projectId, userId)`, and holds it open. A
 * POST then runs its `findUnique`, which cannot see the uncommitted row, and proceeds to `INSERT`
 * — which Postgres parks on the duplicate uncommitted key. Once that wait shows up in
 * `pg_stat_activity`, the holding transaction commits and the parked insert wakes to a unique
 * violation: exactly what two simultaneous POSTs hit, but deterministically.
 *
 * `blockedObserved` reports whether the wait was really seen, so a test can assert the
 * interleaving happened instead of assuming it.
 */
async function postBookmarkLosingTheInsertRace(freelancer: Principal, projectId: string) {
  let announceInserted: () => void = () => {};
  const inserted = new Promise<void>((resolve) => { announceInserted = resolve; });
  let commit: () => void = () => {};
  const held = new Promise<void>((resolve) => { commit = resolve; });

  const holder = prisma.$transaction(
    async (tx) => {
      await tx.projectBookmark.create({ data: { projectId, userId: freelancer.id } });
      announceInserted();
      await held;
    },
    { timeout: 20_000, maxWait: 10_000 },
  );

  try {
    // Raced against `holder` so that a transaction that fails before inserting surfaces as its own
    // error rather than hanging here until the test times out.
    await Promise.race([
      inserted,
      holder.then(() => { throw new Error('the holding transaction ended before it inserted'); }),
    ]);

    // `.then()` is what dispatches a supertest request; merely building it sends nothing.
    let settled = false;
    const post = authed(freelancer)
      .post(bookmarkPath(projectId))
      .then((res) => { settled = true; return res; });

    let blockedObserved = false;
    const deadline = Date.now() + 5_000;
    while (!settled && Date.now() < deadline) {
      if (await sessionsWaitingOnALock() > 0) {
        blockedObserved = true;
        break;
      }
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }

    commit();
    return { res: await post, blockedObserved };
  } finally {
    commit();
    await holder;
  }
}

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

  // ---- Q6: GET does not verify the project, unlike POST -------------------------------------
  // Current behavior: the handler only looks up the (projectId, userId) bookmark row, so an
  // unknown id simply has no bookmark and answers 200 instead of 404.
  it('GET bookmark for a non-existent project currently succeeds with { bookmarked: false } (Q6)', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).get(bookmarkPath(MISSING_PROJECT_ID));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bookmarked: false });
  });

  // ---- D19: rule 5 is unconditional — a soft-deleted project is invisible to bookmarking ------
  // Today: `getProjectBookmark` looks up only the (projectId, userId) bookmark row and never
  // touches the project, so there is no `deletedAt: null` filter and the answer is
  // 200 `{ bookmarked: true }`. Not the Q6 case: rule 5 already decides the soft-deleted one.
  it.fails('[D19] GET bookmark for a soft-deleted project must 404', async () => {
    const { freelancer, project } = await freelancerWithProject();
    await authed(freelancer).post(bookmarkPath(project.id));
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    const res = await authed(freelancer).get(bookmarkPath(project.id));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: expect.any(String) } });
    // Reading must not remove the row either way — the project is deleted, the bookmark is not.
    expect(await countBookmarks()).toBe(1);
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

    // Whatever the statuses are (see the next test), the unique constraint holds the state.
    expect(await countBookmarks()).toBe(1);
  });

  // UNDOCUMENTED DIVERGENCE (not in the [D*] table — reported to the coordinator).
  // The "idempotent (upsert)" guarantee and cross-cutting rule 8 ("unique-constraint collision →
  // 409, never 500") both break when two writes overlap: `prisma.projectBookmark.upsert` is a
  // find-then-insert, not `INSERT … ON CONFLICT`, so a POST that misses the row and then loses the
  // insert raises P2002, which nothing catches → 500, with the raw Prisma error text (absolute
  // source path and a source excerpt, cf. D14) in the response body. The row is still created
  // exactly once, so only the status and the body are wrong.
  //
  // This is driven deterministically by `postBookmarkLosingTheInsertRace` rather than by firing
  // pairs of requests and hoping they overlap. The previous form ran 10 pairs and relied on most
  // of them genuinely racing; an unlucky all-serialized run would have reported a confusing
  // "unexpected pass" instead of the divergence.
  it.fails('is idempotent under concurrency: an insert that loses the race must not 500 [undocumented divergence]', async () => {
    const { freelancer, project } = await freelancerWithProject();

    const { res } = await postBookmarkLosingTheInsertRace(freelancer, project.id);

    // Either repair satisfies the spec: 201 (the upsert absorbs the collision, which is what
    // "idempotent" implies) or 409 (rule 8's status for a unique-constraint collision).
    expect([201, 409]).toContain(res.status);
    expect(await countBookmarks()).toBe(1);
  });

  // Guards the test above. `it.fails` inverts the result, so a test broken in its *setup* would
  // look exactly like a confirmed divergence; this asserts that the interleaving it depends on
  // really happens. It deliberately makes no claim about the status code.
  it('harness check: the losing POST really is parked on a duplicate uncommitted key', async () => {
    const { freelancer, project } = await freelancerWithProject();

    const { blockedObserved } = await postBookmarkLosingTheInsertRace(freelancer, project.id);

    expect(blockedObserved).toBe(true);
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

  // ---- Q6: DELETE does not verify the project, unlike POST ----------------------------------
  // Current behavior: `deleteMany` matches zero rows and the handler answers 200 rather than 404.
  it('DELETE bookmark for a non-existent project currently succeeds (Q6)', async () => {
    const freelancer = await makeFreelancer();

    const res = await authed(freelancer).delete(bookmarkPath(MISSING_PROJECT_ID));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bookmarked: false });
  });

  // ---- D19 ------------------------------------------------------------------------------------
  // Today: `deleteProjectBookmark` runs `deleteMany` on (projectId, userId) with no project
  // lookup, so a soft-deleted project's bookmark is removed and the call answers
  // 200 `{ bookmarked: false }`. Rule 5 requires the project to be invisible here, so the write
  // must not happen at all. Again distinct from the Q6 never-existed-id case above.
  it.fails('[D19] DELETE bookmark for a soft-deleted project must 404 and leave the row', async () => {
    const { freelancer, project } = await freelancerWithProject();
    await authed(freelancer).post(bookmarkPath(project.id));
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    const res = await authed(freelancer).delete(bookmarkPath(project.id));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: expect.any(String) } });
    expect(await countBookmarks()).toBe(1);
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
