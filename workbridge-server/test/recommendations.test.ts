import { describe, expect, it } from 'vitest';
import type { User } from '@prisma/client';

import { authed } from './helpers/api';
import { prisma } from './helpers/db';
import {
  daysFromNow,
  makeApplication,
  makeClient,
  makeFreelancer,
  makeProject,
} from './helpers/factories';

/**
 * Skill-based project recommendations (scoring table in the JSDoc of `src/lib/recommendations.ts`).
 * The role matrix lives in `authorization.test.ts`; the pure scoring functions are pinned in
 * `lib.test.ts`.
 */

// ---------------------------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------------------------

const recommendedProjects = (freelancer: User, query = '') =>
  authed(freelancer).get(`/api/users/me/recommended-projects${query}`);

const ids = (list: { id: string }[]) => list.map((entry) => entry.id);

// ---------------------------------------------------------------------------------------------
// Projects recommended for a freelancer
// ---------------------------------------------------------------------------------------------

describe('GET /api/users/me/recommended-projects', () => {
  it('scores a half skill match on a 14-day-old project at 66.96', async () => {
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

  it('returns exactly the project summary fields', async () => {
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

  it('prefilters to OPEN, unexpired, live projects the caller never applied to, by skill or category', async () => {
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

    expect(ids(res.body.projects).sort()).toEqual([byAlias.id, byCategory.id].sort());
    expect(ids(res.body.projects)).not.toContain(ofDeletedClient.id);
    const aliasEntry = res.body.projects.find((p: { id: string }) => p.id === byAlias.id);
    expect(aliasEntry.matchedSkills).toEqual(['SQL']);
    // No sweep: the expired project is excluded by its deadline and keeps its status.
    expect((await prisma.project.findUniqueOrThrow({ where: { id: expired.id } })).status).toBe('OPEN');
  });

  it('gives no deadline-room points under 3 days and decays freshness to 0 at 30 days', async () => {
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

  it('breaks score ties by deadline asc, then id asc', async () => {
    const freelancer = await makeFreelancer();
    const client = await makeClient();
    const deadline = daysFromNow(20);
    const later = await makeProject(client.id, { deadline: daysFromNow(25) });
    const tieA = await makeProject(client.id, { deadline });
    const tieB = await makeProject(client.id, { deadline });

    const res = await recommendedProjects(freelancer);

    expect(ids(res.body.projects)).toEqual([...[tieA.id, tieB.id].sort(), later.id]);
  });

  it('cuts the prefilter at 200 rows ordered by createdAt desc, id asc — before scoring', async () => {
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

  it('returns 10 by default and caps limit at 20', async () => {
    const freelancer = await makeFreelancer();
    const client = await makeClient();
    for (let i = 0; i < 22; i += 1) await makeProject(client.id);

    const byDefault = await recommendedProjects(freelancer);
    const capped = await recommendedProjects(freelancer, '?limit=21');

    expect(byDefault.body.projects).toHaveLength(10);
    expect(capped.body.projects).toHaveLength(20);
  });

  it.each(['?limit=0', '?limit=-1', '?limit=1.5', '?limit=2abc', '?limit=1&limit=2', '?page=2&limit=x'])(
    '400s %s',
    async (query) => {
      const freelancer = await makeFreelancer();

      const res = await recommendedProjects(freelancer, query);

      expect(res.status).toBe(400);
      expect(res.body.error.message.startsWith('limit: ')).toBe(true);
    },
  );

  it('orders its checks role → complete profile → validation', async () => {
    const client = await makeClient();
    const incomplete = await makeFreelancer({ hourlyRate: null });
    const complete = await makeFreelancer();

    const asClient = await authed(client).get('/api/users/me/recommended-projects?limit=0');
    const asIncomplete = await recommendedProjects(incomplete, '?limit=0');
    const invalid = await recommendedProjects(complete, '?limit=0');

    expect(asClient.status).toBe(403);
    expect(asClient.body).toEqual({ error: { code: 'FORBIDDEN_ROLE', message: 'Insufficient permissions' } });
    expect(asIncomplete.status).toBe(403);
    expect(asIncomplete.body).toEqual({ error: { code: 'PROFILE_INCOMPLETE', message: '프로필을 먼저 완성해주세요' } });
    expect(invalid.status).toBe(400);
  });
});
