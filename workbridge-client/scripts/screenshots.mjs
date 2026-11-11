// Usage: node scripts/screenshots.mjs <outDir> [--base http://localhost:3001] [--roles guest,client,freelancer] [--viewports desktop,mobile] [--only name1,name2]
// Logs in through the UI with the seed accounts (kim@example.com = client, park@example.com = freelancer, password123),
// discovers seed ids (contracts, milestones, conversations, settlements, users) through the API, then captures every
// page under src/app/ (+ 404 and the opened header menu) as PNGs named <role>-<viewport>-<route>.png (route "/" → "_", "/" alone → "index").
// Needs both dev servers running and a seeded DB (see .claude/skills/run-workbridge); @playwright/test provides Chromium.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const outDir = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) || 'screenshots';
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const BASE = opt('base', process.env.BASE_URL || 'http://localhost:3001');
const ROLES = opt('roles', 'guest,client,freelancer').split(',');
const VIEWPORTS = opt('viewports', 'desktop,mobile').split(',');
const ONLY = opt('only', '') ? opt('only', '').split(',') : null;

const ACCOUNTS = {
  client: 'kim@example.com',
  freelancer: 'park@example.com',
};
const SIZES = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

fs.mkdirSync(outDir, { recursive: true });

async function apiGet(page, url) {
  return page.evaluate(async (u) => {
    const token = localStorage.getItem('accessToken');
    const res = await fetch(u, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return res.ok ? res.json() : null;
  }, url);
}

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill('password123');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
}

// Picks seed ids the logged-in role can actually see. Falls back to a public project for everything else.
async function discoverIds(page, role) {
  const ids = {};
  const pub = await apiGet(page, '/api/projects?status=OPEN&limit=50');
  const open = pub?.projects || [];
  ids.project = open[0]?.id;
  ids.user = open[0]?.client?.id;

  if (role === 'client') {
    const mine = (await apiGet(page, '/api/users/me/projects')) || [];
    const owned = mine.find((p) => p.status === 'OPEN' && p._count?.applications) || mine[0];
    if (owned) ids.project = owned.id;
  }

  const contracts = (await apiGet(page, '/api/contracts'))?.contracts || [];
  const contract = contracts.find((c) => c.status === 'ACTIVE') || contracts[0];
  if (contract) {
    ids.contract = contract.id;
    ids.user = contract.counterpart?.id || ids.user;
    const detail = await apiGet(page, `/api/contracts/${contract.id}/milestones`);
    const ms = detail?.milestones || [];
    const pick = ms.find((m) => ['SUBMITTED', 'FUNDED', 'REVISION_REQUESTED'].includes(m.status)) || ms[0];
    ids.milestone = pick?.id;
    ids.payMilestone = (ms.find((m) => m.status === 'PENDING') || pick)?.id;
  }
  const convs = (await apiGet(page, '/api/conversations'))?.conversations || [];
  ids.conversation = (convs.find((c) => c.unreadCount > 0) || convs[0])?.id;
  if (role === 'freelancer') {
    const s = (await apiGet(page, '/api/settlements'))?.settlements || [];
    ids.settlement = s[0]?.id;
  }
  return ids;
}

function routes(ids) {
  const x = (v) => v || 'unknown';
  return [
    ['/', 'index'],
    ['/login'],
    ['/signup'],
    ['/auth/callback'],
    ['/auth/select-role'],
    ['/projects'],
    ['/projects/new'],
    [`/projects/${x(ids.project)}`, 'projects_[id]'],
    [`/projects/${x(ids.project)}/edit`, 'projects_[id]_edit'],
    [`/projects/${x(ids.project)}/applications`, 'projects_[id]_applications'],
    [`/contracts/${x(ids.contract)}`, 'contracts_[id]'],
    [`/contracts/${x(ids.contract)}/milestones/${x(ids.milestone)}`, 'contracts_[id]_milestones_[milestoneId]'],
    ['/messages'],
    [`/messages/${x(ids.conversation)}`, 'messages_[conversationId]'],
    ['/my/applications'],
    ['/my/bookmarks'],
    ['/my/contracts'],
    ['/my/notifications'],
    ['/my/notifications/settings'],
    ['/my/payments'],
    ['/my/projects'],
    ['/my/recommendations'],
    [`/payments/${x(ids.payMilestone)}`, 'payments_[id]'],
    ['/payments/result?status=success', 'payments_result'],
    ['/profile'],
    ['/profile/careers'],
    ['/profile/portfolio'],
    ['/settlements'],
    [`/settlements/${x(ids.settlement)}`, 'settlements_[id]'],
    ['/settlements/account'],
    [`/users/${x(ids.user)}`, 'users_[id]'],
    ['/this-page-does-not-exist', '404'],
  ].map(([url, name]) => [url, name || url.replace(/^\//, '').replace(/\//g, '_')]);
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  // Wait out client-side spinners ("animate-spin") so the frame shows loaded data.
  await page.waitForFunction(() => !document.querySelector('main .animate-spin'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
}

const browser = await chromium.launch();
let shots = 0;
try {
  let guestIds = null;
  for (const role of ROLES) {
    let storageState;
    let ids;
    if (role === 'guest') {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${BASE}/`);
      ids = guestIds || (await discoverIds(page, 'guest'));
      await ctx.close();
    } else {
      const ctx = await browser.newContext({ viewport: SIZES.desktop });
      const page = await ctx.newPage();
      await login(page, ACCOUNTS[role]);
      ids = await discoverIds(page, role);
      storageState = await ctx.storageState();
      await ctx.close();
    }
    console.log(role, ids);
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ ...SIZES[vp], viewport: { width: SIZES[vp].width, height: SIZES[vp].height }, storageState, locale: 'ko-KR' });
      const page = await ctx.newPage();
      for (const [url, name] of routes(ids)) {
        if (ONLY && !ONLY.includes(name)) continue;
        try {
          await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await settle(page);
          const file = path.join(outDir, `${role}-${vp}-${name}.png`);
          await page.screenshot({ path: file, fullPage: true });
          shots += 1;
        } catch (err) {
          console.warn(`! ${role}-${vp}-${name}: ${err.message.split('\n')[0]}`);
        }
      }
      // Logged-in only: the header user menu, opened, as a viewport shot.
      if (role !== 'guest' && (!ONLY || ONLY.includes('header-menu'))) {
        try {
          await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
          await settle(page);
          await page.locator('header button[aria-haspopup], header button:has(div.rounded-full)').first().click();
          await page.waitForTimeout(300);
          await page.screenshot({ path: path.join(outDir, `${role}-${vp}-header-menu.png`) });
          shots += 1;
        } catch (err) {
          console.warn(`! ${role}-${vp}-header-menu: ${err.message.split('\n')[0]}`);
        }
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`${shots} screenshots → ${outDir}`);
