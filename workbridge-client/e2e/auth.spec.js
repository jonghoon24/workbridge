const { test, expect } = require('@playwright/test');
const { ACCOUNTS, PASSWORD } = require('./helpers/accounts');

async function loginThroughForm(page, email, password) {
  await page.goto('/login');
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
}

function header(page) {
  return page.getByRole('banner');
}

test.describe('로그인과 로그아웃', () => {
  test('의뢰인은 로그인하면 의뢰인 메뉴를 보고, 로그아웃할 수 있다', async ({ page }) => {
    const { email, name } = ACCOUNTS.client;
    await loginThroughForm(page, email, PASSWORD);

    await expect(page).toHaveURL(/\/$/);
    const userMenu = header(page).getByRole('button', { name });
    await expect(userMenu).toBeVisible();
    await expect(header(page).getByRole('link', { name: '프로젝트 등록' })).toBeVisible();
    await expect(header(page).getByRole('link', { name: '로그인' })).toHaveCount(0);

    await userMenu.click();
    await expect(header(page).getByRole('link', { name: '내 프로젝트' })).toBeVisible();
    await expect(header(page).getByRole('link', { name: '결제 내역' })).toBeVisible();
    await expect(header(page).getByRole('link', { name: '내 지원 현황' })).toHaveCount(0);

    await header(page).getByRole('button', { name: '로그아웃' }).click();
    await expect(header(page).getByRole('link', { name: '로그인' })).toBeVisible();
    await expect(header(page).getByRole('button', { name })).toHaveCount(0);
    await expect(header(page).getByRole('link', { name: '프로젝트 등록' })).toHaveCount(0);

    // The refresh cookie is gone too: a protected route sends us back to /login.
    await page.goto('/my/contracts');
    await expect(page).toHaveURL(/\/login\?redirect=/);
  });

  test('프리랜서는 로그인하면 프리랜서 메뉴를 보고, 로그아웃할 수 있다', async ({ page }) => {
    const { email, name } = ACCOUNTS.freelancer;
    await loginThroughForm(page, email, PASSWORD);

    await expect(page).toHaveURL(/\/$/);
    const userMenu = header(page).getByRole('button', { name });
    await expect(userMenu).toBeVisible();
    await expect(header(page).getByRole('link', { name: '프로젝트 찾기' })).toBeVisible();
    await expect(header(page).getByRole('link', { name: '프로젝트 등록' })).toHaveCount(0);

    await userMenu.click();
    await expect(header(page).getByRole('link', { name: '내 지원 현황' })).toBeVisible();
    await expect(header(page).getByRole('link', { name: '정산' })).toBeVisible();
    await expect(header(page).getByRole('link', { name: '내 프로젝트' })).toHaveCount(0);

    await header(page).getByRole('button', { name: '로그아웃' }).click();
    await expect(header(page).getByRole('link', { name: '로그인' })).toBeVisible();
    await expect(header(page).getByRole('button', { name })).toHaveCount(0);
  });

  test('비밀번호가 틀리면 오류를 보여주고 로그인 페이지에 머문다', async ({ page }) => {
    await loginThroughForm(page, ACCOUNTS.client.email, 'wrong-password');

    // 서버 문구(Invalid credentials)는 화면에서 한국어로 바뀐다(lib/errorMessages.js)
    await expect(page.getByText('이메일 또는 비밀번호가 올바르지 않습니다.')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    await expect(header(page).getByRole('link', { name: '로그인' })).toBeVisible();
  });
});
