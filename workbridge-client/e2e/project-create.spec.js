const { test, expect } = require('./helpers/fixtures');
const { uniqueTitle } = require('./helpers/accounts');

test('의뢰인이 화면에서 프로젝트를 등록하면 상세와 목록에 보인다', async ({ clientPage: page }) => {
  const title = uniqueTitle('설문 대시보드 구축');
  const description = 'E2E로 등록한 프로젝트입니다.\n관리자용 설문 대시보드를 만듭니다.';

  await page.goto('/projects/new');
  await expect(page.getByRole('heading', { name: '프로젝트 등록' })).toBeVisible();

  // 1단계: 기본 정보
  await page.getByLabel('프로젝트명').fill(title);
  await page.getByRole('combobox').selectOption('웹 개발');
  await page.getByPlaceholder('프로젝트에 대해 자세히 설명해 주세요').fill(description);
  await page.getByRole('button', { name: '다음' }).click();

  // 2단계: 모집 조건 (모집 시작일은 오늘이 기본값)
  await page.getByLabel('예산 (원)').fill('2500000');
  const deadline = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await page.getByLabel('마감일').fill(deadline);
  await page.getByRole('button', { name: '다음' }).click();

  // 3단계: 기술과 검토
  await page.getByRole('button', { name: 'React', exact: true }).click();
  await page.getByRole('button', { name: 'TypeScript', exact: true }).click();
  await expect(page.getByText(title)).toBeVisible();
  await page.getByRole('button', { name: '등록하기' }).click();

  // 상세 페이지
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
  const heading = page.getByRole('heading', { level: 1, name: title });
  await expect(heading).toBeVisible();
  await expect(heading.locator('..').getByText('모집 중')).toBeVisible();
  await expect(page.getByText('2,500,000원')).toBeVisible();
  await expect(page.getByRole('button', { name: '지원자 관리' })).toBeVisible();
  const detailUrl = page.url();

  // 목록 페이지: 최신순 첫 페이지에 있고, 검색으로도 찾을 수 있다
  await page.goto('/projects');
  await page.getByPlaceholder('프로젝트 검색...').fill(title);
  const card = page.getByRole('link', { name: title });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(detailUrl);
});
