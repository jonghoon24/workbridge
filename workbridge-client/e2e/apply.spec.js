const { test, expect } = require('./helpers/fixtures');
const { ACCOUNTS } = require('./helpers/accounts');
const { apiLogin, createProject } = require('./helpers/api');

// A fresh OPEN project per run: park has not applied to it, so the spec can run again and again
// against the same database (seed projects would already carry park's application after run 1).
let project;

test.beforeAll(async () => {
  const client = await apiLogin(ACCOUNTS.client.email);
  project = await createProject(client, { budget: 4000000 });
  await client.dispose();
});

test('프리랜서가 모집 중인 프로젝트에 지원하면 내 지원 현황에 검토 중으로 보인다', async ({ freelancerPage: page }) => {
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole('heading', { level: 1, name: project.title })).toBeVisible();
  await expect(page.getByText(`${project.category} · 지원자 0명`)).toBeVisible();

  await page.getByRole('button', { name: '지원하기' }).click();
  const dialog = page.getByRole('dialog', { name: '프로젝트 지원' });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder('지원 동기와 경험을 자세히 작성해 주세요')
    .fill('비슷한 대시보드를 세 번 만들어 본 경험이 있습니다. E2E 지원서입니다.');
  await dialog.getByLabel('제안 금액 (원)').fill('3800000');
  await dialog.getByLabel('예상 기간').fill('6주');
  await dialog.getByRole('button', { name: '지원하기' }).click();

  // 지원하면 내 지원 현황으로 이동한다
  await expect(page).toHaveURL(/\/my\/applications$/);
  await expect(page.getByRole('heading', { name: '내 지원 현황' })).toBeVisible();
  const projectLink = page.getByRole('link', { name: project.title });
  await expect(projectLink).toBeVisible();
  const card = page.getByTestId('application-card').filter({ has: projectLink });
  await expect(card.getByText('검토 중')).toBeVisible();

  // 상세 페이지의 지원자 수도 늘어난다
  await projectLink.click();
  await expect(page.getByText(`${project.category} · 지원자 1명`)).toBeVisible();

  // 이미 지원한 프로젝트에는 '지원하기' 대신 '지원 완료'가 보인다
  await expect(page.getByRole('link', { name: '지원 완료 · 내 지원 현황' })).toBeVisible();
  await expect(page.getByRole('button', { name: '지원하기' })).toHaveCount(0);

  // 화면을 거치지 않고 다시 지원해도 서버가 거절한다(지원은 프로젝트당 한 번)
  const freelancer = await apiLogin(ACCOUNTS.freelancer.email);
  await expect(
    freelancer.post(`/api/projects/${project.id}/applications`, {
      coverLetter: '두 번째 지원서',
      expectedRate: 3800000,
      expectedDuration: '6주',
    }),
  ).rejects.toThrow(/409/);
  await freelancer.dispose();
});
