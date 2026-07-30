import { describe, expect, it } from 'vitest';

import { api, authed } from './helpers/api';
import { prisma } from './helpers/db';
import { makeClient, makeProject } from './helpers/factories';

/**
 * Validates the test harness itself. If these fail, no other failure in the suite is
 * meaningful — fix these first.
 */
describe('test harness', () => {
  it('serves /health, proving the app imported without binding a port', async () => {
    const res = await api().get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('starts each test with an empty database', async () => {
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.project.count()).toBe(0);
  });

  it('is pointed at a test database, not the development one', () => {
    expect(process.env.DATABASE_URL).toMatch(/test/i);
  });

  it('builds fixtures that the API can read back', async () => {
    const client = await makeClient();
    await makeProject(client.id);

    const res = await api().get('/api/projects');

    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.meta).toMatchObject({ total: 1, page: 1 });
  });

  it('mints tokens that authenticate', async () => {
    const client = await makeClient();

    const res = await authed(client).get('/api/users/me');

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(client.email);
  });
});
