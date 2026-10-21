import { describe, expect, it } from 'vitest';
import type { Prisma, User } from '@prisma/client';

import { authed } from './helpers/api';
import { prisma } from './helpers/db';
import {
  daysFromNow,
  makeApplication,
  makeClient,
  makeContract,
  makeFreelancer,
  makePortfolioItem,
  makeProject,
} from './helpers/factories';

/**
 * Skill-based recommendations — BEHAVIOR.md RC1–RC8. The role matrix and the RC3 404/403 rows live
 * in `authorization.test.ts`; the pure scoring functions are pinned in `lib.test.ts`.
 */

// ---------------------------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------------------------

/** One received review per rating, each on its own completed contract with its own client. */
async function giveReviews(freelancerId: string, ratings: number[]) {
  for (const rating of ratings) {
    const client = await makeClient();
    const project = await makeProject(client.id, { status: 'COMPLETED' });
    const application = await makeApplication(project.id, freelancerId, { status: 'ACCEPTED' });
    const contract = await makeContract(
      { projectId: project.id, applicationId: application.id, clientId: client.id, freelancerId },
      { status: 'COMPLETED' },
    );
    await prisma.review.create({
      data: { contractId: contract.id, reviewerId: client.id, revieweeId: freelancerId, rating, content: '좋아요', tags: [] },
    });
  }
}

let bulkSeq = 0;

/** Many complete freelancers at once (no password: they never log in). */
async function bulkFreelancers(count: number, data: (index: number) => Partial<Prisma.UserCreateManyInput>) {
  const batch = (bulkSeq += 1);
  await prisma.user.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      email: `bulk${batch}-${index}@test.local`,
      name: `Bulk ${index}`,
      role: 'FREELANCER' as const,
      skills: ['React'],
      activityCategory: '디자인',
      experienceYears: 0,
      hourlyRate: 10_000,
      ...data(index),
    })),
  });
}

const recommendedFreelancers = (client: User, projectId: string, query = '') =>
  authed(client).get(`/api/projects/${projectId}/recommended-freelancers${query}`);

const recommendedProjects = (freelancer: User, query = '') =>
  authed(freelancer).get(`/api/users/me/recommended-projects${query}`);

const ids = (list: { id: string }[]) => list.map((entry) => entry.id);

// ---------------------------------------------------------------------------------------------
// RC3–RC5
// ---------------------------------------------------------------------------------------------

describe('GET /api/projects/:id/recommended-freelancers', () => {
  it('scores the RC4 worked example at 69.17 [RC4] [RC2]', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id, { requiredSkills: ['React', 'Node.js', 'SQL'], category: '웹 개발' });
    // Stored under an alias: the prefilter must still find it, and the score compares normalized.
    const candidate = await makeFreelancer({ skills: ['React', 'PostgreSQL', 'Java'], activityCategory: '웹 개발', experienceYears: 4 });
    await makePortfolioItem(candidate.id, { skills: ['React'] });
    await giveReviews(candidate.id, [4, 5]);

    const res = await recommendedFreelancers(client, project.id);

    expect(res.status).toBe(200);
    expect(res.body.freelancers).toHaveLength(1);
    expect(res.body.freelancers[0]).toMatchObject({
      id: candidate.id,
      score: 69.17,
      matchedSkills: ['React', 'SQL'],
      avgRating: 4.5,
      reviewCount: 2,
    });
  });

  it('returns exactly the RC5 fields — no email — with a 3-item portfolio preview in PF5 order [RC5]', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id);
    const candidate = await makeFreelancer({ profileImage: 'https://img.example.com/me.png' });
    const items = [];
    for (let i = 0; i < 4; i += 1) items.push(await makePortfolioItem(candidate.id, { imageUrl: i === 0 ? 'https://img.example.com/p.png' : null }));

    const res = await recommendedFreelancers(client, project.id);
    const [entry] = res.body.freelancers;

    expect(Object.keys(entry).sort()).toEqual([
      'activityCategory', 'avgRating', 'experienceYears', 'hourlyRate', 'id', 'matchedSkills', 'name',
      'portfolioPreview', 'profileImage', 'reviewCount', 'score', 'skills',
    ]);
    expect(entry).toMatchObject({
      name: candidate.name,
      profileImage: 'https://img.example.com/me.png',
      activityCategory: '웹 개발',
      experienceYears: 3,
      hourlyRate: 50_000,
      skills: ['React', 'Node.js'],
      avgRating: null,
      reviewCount: 0,
    });
    expect(entry.portfolioPreview).toEqual(items.slice(0, 3).map((item) => ({ id: item.id, title: item.title, imageUrl: item.imageUrl })));
    expect(JSON.stringify(res.body)).not.toContain(candidate.email);
  });

  it('prefilters to complete, active freelancers who share a skill and never applied [RC3] [PF20]', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id, { requiredSkills: ['React'] });
    const eligible = await makeFreelancer();
    const excluded = [
      await makeFreelancer({ deletedAt: new Date() }),
      await makeFreelancer({ skills: ['Java'] }),
      await makeFreelancer({ skills: [] }),
      await makeFreelancer({ activityCategory: null }),
      await makeFreelancer({ activityCategory: '   ' }),
      await makeFreelancer({ experienceYears: null }),
      await makeFreelancer({ experienceYears: -1 }),
      await makeFreelancer({ hourlyRate: null }),
      await makeFreelancer({ hourlyRate: 0 }),
      await makeClient({ skills: ['React'] }),
    ];
    const rejectedApplicant = await makeFreelancer();
    await makeApplication(project.id, rejectedApplicant.id, { status: 'REJECTED' });
    const pendingApplicant = await makeFreelancer();
    await makeApplication(project.id, pendingApplicant.id);

    const res = await recommendedFreelancers(client, project.id);

    expect(res.status).toBe(200);
    expect(ids(res.body.freelancers)).toEqual([eligible.id]);
    expect(excluded).toHaveLength(10);
  });

  it('against a project with no required skills, every complete freelancer is a candidate with 0 skill points [RC2] [RC3]', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id, { requiredSkills: [], category: '웹 개발' });
    const a = await makeFreelancer({ skills: ['Java'], experienceYears: 10 });
    const b = await makeFreelancer({ skills: ['Figma'], activityCategory: '디자인', experienceYears: 0 });

    const res = await recommendedFreelancers(client, project.id);

    expect(res.body.freelancers.map((f: { id: string; score: number; matchedSkills: string[] }) => [f.id, f.score, f.matchedSkills]))
      .toEqual([[a.id, 15 + 9 + 10, []], [b.id, 9, []]]);
  });

  it('breaks score ties by reviewCount desc, then id asc [RC4]', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id, { requiredSkills: ['React'] });
    // A single 3-star review is worth 9 rating points — exactly the no-review default.
    const reviewed = await makeFreelancer();
    await giveReviews(reviewed.id, [3]);
    const plainA = await makeFreelancer();
    const plainB = await makeFreelancer();

    const res = await recommendedFreelancers(client, project.id);

    const scores = res.body.freelancers.map((f: { score: number }) => f.score);
    expect(new Set(scores).size).toBe(1);
    expect(ids(res.body.freelancers)).toEqual([reviewed.id, ...[plainA.id, plainB.id].sort()]);
  });

  it('cuts the prefilter at 200 rows ordered by createdAt asc, id asc — before scoring [RC1] [RC3]', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id, { requiredSkills: ['React'], category: '웹 개발' });
    const base = Date.now() - 1_000_000;
    await bulkFreelancers(200, (index) => ({ createdAt: new Date(base + index) }));
    // The best candidate by far, but the 201st row in prefilter order.
    const late = await makeFreelancer({ activityCategory: '웹 개발', experienceYears: 10 });

    const res = await recommendedFreelancers(client, project.id, '?limit=20');

    expect(res.body.freelancers).toHaveLength(20);
    expect(ids(res.body.freelancers)).not.toContain(late.id);

    // Positive control: the same candidate inside the first 200 tops the list.
    await prisma.user.update({ where: { id: late.id }, data: { createdAt: new Date(base - 1) } });
    const again = await recommendedFreelancers(client, project.id, '?limit=20');
    expect(again.body.freelancers[0].id).toBe(late.id);
  });

  it('returns 10 by default and caps limit at 20 [RC1]', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id, { requiredSkills: ['React'] });
    await bulkFreelancers(25, () => ({}));

    const byDefault = await recommendedFreelancers(client, project.id);
    const capped = await recommendedFreelancers(client, project.id, '?limit=500');
    const three = await recommendedFreelancers(client, project.id, '?limit=3');
    const empty = await recommendedFreelancers(client, project.id, '?limit=');

    expect(byDefault.body.freelancers).toHaveLength(10);
    expect(capped.body.freelancers).toHaveLength(20);
    expect(three.body.freelancers).toHaveLength(3);
    expect(empty.body.freelancers).toHaveLength(10);
  });

  it.each(['?limit=0', '?limit=-1', '?limit=1.5', '?limit=2abc', '?limit=1&limit=2', '?page=2&limit=x'])(
    '400s %s [RC1]',
    async (query) => {
      const client = await makeClient();
      const project = await makeProject(client.id);

      const res = await recommendedFreelancers(client, project.id, query);

      expect(res.status).toBe(400);
      expect(res.body.error.message.startsWith('limit: ')).toBe(true);
    },
  );

  it('orders its checks role → validation → existence [RC3]', async () => {
    const client = await makeClient();
    const freelancer = await makeFreelancer();

    const asFreelancer = await authed(freelancer).get('/api/projects/missing-project-id/recommended-freelancers?limit=0');
    const invalidOnMissing = await recommendedFreelancers(client, 'missing-project-id', '?limit=0');
    const validOnMissing = await recommendedFreelancers(client, 'missing-project-id');

    expect(asFreelancer.status).toBe(403);
    expect(asFreelancer.body).toEqual({ error: { message: 'Insufficient permissions' } });
    expect(invalidOnMissing.status).toBe(400);
    expect(validOnMissing.status).toBe(404);
    expect(validOnMissing.body).toEqual({ error: { message: 'Project not found' } });
  });

  it('404s a soft-deleted project (rule 5) [RC3]', async () => {
    const client = await makeClient();
    const project = await makeProject(client.id, { deletedAt: new Date() });

    const res = await recommendedFreelancers(client, project.id);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'Project not found' } });
  });

  it('works for any project status and is read-only: no lifecycle sweep [RC1] [RC3]', async () => {
    const client = await makeClient();
    const expired = await makeProject(client.id, { status: 'OPEN', deadline: daysFromNow(-2) });
    const applicant = await makeFreelancer();
    const application = await makeApplication(expired.id, applicant.id);
    const completed = await makeProject(client.id, { status: 'COMPLETED' });
    await makeFreelancer();

    const onExpired = await recommendedFreelancers(client, expired.id);
    const onCompleted = await recommendedFreelancers(client, completed.id);

    expect(onExpired.status).toBe(200);
    expect(onCompleted.status).toBe(200);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: expired.id } })).status).toBe('OPEN');
    expect((await prisma.application.findUniqueOrThrow({ where: { id: application.id } })).status).toBe('PENDING');
  });
});

// ---------------------------------------------------------------------------------------------
// RC6–RC8
// ---------------------------------------------------------------------------------------------

describe('GET /api/users/me/recommended-projects', () => {
  it('scores the RC7 worked example at 66.96 [RC7]', async () => {
    const freelancer = await makeFreelancer({ skills: ['React', 'TypeScript'], activityCategory: '웹 개발' });
    const project = await makeProject((await makeClient()).id, {
      category: '웹 개발',
      requiredSkills: ['React', 'Node.js'],
      createdAt: daysFromNow(-14),
      deadline: daysFromNow(10),
    });

    const res = await recommendedProjects(freelancer);

    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0]).toMatchObject({ id: project.id, score: 66.96, matchedSkills: ['React'] });
  });

  it('returns exactly the RC8 fields [RC8]', async () => {
    const freelancer = await makeFreelancer();
    const client = await makeClient({ companyName: '코드잇' });
    const project = await makeProject(client.id);

    const res = await recommendedProjects(freelancer);
    const [entry] = res.body.projects;

    expect(Object.keys(entry).sort()).toEqual([
      'budget', 'category', 'client', 'createdAt', 'deadline', 'id', 'matchedSkills', 'requiredSkills', 'score',
      'status', 'title',
    ]);
    expect(entry).toMatchObject({
      id: project.id,
      title: project.title,
      category: project.category,
      budget: project.budget,
      deadline: project.deadline.toISOString(),
      requiredSkills: ['React'],
      status: 'OPEN',
      createdAt: project.createdAt.toISOString(),
      client: { id: client.id, name: client.name, companyName: '코드잇' },
    });
  });

  it('prefilters to OPEN, unexpired, live projects the caller never applied to, by skill or category [RC6] [RC2]', async () => {
    const freelancer = await makeFreelancer({ skills: ['SQL', 'React'], activityCategory: '웹 개발' });
    const client = await makeClient();
    const byAlias = await makeProject(client.id, { requiredSkills: ['PostgreSQL'], category: '디자인' });
    const byCategory = await makeProject(client.id, { requiredSkills: [], category: '웹 개발' });
    const ofDeletedClient = await makeProject((await makeClient({ deletedAt: new Date() })).id);
    const expired = await makeProject(client.id, { status: 'OPEN', deadline: daysFromNow(-1) });
    const applied = await makeProject(client.id);
    await makeApplication(applied.id, freelancer.id, { status: 'REJECTED' });
    await makeProject(client.id, { status: 'UPCOMING', recruitmentStartDate: daysFromNow(2) });
    await makeProject(client.id, { status: 'CLOSED' });
    await makeProject(client.id, { deletedAt: new Date() });
    await makeProject(client.id, { requiredSkills: ['Java'], category: '디자인' });
    await makeProject(client.id, { requiredSkills: [], category: '디자인' });

    const res = await recommendedProjects(freelancer);

    expect(ids(res.body.projects).sort()).toEqual([byAlias.id, byCategory.id, ofDeletedClient.id].sort());
    const aliasEntry = res.body.projects.find((p: { id: string }) => p.id === byAlias.id);
    expect(aliasEntry.matchedSkills).toEqual(['SQL']);
    // No sweep: the expired project is excluded by its deadline and keeps its status.
    expect((await prisma.project.findUniqueOrThrow({ where: { id: expired.id } })).status).toBe('OPEN');
  });

  it('gives no deadline-room points under 3 days and decays freshness to 0 at 30 days [RC7]', async () => {
    const freelancer = await makeFreelancer({ skills: ['React'], activityCategory: '웹 개발' });
    const client = await makeClient();
    // Full coverage and utilization (60) + category (20).
    const soon = await makeProject(client.id, { deadline: new Date(Date.now() + 2 * 86_400_000), createdAt: daysFromNow(-1) });
    const stale = await makeProject(client.id, { deadline: daysFromNow(20), createdAt: daysFromNow(-31) });
    const fresh = await makeProject(client.id, { deadline: daysFromNow(20), createdAt: daysFromNow(-6) });

    const res = await recommendedProjects(freelancer);
    const score = (id: string) => res.body.projects.find((p: { id: string }) => p.id === id).score;

    expect(score(fresh.id)).toBe(100);
    expect(score(soon.id)).toBe(90);
    expect(score(stale.id)).toBe(90);
    expect(ids(res.body.projects)).toEqual([fresh.id, soon.id, stale.id]);
  });

  it('breaks score ties by deadline asc, then id asc [RC7]', async () => {
    const freelancer = await makeFreelancer();
    const client = await makeClient();
    const deadline = daysFromNow(20);
    const later = await makeProject(client.id, { deadline: daysFromNow(25) });
    const tieA = await makeProject(client.id, { deadline });
    const tieB = await makeProject(client.id, { deadline });

    const res = await recommendedProjects(freelancer);

    expect(ids(res.body.projects)).toEqual([...[tieA.id, tieB.id].sort(), later.id]);
  });

  it('cuts the prefilter at 200 rows ordered by createdAt desc, id asc — before scoring [RC1] [RC6]', async () => {
    const freelancer = await makeFreelancer({ skills: ['React', 'Node.js'], activityCategory: '웹 개발' });
    const client = await makeClient();
    const base = Date.now() - 60_000;
    // The best match by far, but the oldest, so the 201st row in prefilter order.
    const oldest = await makeProject(client.id, { requiredSkills: ['React', 'Node.js'], createdAt: new Date(base - 1) });
    await prisma.project.createMany({
      data: Array.from({ length: 200 }, (_, index) => ({
        title: `Bulk ${index}`,
        description: 'bulk',
        category: '디자인',
        budget: 1_000_000,
        requiredSkills: ['React', 'Figma'],
        deadline: daysFromNow(20),
        status: 'OPEN' as const,
        clientId: client.id,
        createdAt: new Date(base + index),
      })),
    });

    const res = await recommendedProjects(freelancer, '?limit=20');

    expect(res.body.projects).toHaveLength(20);
    expect(ids(res.body.projects)).not.toContain(oldest.id);

    await prisma.project.update({ where: { id: oldest.id }, data: { createdAt: new Date(base + 10_000) } });
    const again = await recommendedProjects(freelancer, '?limit=20');
    expect(again.body.projects[0].id).toBe(oldest.id);
  });

  it('returns 10 by default and caps limit at 20 [RC1]', async () => {
    const freelancer = await makeFreelancer();
    const client = await makeClient();
    for (let i = 0; i < 22; i += 1) await makeProject(client.id);

    const byDefault = await recommendedProjects(freelancer);
    const capped = await recommendedProjects(freelancer, '?limit=21');

    expect(byDefault.body.projects).toHaveLength(10);
    expect(capped.body.projects).toHaveLength(20);
  });

  it('orders its checks role → complete profile → validation [RC6]', async () => {
    const client = await makeClient();
    const incomplete = await makeFreelancer({ hourlyRate: null });
    const complete = await makeFreelancer();

    const asClient = await authed(client).get('/api/users/me/recommended-projects?limit=0');
    const asIncomplete = await recommendedProjects(incomplete, '?limit=0');
    const invalid = await recommendedProjects(complete, '?limit=0');

    expect(asClient.status).toBe(403);
    expect(asClient.body).toEqual({ error: { message: 'Insufficient permissions' } });
    expect(asIncomplete.status).toBe(403);
    expect(asIncomplete.body).toEqual({ error: { message: '프로필을 먼저 완성해주세요' } });
    expect(invalid.status).toBe(400);
  });
});
