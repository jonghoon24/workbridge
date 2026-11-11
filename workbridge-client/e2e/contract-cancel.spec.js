const { test, expect, loggedInPage } = require('./helpers/fixtures');
const { ACCOUNTS } = require('./helpers/accounts');
const { apiLogin, createProject, applyToProject, acceptApplication } = require('./helpers/api');

// A second seed freelancer who applies too and is rejected when park's application is accepted.
const OTHER_FREELANCER = { email: 'han@example.com', name: '한도윤' };

// State: a fresh project; park's application accepted (han's rejected with it); the client signed.
let project;
let contract;

test.beforeAll(async () => {
  const client = await apiLogin(ACCOUNTS.client.email);
  const freelancer = await apiLogin(ACCOUNTS.freelancer.email);
  const other = await apiLogin(OTHER_FREELANCER.email);
  project = await createProject(client, { budget: 2800000 });
  const application = await applyToProject(freelancer, project);
  await applyToProject(other, project);
  contract = await acceptApplication(client, project.id, application.id);
  await client.post(`/api/contracts/${contract.id}/sign`);
  await Promise.all([client.dispose(), freelancer.dispose(), other.dispose()]);
});

test('프리랜서가 서명 전 계약을 철회하면 의뢰인이 알림을 받고 다시 모집할 수 있으며, 거절됐던 지원자가 다시 지원한다', async ({
  browser,
  baseURL,
  clientPage,
  freelancerPage,
}) => {
  // 프리랜서: 의뢰인만 서명한 계약을 철회한다.
  await freelancerPage.goto(`/contracts/${contract.id}`);
  await expect(freelancerPage.getByText('의뢰인 서명 완료')).toBeVisible();
  await freelancerPage.getByRole('button', { name: '계약 철회' }).click();

  await expect(freelancerPage.getByText('철회됨', { exact: true })).toBeVisible();
  await expect(freelancerPage.getByTestId('contract-cancelled-notice')).toContainText('프리랜서가');
  await expect(freelancerPage.getByRole('button', { name: '계약서 서명하기' })).toHaveCount(0);
  await expect(freelancerPage.getByRole('button', { name: '계약 철회' })).toHaveCount(0);
  expect(freelancerPage.dialogs.some((message) => message.includes('서명 전 계약을 철회하시겠습니까?'))).toBe(true);

  // 의뢰인: 알림을 받고, 내 계약의 '철회됨'에서 계약을 본다.
  await clientPage.goto('/my/notifications');
  await expect(clientPage.getByText(`프리랜서가 '${project.title}' 계약을 서명 전에 철회했습니다.`)).toBeVisible();
  await clientPage.goto('/my/contracts');
  await clientPage.getByRole('button', { name: '철회됨' }).click();
  await expect(clientPage.getByRole('link', { name: project.title })).toBeVisible();

  // 의뢰인: 계약서에서 프로젝트로 가서 새 마감일로 다시 모집한다.
  await clientPage.goto(`/contracts/${contract.id}`);
  await expect(clientPage.getByText('철회됨', { exact: true })).toBeVisible();
  await clientPage.getByRole('link', { name: '프로젝트에서 다시 모집하기 →' }).click();
  await expect(clientPage).toHaveURL(new RegExp(`/projects/${project.id}$`));
  // 철회된 계약도 상대방의 기록이라 프로젝트를 지울 수 없다.
  await expect(clientPage.getByText('계약 기록이 있는 프로젝트는 상대방의 기록이라 삭제할 수 없습니다.')).toBeVisible();
  await expect(clientPage.getByRole('button', { name: '삭제' })).toHaveCount(0);
  await clientPage.getByRole('button', { name: '다시 모집하기' }).click();
  const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await clientPage.getByLabel('새 마감일').fill(deadline);
  await clientPage.getByRole('dialog').getByRole('button', { name: '다시 모집하기' }).click();
  // 모집 중이 되면 '다시 모집하기' 대신 '모집 마감' 버튼이 생긴다.
  await expect(clientPage.getByRole('button', { name: '모집 마감' })).toBeVisible();
  await expect(clientPage.getByRole('button', { name: '다시 모집하기' })).toHaveCount(0);

  // 이전 모집에서 거절된 지원자: 다시 지원할 수 있다.
  const { context, page: otherPage } = await loggedInPage(browser, baseURL, OTHER_FREELANCER);
  try {
    await otherPage.goto(`/projects/${project.id}`);
    await otherPage.getByRole('button', { name: '다시 지원하기' }).click();
    // 이전 지원서 내용이 채워져 있다.
    await expect(otherPage.getByRole('dialog', { name: '다시 지원하기' }).getByLabel('예상 기간')).toHaveValue('1개월');
    await otherPage.getByPlaceholder('지원 동기와 경험을 자세히 작성해 주세요').fill('다시 모집한다고 해서 지원합니다. 일정은 맞출 수 있습니다.');
    await otherPage.getByLabel('희망 금액 (원)').fill('2700000');
    await otherPage.getByLabel('예상 기간').fill('5주');
    await otherPage.getByRole('dialog').getByRole('button', { name: '지원하기' }).click();
    await expect(otherPage).toHaveURL(/\/my\/applications$/);
    const card = otherPage.getByTestId('application-card').filter({ has: otherPage.getByRole('link', { name: project.title }) });
    await expect(card.getByText('검토 중')).toBeVisible();
  } finally {
    await context.close();
  }

  // 철회한 프리랜서는 같은 프로젝트에 다시 지원할 수 없다.
  await freelancerPage.goto(`/projects/${project.id}`);
  await expect(freelancerPage.getByRole('button', { name: '지원 완료 · 내 지원 현황' })).toBeVisible();
  await expect(freelancerPage.getByText('철회된 계약의 당사자는 같은 프로젝트에 다시 지원할 수 없습니다.')).toBeVisible();
  await expect(freelancerPage.getByRole('button', { name: /지원하기/ })).toHaveCount(0);
});
