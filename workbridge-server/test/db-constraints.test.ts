import { describe, expect, it } from 'vitest';

import { prisma } from './helpers/db';
import {
  makeClient,
  makeContractScenario,
  makeFreelancer,
  makePortfolioItem,
  makeProject,
  makeSubmission,
} from './helpers/factories';

/**
 * Database-level guards that hold whatever writes the row — an operator's SQL, a backfill, the
 * seed — not just the API (docs/DATABASE.md "관계와 불변식").
 *
 * Prisma's `String[]` assumes every element is a string; a single `NULL` element makes every
 * query that reads the row throw (P2032), so one bad project takes the whole public list down.
 */
describe('string array columns reject NULL elements', () => {
  type Target = {
    table: string;
    column: string;
    constraint: string;
    /** Creates a row and returns its id. */
    make: () => Promise<string>;
  };

  const targets: Target[] = [
    {
      table: 'User',
      column: 'skills',
      constraint: 'User_skills_no_null',
      make: async () => (await makeFreelancer()).id,
    },
    {
      table: 'Project',
      column: 'requiredSkills',
      constraint: 'Project_requiredSkills_no_null',
      make: async () => {
        const client = await makeClient();
        return (await makeProject(client.id)).id;
      },
    },
    {
      table: 'MilestoneSubmission',
      column: 'links',
      constraint: 'MilestoneSubmission_links_no_null',
      make: async () => {
        const { milestone } = await makeContractScenario();
        return (await makeSubmission(milestone.id, { links: ['https://example.com'] })).id;
      },
    },
    {
      table: 'PortfolioItem',
      column: 'skills',
      constraint: 'PortfolioItem_skills_no_null',
      make: async () => {
        const freelancer = await makeFreelancer();
        return (await makePortfolioItem(freelancer.id)).id;
      },
    },
    {
      table: 'Review',
      column: 'tags',
      constraint: 'Review_tags_no_null',
      make: async () => {
        const { contract, client, freelancer } = await makeContractScenario({
          contract: { status: 'COMPLETED' },
        });
        const review = await prisma.review.create({
          data: {
            contractId: contract.id,
            reviewerId: client.id,
            revieweeId: freelancer.id,
            rating: 5,
            content: 'Great work',
            tags: ['소통이 빨라요'],
          },
        });
        return review.id;
      },
    },
  ];

  describe.each(targets)('$table.$column', ({ table, column, constraint, make }) => {
    it('rejects an UPDATE that puts a NULL element into the array', async () => {
      const id = await make();

      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "${table}" SET "${column}" = ARRAY['React', NULL]::text[] WHERE id = $1`,
          id,
        ),
      ).rejects.toThrow(constraint);

      const [row] = await prisma.$queryRawUnsafe<Array<{ value: Array<string | null> }>>(
        `SELECT "${column}" AS value FROM "${table}" WHERE id = $1`,
        id,
      );
      expect(row.value).not.toContain(null);
    });

    it('rejects an array made only of NULL', async () => {
      const id = await make();

      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "${table}" SET "${column}" = ARRAY[NULL]::text[] WHERE id = $1`,
          id,
        ),
      ).rejects.toThrow(constraint);
    });

    it('still accepts empty arrays and arrays of strings', async () => {
      const id = await make();

      await expect(
        prisma.$executeRawUnsafe(`UPDATE "${table}" SET "${column}" = ARRAY[]::text[] WHERE id = $1`, id),
      ).resolves.toBe(1);
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "${table}" SET "${column}" = ARRAY['React', 'Node.js']::text[] WHERE id = $1`,
          id,
        ),
      ).resolves.toBe(1);
    });
  });
});

/**
 * Supabase serves the schema through its Data API (PostgREST); a table without RLS is readable
 * and writable by anyone holding the project URL and the anon key. The app connects as the table
 * owner, which bypasses RLS, so RLS with no policies closes that door without changing behavior
 * (docs/DATABASE.md "행 단위 보안"). A new table must enable it in the migration that creates it.
 */
describe('row level security', () => {
  it('is enabled on every table in the schema', async () => {
    const tables = await prisma.$queryRaw<Array<{ name: string; rls: boolean }>>`
      SELECT c.relname AS name, c.relrowsecurity AS rls
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`;

    expect(tables.length).toBeGreaterThan(0);
    expect(tables.filter((t) => !t.rls).map((t) => t.name)).toEqual([]);
  });

  it('leaves the app, which connects as the table owner, able to read and write', async () => {
    const client = await makeClient();

    await expect(prisma.user.findFirst({ where: { id: client.id, deletedAt: null } })).resolves.toMatchObject({
      id: client.id,
    });
  });
});
