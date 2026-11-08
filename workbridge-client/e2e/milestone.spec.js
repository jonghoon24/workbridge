const { test, expect } = require('./helpers/fixtures');
const { ACCOUNTS } = require('./helpers/accounts');
const { apiLogin, buildActiveContract } = require('./helpers/api');

// State: an ACTIVE contract (both signed) with its single default milestone, built via the API.
let contract;
let milestone;

test.beforeAll(async () => {
  const client = await apiLogin(ACCOUNTS.client.email);
  const freelancer = await apiLogin(ACCOUNTS.freelancer.email);
  ({ contract } = await buildActiveContract(client, freelancer, { budget: 2000000 }));
  expect(contract.status).toBe('ACTIVE');
  expect(contract.milestones).toHaveLength(1);
  [milestone] = contract.milestones;
  await Promise.all([client.dispose(), freelancer.dispose()]);
});

test('결제 → 제출 → 승인으로 마지막 마일스톤이 승인되면 계약이 완료된다', async ({
  clientPage,
  freelancerPage,
}) => {
  const contractPath = `/contracts/${contract.id}`;
  const milestoneCard = (page) => page.getByTestId('milestone-card').filter({ hasText: milestone.title });

  // 1. 의뢰인: 개발용 결제 완료 처리로 마일스톤 결제
  await clientPage.goto(contractPath);
  await expect(clientPage.getByText('계약 진행 중', { exact: true })).toBeVisible();
  await expect(milestoneCard(clientPage).getByText('결제 대기')).toBeVisible();
  await clientPage.getByRole('button', { name: '결제하기' }).click();

  await expect(clientPage).toHaveURL(new RegExp(`/payments/${milestone.id}$`));
  await expect(clientPage.getByRole('heading', { name: '마일스톤 결제' })).toBeVisible();
  await clientPage.getByRole('button', { name: '개발용 결제 완료 처리' }).click();
  await expect(clientPage).toHaveURL(/\/payments\/result\?status=dev-success/);
  await expect(clientPage.getByRole('heading', { name: '결제 완료' })).toBeVisible();

  await clientPage.goto(contractPath);
  await expect(milestoneCard(clientPage).getByText('작업 중')).toBeVisible();
  await expect(clientPage.getByRole('button', { name: '결제하기' })).toHaveCount(0);

  // 2. 프리랜서: 결과물 제출
  await freelancerPage.goto(contractPath);
  await expect(milestoneCard(freelancerPage).getByText('작업 중')).toBeVisible();
  await freelancerPage.getByRole('button', { name: '제출하기', exact: true }).click();
  await expect(freelancerPage).toHaveURL(new RegExp(`/milestones/${milestone.id}#submission-form$`));
  await freelancerPage.getByLabel('작업 내용').fill('전체 작업을 마쳤습니다. 저장소 링크에서 확인해 주세요.');
  await freelancerPage.getByPlaceholder('https://github.com/...').fill('https://github.com/example/e2e-deliverable');
  await freelancerPage.getByRole('button', { name: '결과물 제출하기' }).click();
  // 상세 페이지 상단 배지와 제출 이력 모두 검수 대기, 자동 승인 안내가 뜬다
  await expect(freelancerPage.getByText('검수 대기', { exact: true }).first()).toBeVisible();
  await expect(freelancerPage.getByText(/자동 승인까지 .+ 남음/)).toBeVisible();
  await expect(freelancerPage.getByRole('button', { name: '결과물 제출하기' })).toHaveCount(0);

  // 3. 의뢰인: 계약서에서 검수 대기 마일스톤을 승인 → 계약 완료
  await clientPage.reload();
  await expect(milestoneCard(clientPage).getByText('검수 대기')).toBeVisible();
  await milestoneCard(clientPage).getByRole('button', { name: '승인' }).click();

  await expect(milestoneCard(clientPage).getByText('승인 완료')).toBeVisible();
  await expect(clientPage.getByText('완료', { exact: true })).toBeVisible();
  await expect(clientPage.getByRole('heading', { name: '리뷰' })).toBeVisible();
  expect(clientPage.dialogs.some((message) => message.includes('마일스톤을 승인하시겠습니까'))).toBe(true);
  expect(clientPage.dialogs.some((message) => message.includes('계약이 완료되었습니다'))).toBe(true);

  // 프리랜서 화면에서도 계약이 완료되어 있다
  await freelancerPage.goto(contractPath);
  await expect(freelancerPage.getByText('완료', { exact: true })).toBeVisible();
  await expect(milestoneCard(freelancerPage).getByText('승인 완료')).toBeVisible();
});
