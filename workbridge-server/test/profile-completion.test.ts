import { describe, expect, it } from 'vitest';

import { api, authed, tokenFor } from './helpers/api';
import {
  makeCareer,
  makeClient,
  makeFreelancer,
  makePayoutAccount,
  makePortfolioItem,
  makeProject,
  makeUser,
} from './helpers/factories';

/** `GET /api/users/me/profile-completion` — BEHAVIOR.md PF21 (and rule 4, which it must not change). */

const get = (user: Parameters<typeof authed>[0]) => authed(user).get('/api/users/me/profile-completion');

const FREELANCER_KEYS = [
  ['skills', 15],
  ['activityCategory', 10],
  ['experienceYears', 10],
  ['hourlyRate', 10],
  ['bio', 10],
  ['profileImage', 10],
  ['portfolio', 15],
  ['portfolioThree', 5],
  ['career', 10],
  ['payoutAccount', 5],
] as const;

const CLIENT_KEYS = [
  ['companyName', 25],
  ['businessField', 25],
  ['bio', 15],
  ['profileImage', 15],
  ['website', 20],
] as const;

/** A freelancer with every PF21 item done. */
async function makeEverythingFreelancer(overrides: Parameters<typeof makeFreelancer>[0] = {}) {
  const freelancer = await makeFreelancer({ bio: '소개', profileImage: 'https://img.example.com/a.png', ...overrides });
  for (let i = 0; i < 3; i += 1) await makePortfolioItem(freelancer.id);
  await makeCareer(freelancer.id);
  await makePayoutAccount(freelancer);
  return freelancer;
}

describe('GET /api/users/me/profile-completion', () => {
  it('lists the FREELANCER checklist in order as { key, weight, done }, summing to 100 [PF21]', async () => {
    const freelancer = await makeEverythingFreelancer();

    const res = await get(freelancer);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      isComplete: true,
      percent: 100,
      items: FREELANCER_KEYS.map(([key, weight]) => ({ key, weight, done: true })),
    });
  });

  it('lists the CLIENT checklist in order [PF21]', async () => {
    const client = await makeClient({ bio: null, profileImage: null, website: 'https://codeit.kr' });

    const res = await get(client);

    expect(res.body).toEqual({
      isComplete: true,
      percent: 70,
      items: CLIENT_KEYS.map(([key, weight]) => ({ key, weight, done: !['bio', 'profileImage'].includes(key) })),
    });
  });

  it('a freelancer missing only hourlyRate is at 90% and not complete [PF21]', async () => {
    const freelancer = await makeEverythingFreelancer({ hourlyRate: null });

    const res = await get(freelancer);

    expect(res.body.isComplete).toBe(false);
    expect(res.body.percent).toBe(90);
  });

  it('a freelancer with only the four gate fields is complete at 45% — the gate is unchanged [PF21] [rule 4]', async () => {
    const freelancer = await makeFreelancer();
    const project = await makeProject((await makeClient()).id);

    const res = await get(freelancer);
    const apply = await authed(freelancer)
      .post(`/api/projects/${project.id}/applications`)
      .send({ coverLetter: 'Pick me', expectedRate: 3_000_000, expectedDuration: '3주' });

    expect(res.body).toMatchObject({ isComplete: true, percent: 45 });
    expect(apply.status).toBe(201);
  });

  it('counts portfolio at 1 and 3 items, careers at 1, and a payout account [PF21]', async () => {
    const freelancer = await makeFreelancer();
    const percent = async () => (await get(freelancer)).body.percent as number;

    expect(await percent()).toBe(45);
    await makePortfolioItem(freelancer.id);
    expect(await percent()).toBe(60);
    await makePortfolioItem(freelancer.id);
    expect(await percent()).toBe(60);
    await makePortfolioItem(freelancer.id);
    expect(await percent()).toBe(65);
    await makeCareer(freelancer.id);
    expect(await percent()).toBe(75);
    await makePayoutAccount(freelancer);
    expect(await percent()).toBe(80);
  });

  it('treats whitespace-only text as not done, and 0 years of experience as done [PF21]', async () => {
    const freelancer = await makeFreelancer({ bio: '   ', profileImage: '', experienceYears: 0, activityCategory: '  ' });

    const res = await get(freelancer);
    const done = Object.fromEntries(res.body.items.map((item: { key: string; done: boolean }) => [item.key, item.done]));

    expect(done).toMatchObject({ bio: false, profileImage: false, activityCategory: false, experienceYears: true });
    expect(res.body.isComplete).toBe(false);
  });

  it('a user with nothing filled in is at 0% [PF21]', async () => {
    const client = await makeUser({ role: 'CLIENT' });

    const res = await get(client);

    expect(res.body).toMatchObject({ isComplete: false, percent: 0 });
  });

  it('scores the stored role, not the token\'s [PF21]', async () => {
    const client = await makeClient();
    const forged = tokenFor({ id: client.id, email: client.email, role: 'FREELANCER' });

    const res = await api().get('/api/users/me/profile-completion').set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((item: { key: string }) => item.key)).toEqual(CLIENT_KEYS.map(([key]) => key));
  });
});
