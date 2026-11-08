const { test, expect } = require('./helpers/fixtures');
const { ACCOUNTS } = require('./helpers/accounts');
const { apiLogin, createProject, applyToProject } = require('./helpers/api');

// State: a fresh project with park's pending application, built through the API.
let project;

test.beforeAll(async () => {
  const client = await apiLogin(ACCOUNTS.client.email);
  const freelancer = await apiLogin(ACCOUNTS.freelancer.email);
  project = await createProject(client, { budget: 3500000 });
  await applyToProject(freelancer, project);
  await Promise.all([client.dispose(), freelancer.dispose()]);
});

test('의뢰인이 지원을 수락하면 계약이 생기고, 양측이 서명하면 계약이 진행 중이 된다', async ({
  clientPage,
  freelancerPage,
}) => {
  // 의뢰인: 지원자 관리에서 수락
  await clientPage.goto(`/projects/${project.id}/applications`);
  await expect(clientPage.getByRole('heading', { name: '지원자 관리' })).toBeVisible();
  await expect(clientPage.getByRole('link', { name: ACCOUNTS.freelancer.name })).toBeVisible();
  await clientPage.getByRole('button', { name: '수락' }).click();

  // 수락하면 새 계약서로 이동한다. 아직 서명 전이다.
  await expect(clientPage).toHaveURL(/\/contracts\/[^/]+$/);
  const contractPath = new URL(clientPage.url()).pathname;
  await expect(clientPage.getByRole('heading', { name: '계약서' })).toBeVisible();
  await expect(clientPage.getByText('서명 대기', { exact: true })).toBeVisible();
  await expect(clientPage.getByRole('link', { name: project.title })).toBeVisible();
  await expect(clientPage.getByText('3,500,000원').first()).toBeVisible();
  await expect(clientPage.getByText('의뢰인 서명 대기')).toBeVisible();
  await expect(clientPage.getByText('프리랜서 서명 대기')).toBeVisible();

  // 의뢰인 서명
  await clientPage.getByRole('button', { name: '계약서 서명하기' }).click();
  await expect(clientPage.getByText('의뢰인 서명 완료')).toBeVisible();
  await expect(clientPage.getByRole('button', { name: '계약서 서명하기' })).toHaveCount(0);
  await expect(clientPage.getByText('서명 대기', { exact: true })).toBeVisible();

  // 프리랜서: 내 지원 현황에서 수락된 지원의 계약서로 이동해 서명
  await freelancerPage.goto('/my/applications');
  const application = freelancerPage
    .getByTestId('application-card')
    .filter({ has: freelancerPage.getByRole('link', { name: project.title }) });
  await expect(application.getByText('수락됨')).toBeVisible();
  await application.getByRole('link', { name: /계약서 보기/ }).click();
  await expect(freelancerPage).toHaveURL(new RegExp(`${contractPath}$`));
  await expect(freelancerPage.getByText('의뢰인 서명 완료')).toBeVisible();
  await freelancerPage.getByRole('button', { name: '계약서 서명하기' }).click();

  await expect(freelancerPage.getByText('계약 진행 중', { exact: true })).toBeVisible();
  await expect(freelancerPage.getByText('프리랜서 서명 완료')).toBeVisible();
  expect(freelancerPage.dialogs.some((message) => message.includes('계약이 체결되었습니다'))).toBe(true);

  // 의뢰인 화면에서도 진행 중이고, 첫 마일스톤을 결제할 수 있다
  await clientPage.reload();
  await expect(clientPage.getByText('계약 진행 중', { exact: true })).toBeVisible();
  await expect(clientPage.getByText('프리랜서 서명 완료')).toBeVisible();
  await expect(clientPage.getByRole('button', { name: '결제하기' })).toBeVisible();
});
