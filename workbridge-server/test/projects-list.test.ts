import { beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';

import { api } from './helpers/api';
import { prisma } from './helpers/db';
import {
  daysFromNow,
  makeApplication,
  makeClient,
  makeFreelancer,
  makeProject,
} from './helpers/factories';

/**
 * `GET /api/projects` — the listing endpoint, including soft delete and the lazy lifecycle
 * sweep.
 *
 * Two things make this endpoint unusual and worth this much coverage:
 *   1. it has the widest branch surface in the codebase (7 filters × 3 sorts × pagination), and
 *   2. it is **not read-only** — it runs `closeExpiredOpenProjects()` first, so it writes rows.
 */

/** Bulk insert, for the pagination/cap tests where only the row count matters. */
async function makeManyProjects(clientId: string, count: number, prefix = 'Bulk') {
  const data: Prisma.ProjectCreateManyInput[] = Array.from({ length: count }, (_, i) => ({
    title: `${prefix} project ${i}`,
    description: `${prefix} description ${i}`,
    category: '웹 개발',
    budget: 1_000_000 + i,
    requiredSkills: ['React'],
    recruitmentStartDate: daysFromNow(-1),
    deadline: daysFromNow(30),
    status: 'OPEN' as const,
    clientId,
    // Descending createdAt, so `latest` order is deterministic: index 0 is newest.
    createdAt: new Date(Date.now() - i * 1_000),
  }));

  await prisma.project.createMany({ data });
}

const titles = (body: { projects: Array<{ title: string }> }) => body.projects.map((p) => p.title);

describe('GET /api/projects', () => {
  let clientId: string;

  beforeEach(async () => {
    clientId = (await makeClient()).id;
  });

  // ---------------------------------------------------------------- status ----

  describe('status filter', () => {
    /** One project in each of the three listable states, none of them sweep-eligible. */
    async function threeStates() {
      const open = await makeProject(clientId, { title: 'Open one', status: 'OPEN' });
      const upcoming = await makeProject(clientId, {
        title: 'Upcoming one',
        status: 'UPCOMING',
        recruitmentStartDate: daysFromNow(3),
        deadline: daysFromNow(30),
      });
      const closed = await makeProject(clientId, {
        title: 'Closed one',
        status: 'CLOSED',
        deadline: daysFromNow(30),
      });
      return { open, upcoming, closed };
    }

    it('defaults to OPEN, hiding UPCOMING and CLOSED projects', async () => {
      await threeStates();

      const res = await api().get('/api/projects');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['Open one']);
      expect(res.body.meta.total).toBe(1);
    });

    it('accepts status=OPEN explicitly, with the same result as the default', async () => {
      await threeStates();

      const res = await api().get('/api/projects?status=OPEN');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['Open one']);
    });

    it('accepts status=UPCOMING', async () => {
      await threeStates();

      const res = await api().get('/api/projects?status=UPCOMING');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['Upcoming one']);
    });

    it('accepts status=CLOSED', async () => {
      await threeStates();

      const res = await api().get('/api/projects?status=CLOSED');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['Closed one']);
    });

    it('accepts status=IN_PROGRESS, listing only projects whose contract has started', async () => {
      await threeStates();
      await makeProject(clientId, { title: 'In progress one', status: 'IN_PROGRESS' });

      const res = await api().get('/api/projects?status=IN_PROGRESS');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['In progress one']);
      expect(res.body.meta.total).toBe(1);
    });

    it('accepts status=ALL, which applies no status filter at all', async () => {
      await threeStates();

      const res = await api().get('/api/projects?status=ALL');

      expect(res.status).toBe(200);
      expect(titles(res.body).sort()).toEqual(['Closed one', 'Open one', 'Upcoming one']);
      expect(res.body.meta.total).toBe(3);
    });

    it('status=ALL also surfaces states outside the accepted filter values', async () => {
      await makeProject(clientId, { title: 'Cancelled one', status: 'CANCELLED' });
      await makeProject(clientId, { title: 'Completed one', status: 'COMPLETED' });
      await makeProject(clientId, { title: 'In progress one', status: 'IN_PROGRESS' });

      const all = await api().get('/api/projects?status=ALL');
      const dflt = await api().get('/api/projects');

      expect(all.status).toBe(200);
      expect(all.body.meta.total).toBe(3);
      // ...and none of them leak into the OPEN default.
      expect(dflt.body.projects).toEqual([]);
    });

    it('rejects an unknown status with 400 and the standard error envelope', async () => {
      const res = await api().get('/api/projects?status=BOGUS');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: { message: 'status: must be one of ALL, UPCOMING, OPEN, CLOSED, IN_PROGRESS' },
      });
    });

    it('rejects a lowercase status with 400 — matching is case-sensitive', async () => {
      const res = await api().get('/api/projects?status=open');

      expect(res.status).toBe(400);
    });

    it.each(['COMPLETED', 'CANCELLED'])(
      'rejects the real-but-unlistable enum value %s with 400',
      async (status) => {
        const res = await api().get(`/api/projects?status=${status}`);

        expect(res.status).toBe(400);
      },
    );

    // An empty query value is treated as absent.
    it('treats an empty status value as absent, defaulting to OPEN', async () => {
      await threeStates();

      const res = await api().get('/api/projects?status=');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['Open one']);
    });
  });

  // ------------------------------------------------------------------ sort ----

  describe('sort', () => {
    /** Distinct createdAt, deadline and budget so every ordering is unambiguous. */
    async function sortFixtures() {
      await makeProject(clientId, {
        title: 'A',
        createdAt: new Date(Date.now() - 3_000),
        deadline: daysFromNow(20),
        budget: 5_000_000,
      });
      await makeProject(clientId, {
        title: 'B',
        createdAt: new Date(Date.now() - 2_000),
        deadline: daysFromNow(5),
        budget: 9_000_000,
      });
      await makeProject(clientId, {
        title: 'C',
        createdAt: new Date(Date.now() - 1_000),
        deadline: daysFromNow(10),
        budget: 1_000_000,
      });
    }

    it('defaults to latest — createdAt descending', async () => {
      await sortFixtures();

      const res = await api().get('/api/projects');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['C', 'B', 'A']);
    });

    it('sort=latest orders by createdAt descending', async () => {
      await sortFixtures();

      const res = await api().get('/api/projects?sort=latest');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['C', 'B', 'A']);
    });

    it('sort=deadline orders by deadline ascending', async () => {
      await sortFixtures();

      const res = await api().get('/api/projects?sort=deadline');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['B', 'C', 'A']);
    });

    it('sort=budget orders by budget descending', async () => {
      await sortFixtures();

      const res = await api().get('/api/projects?sort=budget');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['B', 'A', 'C']);
    });

    it('rejects an unknown sort with 400', async () => {
      const res = await api().get('/api/projects?sort=cheapest');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: 'sort: must be one of latest, deadline, budget' } });
    });

    it('rejects a lowercase-only alias like createdAt with 400', async () => {
      const res = await api().get('/api/projects?sort=createdAt');

      expect(res.status).toBe(400);
    });

    // An empty query value is treated as absent.
    it('treats an empty sort value as absent, defaulting to latest', async () => {
      await sortFixtures();

      const res = await api().get('/api/projects?sort=');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['C', 'B', 'A']);
    });
  });

  // ------------------------------------------------------------ pagination ----

  describe('pagination', () => {
    it('defaults to page 1 with limit 10', async () => {
      await makeManyProjects(clientId, 12);

      const res = await api().get('/api/projects');

      expect(res.status).toBe(200);
      expect(res.body.projects).toHaveLength(10);
      expect(res.body.meta).toEqual({ total: 12, page: 1, limit: 10, totalPages: 2 });
      expect(titles(res.body)[0]).toBe('Bulk project 0');
    });

    it('returns the remainder on page 2 with no overlap', async () => {
      await makeManyProjects(clientId, 12);

      const first = await api().get('/api/projects?page=1');
      const second = await api().get('/api/projects?page=2');

      expect(second.status).toBe(200);
      expect(second.body.projects).toHaveLength(2);
      expect(second.body.meta).toEqual({ total: 12, page: 2, limit: 10, totalPages: 2 });

      const overlap = titles(first.body).filter((t) => titles(second.body).includes(t));
      expect(overlap).toEqual([]);
      expect(titles(second.body)).toEqual(['Bulk project 10', 'Bulk project 11']);
    });

    it('computes meta arithmetic correctly across more than one page', async () => {
      await makeManyProjects(clientId, 12);

      const res = await api().get('/api/projects?page=2&limit=5');

      expect(res.status).toBe(200);
      expect(res.body.projects).toHaveLength(5);
      expect(res.body.meta).toEqual({ total: 12, page: 2, limit: 5, totalPages: 3 });

      const last = await api().get('/api/projects?page=3&limit=5');
      expect(last.body.projects).toHaveLength(2);
      expect(last.body.meta).toEqual({ total: 12, page: 3, limit: 5, totalPages: 3 });
    });

    it('returns an empty page past the end while keeping meta consistent', async () => {
      await makeManyProjects(clientId, 3);

      const res = await api().get('/api/projects?page=9&limit=2');

      expect(res.status).toBe(200);
      expect(res.body.projects).toEqual([]);
      expect(res.body.meta).toEqual({ total: 3, page: 9, limit: 2, totalPages: 2 });
    });

    it('caps limit at 50 when a larger one is requested', async () => {
      await makeManyProjects(clientId, 51);

      const res = await api().get('/api/projects?limit=100');

      expect(res.status).toBe(200);
      expect(res.body.meta.limit).toBe(50);
      expect(res.body.projects.length).toBeLessThanOrEqual(50);
      expect(res.body.projects).toHaveLength(50);
      expect(res.body.meta).toEqual({ total: 51, page: 1, limit: 50, totalPages: 2 });
    });

    it('applies the capped limit to the offset as well as the page size', async () => {
      await makeManyProjects(clientId, 51);

      const res = await api().get('/api/projects?limit=100&page=2');

      expect(res.status).toBe(200);
      // skip = (2 - 1) × 50, so exactly the 51st row comes back.
      expect(res.body.projects).toHaveLength(1);
      expect(titles(res.body)).toEqual(['Bulk project 50']);
      expect(res.body.meta).toEqual({ total: 51, page: 2, limit: 50, totalPages: 2 });
    });

    it('honours limit=50 exactly at the boundary', async () => {
      await makeManyProjects(clientId, 51);

      const res = await api().get('/api/projects?limit=50');

      expect(res.status).toBe(200);
      expect(res.body.meta.limit).toBe(50);
      expect(res.body.projects).toHaveLength(50);
    });

    it('meta contains exactly total, page, limit and totalPages', async () => {
      await makeManyProjects(clientId, 1);

      const res = await api().get('/api/projects');

      expect(Object.keys(res.body.meta).sort()).toEqual(['limit', 'page', 'total', 'totalPages']);
      expect(Object.keys(res.body).sort()).toEqual(['meta', 'projects']);
    });

    it('reports total 0 and totalPages 0 for an empty result set', async () => {
      const res = await api().get('/api/projects');

      expect(res.status).toBe(200);
      expect(res.body.projects).toEqual([]);
      expect(res.body.meta).toEqual({ total: 0, page: 1, limit: 10, totalPages: 0 });
    });

    it.each([
      ['page=0', '?page=0', 'page: must be at least 1'],
      ['page=-1', '?page=-1', 'page: must be at least 1'],
      ['page=abc', '?page=abc', 'page: must be an integer'],
      ['limit=0', '?limit=0', 'limit: must be at least 1'],
      ['limit=-5', '?limit=-5', 'limit: must be at least 1'],
      ['limit=abc', '?limit=abc', 'limit: must be an integer'],
      // A fractional value or trailing garbage is not an integer (`parseInt` used to
      // truncate them, #37).
      ['a fractional page', '?page=1.5', 'page: must be an integer'],
      ['a fractional limit', '?limit=2.7', 'limit: must be an integer'],
      ['a trailing-garbage page like 3abc', '?page=3abc', 'page: must be an integer'],
      // Bounded like the contract list, so `skip` cannot overflow into a Prisma 500.
      ['a page above 1,000,000', '?page=1000001', 'page: must be at most 1000000'],
    ])('rejects %s with 400', async (_label, query, message) => {
      const res = await api().get(`/api/projects${query}`);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message } });
    });

    // An empty query value is treated as absent.
    it('treats empty page and limit values as absent, using the defaults', async () => {
      await makeManyProjects(clientId, 12);

      const res = await api().get('/api/projects?page=&limit=');

      expect(res.status).toBe(200);
      expect(res.body.meta).toMatchObject({ page: 1, limit: 10 });
      expect(res.body.projects).toHaveLength(10);
    });

    it('accepts the largest allowed page, returning an empty page', async () => {
      const res = await api().get('/api/projects?page=1000000&limit=50');

      expect(res.status).toBe(200);
      expect(res.body.projects).toEqual([]);
      expect(res.body.meta.page).toBe(1_000_000);
    });
  });

  // ---------------------------------------------------------------- search ----

  describe('search filter', () => {
    beforeEach(async () => {
      await makeProject(clientId, {
        title: 'Payment Gateway Integration',
        description: 'Wire up a card processor',
      });
      await makeProject(clientId, {
        title: 'Internal admin tool',
        description: 'A dashboard running on Kubernetes',
      });
      await makeProject(clientId, {
        title: 'Landing page',
        description: 'Marketing site',
      });
    });

    it('matches the title case-insensitively', async () => {
      const res = await api().get('/api/projects?search=payment gateway');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['Payment Gateway Integration']);
    });

    it('matches the description case-insensitively', async () => {
      const res = await api().get('/api/projects?search=KUBERNETES');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['Internal admin tool']);
    });

    it('matches a substring anywhere in the field', async () => {
      const res = await api().get('/api/projects?search=ateway');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['Payment Gateway Integration']);
    });

    it('returns an empty list when nothing matches', async () => {
      const res = await api().get('/api/projects?search=blockchain');

      expect(res.status).toBe(200);
      expect(res.body.projects).toEqual([]);
      expect(res.body.meta.total).toBe(0);
    });

    it('ignores an empty search value', async () => {
      const res = await api().get('/api/projects?search=');

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(3);
    });

    it('combines search with the status filter', async () => {
      await makeProject(clientId, {
        title: 'Payment Gateway v2',
        status: 'CLOSED',
        deadline: daysFromNow(30),
      });

      const open = await api().get('/api/projects?search=payment');
      const all = await api().get('/api/projects?search=payment&status=ALL');

      expect(titles(open.body)).toEqual(['Payment Gateway Integration']);
      expect(all.body.meta.total).toBe(2);
    });
  });

  // -------------------------------------------------------------- category ----

  describe('category filter', () => {
    beforeEach(async () => {
      await makeProject(clientId, { title: 'Web one', category: '웹 개발' });
      await makeProject(clientId, { title: 'App one', category: '앱 개발' });
      await makeProject(clientId, { title: 'Design one', category: '디자인' });
    });

    it('matches the category exactly', async () => {
      const res = await api().get(`/api/projects?category=${encodeURIComponent('앱 개발')}`);

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['App one']);
    });

    it('does not match a category prefix', async () => {
      const res = await api().get(`/api/projects?category=${encodeURIComponent('웹')}`);

      expect(res.status).toBe(200);
      expect(res.body.projects).toEqual([]);
    });

    it('is case-sensitive, unlike search', async () => {
      await makeProject(clientId, { title: 'Devops one', category: 'DevOps' });

      const res = await api().get('/api/projects?category=devops');

      expect(res.status).toBe(200);
      expect(res.body.projects).toEqual([]);
    });

    it('ignores an empty category value', async () => {
      const res = await api().get('/api/projects?category=');

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(3);
    });
  });

  // ---------------------------------------------------------------- budget ----

  describe('budget bounds', () => {
    beforeEach(async () => {
      await makeProject(clientId, { title: 'Cheap', budget: 1_000_000 });
      await makeProject(clientId, { title: 'Mid', budget: 5_000_000 });
      await makeProject(clientId, { title: 'Rich', budget: 9_000_000 });
    });

    it('applies minBudget inclusively', async () => {
      const res = await api().get('/api/projects?minBudget=5000000&sort=budget');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['Rich', 'Mid']);
    });

    it('applies maxBudget inclusively', async () => {
      const res = await api().get('/api/projects?maxBudget=5000000&sort=budget');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['Mid', 'Cheap']);
    });

    it('applies both bounds together', async () => {
      const res = await api().get('/api/projects?minBudget=5000000&maxBudget=5000000');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['Mid']);
    });

    it('returns an empty list when the window excludes everything', async () => {
      const res = await api().get('/api/projects?minBudget=10000000');

      expect(res.status).toBe(200);
      expect(res.body.projects).toEqual([]);
      expect(res.body.meta.total).toBe(0);
    });

    it('accepts minBudget=0 as a real (not ignored) lower bound', async () => {
      const res = await api().get('/api/projects?minBudget=0');

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(3);
    });

    it('accepts a fractional bound', async () => {
      const res = await api().get('/api/projects?minBudget=4999999.5&maxBudget=5000000.5');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['Mid']);
    });

    it('rejects minBudget greater than maxBudget with 400', async () => {
      const res = await api().get('/api/projects?minBudget=9000000&maxBudget=1000000');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: 'minBudget: must not be greater than maxBudget' } });
    });

    it('allows minBudget equal to maxBudget', async () => {
      const res = await api().get('/api/projects?minBudget=1000000&maxBudget=1000000');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['Cheap']);
    });

    it.each([
      ['non-numeric minBudget', '?minBudget=abc', 'minBudget: must be a number'],
      ['non-numeric maxBudget', '?maxBudget=abc', 'maxBudget: must be a number'],
      ['negative minBudget', '?minBudget=-1', 'minBudget: must be at least 0'],
      ['negative maxBudget', '?maxBudget=-1', 'maxBudget: must be at least 0'],
      // Trailing garbage is not a number (`parseFloat` used to truncate it).
      ['trailing-garbage minBudget', '?minBudget=3abc', 'minBudget: must be a number'],
      ['an exponent maxBudget', '?maxBudget=1e6', 'maxBudget: must be a number'],
    ])('rejects %s with 400', async (_label, query, message) => {
      const res = await api().get(`/api/projects${query}`);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message } });
    });

    it('ignores empty budget values instead of rejecting them', async () => {
      const res = await api().get('/api/projects?minBudget=&maxBudget=');

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(3);
    });
  });

  // ---------------------------------------------------------------- skills ----

  describe('skills filter', () => {
    beforeEach(async () => {
      await makeProject(clientId, { title: 'SQL heavy', requiredSkills: ['SQL', 'Node.js'] });
      await makeProject(clientId, { title: 'Postgres raw', requiredSkills: ['PostgreSQL'] });
      await makeProject(clientId, { title: 'Front end', requiredSkills: ['React', 'CSS'] });
    });

    // lib.test.ts owns normalization/alias/trim/case coverage; these prove the endpoint wiring.

    it('finds a project requiring SQL when searching for the alias PostgreSQL', async () => {
      const res = await api().get('/api/projects?skills=PostgreSQL');

      expect(res.status).toBe(200);
      // PostgreSQL normalizes to SQL, and SQL expands back to its aliases, so both match.
      expect(titles(res.body).sort()).toEqual(['Postgres raw', 'SQL heavy']);
    });

    it('matches when any one of several requested skills overlaps', async () => {
      const res = await api().get('/api/projects?skills=React,Vue');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['Front end']);
    });

    it('ignores an empty skills value rather than matching nothing', async () => {
      const res = await api().get('/api/projects?skills=');

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(3);
    });
  });

  // -------------------------------------------------------- malformed skills ----

  /**
   * `normalizeSkillList` calls `.trim()` on every element of an array, so a non-string
   * element used to throw `TypeError: skill.trim is not a function` → 500. Express's default `qs`
   * parser can produce a nested array or an object from a query string, so this endpoint was
   * affected too. `projectListQuery` now admits only a string or a list of strings → 400.
   */
  describe('malformed skills input', () => {
    // Reading is unaffected: `requiredSkills` comes back from Postgres as-is and is never
    // normalized on this path, so odd-but-storable values list and filter normally. (The column
    // is `String[]`, so Prisma will not store a number or a null through the API at all.)
    it('lists a project whose stored requiredSkills hold odd values', async () => {
      await makeProject(clientId, {
        title: 'Odd skills',
        requiredSkills: ['', '   ', '1', 'react', 'React Native'],
      });

      const res = await api().get('/api/projects');

      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['Odd skills']);
      expect(res.body.projects[0].requiredSkills).toEqual(['', '   ', '1', 'react', 'React Native']);
    });

    it('still filters on an odd stored skill value', async () => {
      await makeProject(clientId, { title: 'Odd skills', requiredSkills: ['1', 'react'] });
      await makeProject(clientId, { title: 'Normal', requiredSkills: ['React'] });

      const byNumericString = await api().get('/api/projects?skills=1');
      const byLowercase = await api().get('/api/projects?skills=react');

      expect(titles(byNumericString.body)).toEqual(['Odd skills']);
      expect(titles(byLowercase.body)).toEqual(['Odd skills']);
    });

    // qs turns `skills[a]=React` into `{ a: 'React' }`. It used to be stringified to
    // '[object Object]' and match nothing; a malformed value is a 400.
    it('rejects a skills parameter that parses as an object rather than a list with 400', async () => {
      await makeProject(clientId, { title: 'Normal', requiredSkills: ['React'] });

      const res = await api().get('/api/projects?skills[a]=React');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: 'skills: must be a string or a list of strings' } });
    });

    // `skills[0][0]=React` parses to `[['React']]`. It used to reach `.trim()` in
    // `normalizeSkillList` → `TypeError` → 500.
    it('rejects a nested skills array parameter with 400 rather than 500', async () => {
      await makeProject(clientId, { title: 'Normal', requiredSkills: ['React'] });

      const res = await api().get('/api/projects?skills[0][0]=React');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: 'skills: must be a string or a list of strings' } });
    });

    it('reads a repeated skills parameter as a list, like a comma-separated one', async () => {
      await makeProject(clientId, { title: 'Front', requiredSkills: ['React'] });
      await makeProject(clientId, { title: 'Back', requiredSkills: ['SQL'] });
      await makeProject(clientId, { title: 'Other', requiredSkills: ['Go'] });

      const res = await api().get('/api/projects?skills=React&skills=PostgreSQL');

      expect(res.status).toBe(200);
      expect(titles(res.body).sort()).toEqual(['Back', 'Front']);
    });
  });

  // ----------------------------------------------------------- soft delete ----

  describe('soft delete', () => {
    // soft-delete.test.ts owns listing absence; only filtered searches and joined owners live here.

    it('excludes soft-deleted projects from filtered searches too', async () => {
      await makeProject(clientId, {
        title: 'Deleted payment work',
        deletedAt: new Date(),
        requiredSkills: ['SQL'],
        budget: 1_000_000,
        category: 'Ops',
      });

      // Positive control: the row really is there, so an empty result is the filter working.
      expect(await prisma.project.count()).toBe(1);

      const bySearch = await api().get('/api/projects?search=payment');
      const bySkill = await api().get('/api/projects?skills=SQL');
      const byCategory = await api().get('/api/projects?category=Ops');
      const byBudget = await api().get('/api/projects?minBudget=0');

      for (const res of [bySearch, bySkill, byCategory, byBudget]) {
        expect(res.status).toBe(200);
        expect(res.body.projects).toEqual([]);
        expect(res.body.meta.total).toBe(0);
      }
    });

    // Open product question: does the soft-delete rule reach *joined* owners? The rule is written
    // about the record being read, and neither this listing nor `GET /:id` filters the joined
    // client, so a project whose client is gone stays public — name, company and avatar included.
    // Pinning today's behavior; if the question is decided the other way this test flips to
    // expecting the project (or at least the client snippet) to disappear.
    it('still lists a project whose client has been soft-deleted, client snippet included', async () => {
      const client = await prisma.user.findUniqueOrThrow({ where: { id: clientId } });
      const project = await makeProject(clientId, { title: 'Orphaned' });
      await prisma.user.update({ where: { id: clientId }, data: { deletedAt: new Date() } });

      const list = await api().get('/api/projects');

      expect(list.status).toBe(200);
      expect(titles(list.body)).toEqual(['Orphaned']);
      expect(list.body.meta.total).toBe(1);
      expect(list.body.projects[0].client).toEqual({
        id: clientId,
        name: client.name,
        companyName: client.companyName,
        profileImage: client.profileImage,
      });
    });

    it('still serves GET /:id for a project whose client has been soft-deleted', async () => {
      const client = await prisma.user.findUniqueOrThrow({ where: { id: clientId } });
      const project = await makeProject(clientId, { title: 'Orphaned' });
      await prisma.user.update({ where: { id: clientId }, data: { deletedAt: new Date() } });

      const res = await api().get(`/api/projects/${project.id}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(project.id);
      // `getProjectById` selects one more field than the listing does.
      expect(res.body.client).toEqual({
        id: clientId,
        name: client.name,
        companyName: client.companyName,
        profileImage: client.profileImage,
        businessField: client.businessField,
      });
      // Cross-check that the owner really is deleted, so this is not a vacuous pass.
      expect((await prisma.user.findUniqueOrThrow({ where: { id: clientId } })).deletedAt)
        .not.toBeNull();
    });
  });

  // --------------------------------------------------------- response shape ----

  describe('response shape', () => {
    it('includes the client snippet and an application count on each project', async () => {
      const client = await prisma.user.findUniqueOrThrow({ where: { id: clientId } });
      const project = await makeProject(clientId, { title: 'Shaped' });
      const f1 = await makeFreelancer();
      const f2 = await makeFreelancer();
      await makeApplication(project.id, f1.id);
      await makeApplication(project.id, f2.id);

      const res = await api().get('/api/projects');

      expect(res.status).toBe(200);
      const [row] = res.body.projects;

      expect(row).toMatchObject({
        id: project.id,
        title: 'Shaped',
        description: project.description,
        category: project.category,
        budget: project.budget,
        requiredSkills: project.requiredSkills,
        status: 'OPEN',
        clientId,
        deletedAt: null,
      });
      expect(row.deadline).toBe(project.deadline.toISOString());
      expect(row.recruitmentStartDate).toBe(project.recruitmentStartDate?.toISOString());
      expect(row.createdAt).toBe(project.createdAt.toISOString());

      expect(row._count).toEqual({ applications: 2 });
      expect(row.client).toEqual({
        id: clientId,
        name: client.name,
        companyName: client.companyName,
        profileImage: client.profileImage,
      });
      // The snippet is a whitelist, so private fields such as email cannot leak.
      expect(Object.keys(row.client).sort()).toEqual([
        'companyName',
        'id',
        'name',
        'profileImage',
      ]);
    });

    it('reports a zero application count for a project nobody applied to', async () => {
      await makeProject(clientId, { title: 'Lonely' });

      const res = await api().get('/api/projects');

      expect(res.body.projects[0]._count).toEqual({ applications: 0 });
    });

    it('counts applications of every status, not just pending ones', async () => {
      const project = await makeProject(clientId, { title: 'Counted' });
      const f1 = await makeFreelancer();
      const f2 = await makeFreelancer();
      const f3 = await makeFreelancer();
      await makeApplication(project.id, f1.id, { status: 'PENDING' });
      await makeApplication(project.id, f2.id, { status: 'REJECTED' });
      await makeApplication(project.id, f3.id, { status: 'ACCEPTED' });

      const res = await api().get('/api/projects');

      expect(res.body.projects[0]._count).toEqual({ applications: 3 });
    });

    it('is public — no authentication required', async () => {
      await makeProject(clientId);

      const res = await api().get('/api/projects');

      expect(res.status).toBe(200);
    });
  });

  // ------------------------------------------------- repeated query params ----

  /**
   * A repeated parameter is a 400, even when one of the values is valid (the listing used to
   * fall back to the default). `skills` is the exception: it is a list.
   */
  describe('repeated query parameters', () => {
    it.each([
      ['page', '?page=1&page=2'],
      ['limit', '?limit=1&limit=2'],
      ['sort', '?sort=latest&sort=budget'],
      ['status', '?status=CLOSED&status=ALL'],
      ['search', '?search=nomatch&search=other'],
      ['category', '?category=None&category=Ops'],
      ['minBudget', '?minBudget=99999999&minBudget=1'],
      ['maxBudget', '?maxBudget=1&maxBudget=2'],
    ])('rejects a repeated %s with 400', async (field, query) => {
      const res = await api().get(`/api/projects${query}`);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: `${field}: must be a single value` } });
    });
  });

  // ------------------------------------------------- lifecycle side effect ----

  /**
   * The lazy lifecycle sweep runs on this read path, so `GET /api/projects` **writes rows**.
   * Nothing else in the codebase documents this, which makes these the highest-value tests here.
   */
  describe('lazy lifecycle sweep (this endpoint writes rows)', () => {
    it('closes an OPEN project whose deadline has passed and rejects its pending applications', async () => {
      const expired = await makeProject(clientId, {
        title: 'Expired',
        recruitmentStartDate: daysFromNow(-10),
        deadline: daysFromNow(-1),
        status: 'OPEN',
      });
      const pendingFreelancer = await makeFreelancer();
      const acceptedFreelancer = await makeFreelancer();
      const pending = await makeApplication(expired.id, pendingFreelancer.id, {
        status: 'PENDING',
      });
      const accepted = await makeApplication(expired.id, acceptedFreelancer.id, {
        status: 'ACCEPTED',
      });

      const res = await api().get('/api/projects');

      expect(res.status).toBe(200);
      // Now CLOSED, so it is hidden from the OPEN default.
      expect(res.body.projects).toEqual([]);

      const after = await prisma.project.findUniqueOrThrow({ where: { id: expired.id } });
      expect(after.status).toBe('CLOSED');

      expect((await prisma.application.findUniqueOrThrow({ where: { id: pending.id } })).status)
        .toBe('REJECTED');
      // An already-decided application must not be rewritten.
      expect((await prisma.application.findUniqueOrThrow({ where: { id: accepted.id } })).status)
        .toBe('ACCEPTED');
    });

    it('promotes an UPCOMING project whose recruitment has started to OPEN, and lists it', async () => {
      const upcoming = await makeProject(clientId, {
        title: 'Now recruiting',
        status: 'UPCOMING',
        recruitmentStartDate: daysFromNow(-1),
        deadline: daysFromNow(30),
      });

      const res = await api().get('/api/projects');

      expect(res.status).toBe(200);
      // The sweep runs before the query, so the promotion is visible in the same response.
      expect(titles(res.body)).toEqual(['Now recruiting']);

      const after = await prisma.project.findUniqueOrThrow({ where: { id: upcoming.id } });
      expect(after.status).toBe('OPEN');
    });

    it('leaves an UPCOMING project alone while recruitment is still in the future', async () => {
      const upcoming = await makeProject(clientId, {
        title: 'Later',
        status: 'UPCOMING',
        recruitmentStartDate: daysFromNow(3),
        deadline: daysFromNow(30),
      });

      const res = await api().get('/api/projects');

      expect(res.body.projects).toEqual([]);
      const after = await prisma.project.findUniqueOrThrow({ where: { id: upcoming.id } });
      expect(after.status).toBe('UPCOMING');
    });

    it('closes an UPCOMING project whose deadline has already passed', async () => {
      const stale = await makeProject(clientId, {
        title: 'Never opened',
        status: 'UPCOMING',
        recruitmentStartDate: daysFromNow(-5),
        deadline: daysFromNow(-2),
      });

      await api().get('/api/projects');

      const after = await prisma.project.findUniqueOrThrow({ where: { id: stale.id } });
      expect(after.status).toBe('CLOSED');
    });

    it('does not touch a project whose deadline is still in the future', async () => {
      const live = await makeProject(clientId, { title: 'Live', deadline: daysFromNow(1) });
      const freelancer = await makeFreelancer();
      const application = await makeApplication(live.id, freelancer.id, { status: 'PENDING' });

      await api().get('/api/projects');

      expect((await prisma.project.findUniqueOrThrow({ where: { id: live.id } })).status)
        .toBe('OPEN');
      expect((await prisma.application.findUniqueOrThrow({ where: { id: application.id } })).status)
        .toBe('PENDING');
    });

    it('does not sweep a soft-deleted project', async () => {
      const deleted = await makeProject(clientId, {
        title: 'Deleted and expired',
        status: 'OPEN',
        recruitmentStartDate: daysFromNow(-10),
        deadline: daysFromNow(-1),
        deletedAt: new Date(),
      });
      const freelancer = await makeFreelancer();
      const application = await makeApplication(deleted.id, freelancer.id, { status: 'PENDING' });

      await api().get('/api/projects');

      const after = await prisma.project.findUniqueOrThrow({ where: { id: deleted.id } });
      expect(after.status).toBe('OPEN');
      expect((await prisma.application.findUniqueOrThrow({ where: { id: application.id } })).status)
        .toBe('PENDING');
    });

    it('LIMITATION: the sweep only rejects applications on projects it closes in that pass, so one already CLOSED keeps its PENDING applications', async () => {
      // The sweep's rule "reject still-PENDING applications on projects that are now CLOSED"
      // reads as if it covered every CLOSED project, but `closeExpiredOpenProjects`
      // scopes `rejectPendingApplicationsForClosedProjects` to the ids it just closed, so a
      // project closed in an earlier pass keeps whatever applications it had.
      //
      // Documented as a limitation rather than asserted as a requirement: nothing in the system
      // actually leaves a stale PENDING application behind, because every other path that closes a
      // project rejects its pending applications in the same transaction (accepting an
      // application, `PATCH /:id/status` → CLOSED, and this sweep for the projects it closes).
      // Reaching this state at all takes a direct database write, as below.
      const closed = await makeProject(clientId, {
        title: 'Closed earlier',
        status: 'CLOSED',
        deadline: daysFromNow(30),
      });
      const freelancer = await makeFreelancer();
      const application = await makeApplication(closed.id, freelancer.id, { status: 'PENDING' });

      await api().get('/api/projects');

      expect((await prisma.application.findUniqueOrThrow({ where: { id: application.id } })).status)
        .toBe('PENDING');
    });

    it('validates the query before sweeping, so a rejected request writes nothing', async () => {
      // `validate()` runs before the controller, and the sweep is the controller's first step.
      const expired = await makeProject(clientId, {
        title: 'Expired',
        recruitmentStartDate: daysFromNow(-10),
        deadline: daysFromNow(-1),
        status: 'OPEN',
      });

      const res = await api().get('/api/projects?status=BOGUS');

      expect(res.status).toBe(400);
      const after = await prisma.project.findUniqueOrThrow({ where: { id: expired.id } });
      expect(after.status).toBe('OPEN');
    });

    it('is idempotent across repeated calls', async () => {
      const expired = await makeProject(clientId, {
        title: 'Expired',
        recruitmentStartDate: daysFromNow(-10),
        deadline: daysFromNow(-1),
        status: 'OPEN',
      });

      await api().get('/api/projects');
      await api().get('/api/projects');
      await api().get('/api/projects?status=ALL');

      const after = await prisma.project.findUniqueOrThrow({ where: { id: expired.id } });
      expect(after.status).toBe('CLOSED');
      expect(await prisma.project.count({ where: { id: expired.id } })).toBe(1);
    });
  });

  // ----------------------------------------------------- combined filters ----

  describe('combined filters', () => {
    it('applies every filter together with pagination and sorting', async () => {
      for (let i = 0; i < 6; i += 1) {
        await makeProject(clientId, {
          title: `React build ${i}`,
          description: 'Needs a React specialist',
          category: '웹 개발',
          budget: 2_000_000 + i * 1_000_000,
          requiredSkills: ['React', 'SQL'],
          deadline: daysFromNow(10 + i),
        });
      }
      // Noise that must be filtered out by one criterion each.
      await makeProject(clientId, { title: 'Wrong category', category: '디자인' });
      await makeProject(clientId, { title: 'Wrong skill', requiredSkills: ['COBOL'] });
      await makeProject(clientId, { title: 'Too cheap', budget: 1 });
      await makeProject(clientId, {
        title: 'Wrong status',
        status: 'CLOSED',
        deadline: daysFromNow(30),
      });
      await makeProject(clientId, { title: 'Soft deleted', deletedAt: new Date() });

      const res = await api().get(
        `/api/projects?search=react&category=${encodeURIComponent('웹 개발')}`
        + '&skills=PostgreSQL&minBudget=3000000&maxBudget=6000000&sort=budget&limit=2&page=1',
      );

      expect(res.status).toBe(200);
      // Budgets 3M, 4M, 5M, 6M survive; budget desc, first page of two.
      expect(titles(res.body)).toEqual(['React build 4', 'React build 3']);
      expect(res.body.meta).toEqual({ total: 4, page: 1, limit: 2, totalPages: 2 });

      const second = await api().get(
        `/api/projects?search=react&category=${encodeURIComponent('웹 개발')}`
        + '&skills=PostgreSQL&minBudget=3000000&maxBudget=6000000&sort=budget&limit=2&page=2',
      );
      expect(titles(second.body)).toEqual(['React build 2', 'React build 1']);
    });

    it('validates sort before status', async () => {
      const res = await api().get('/api/projects?sort=bogus&status=bogus');

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/sort/);
    });
  });
});
