const { test, expect } = require('./helpers/fixtures');
const { ACCOUNTS } = require('./helpers/accounts');
const { apiLogin, createProject } = require('./helpers/api');

// A fresh project per run, found by its unique title, so the spec can run again against the same
// database without touching the seeded bookmarks.
let project;

test.beforeAll(async () => {
  const client = await apiLogin(ACCOUNTS.client.email);
  project = await createProject(client);
  await client.dispose();
});

test('프리랜서가 목록에서 북마크하면 카드마다 따로 조회하지 않고 상태가 유지되며 내 북마크에 보인다', async ({ freelancerPage: page }) => {
  // 목록은 북마크한 프로젝트 ID를 한 번에 불러온다. 카드마다 북마크 여부를 묻는 요청은 없어야 한다.
  const perCardLookups = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && /\/api\/projects\/[^/]+\/bookmark$/.test(new URL(request.url()).pathname)) {
      perCardLookups.push(request.url());
    }
  });

  const listPath = `/projects?search=${encodeURIComponent(project.title)}`;
  await page.goto(listPath);
  const card = page.locator('div', { has: page.getByRole('heading', { level: 3, name: project.title }) }).last();
  await expect(page.getByText('총 1개의 프로젝트')).toBeVisible();

  // 버튼은 응답 전에 바뀐다(낙관적 갱신). 저장이 끝난 뒤에 다시 연다.
  const saved = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/projects/${project.id}/bookmark`);
  await card.getByRole('button', { name: '북마크', exact: true }).click();
  await expect(card.getByRole('button', { name: '북마크됨', exact: true })).toBeVisible();
  expect((await saved).status()).toBe(201);

  // 다시 열어도 목록이 불러온 상태로 '북마크됨'이다
  await page.goto(listPath);
  await expect(page.getByText('총 1개의 프로젝트')).toBeVisible();
  await expect(card.getByRole('button', { name: '북마크됨', exact: true })).toBeVisible();
  expect(perCardLookups).toEqual([]);

  // 내 북마크에서 해제하면 목록에서 빠진다
  await page.goto('/my/bookmarks');
  await expect(page.getByRole('heading', { name: '내 북마크' })).toBeVisible();
  const bookmarkedCard = page.locator('div', { has: page.getByRole('heading', { level: 3, name: project.title }) }).last();
  await bookmarkedCard.getByRole('button', { name: '북마크됨', exact: true }).click();
  await expect(page.getByRole('heading', { level: 3, name: project.title })).toHaveCount(0);
  expect(perCardLookups).toEqual([]);
});
