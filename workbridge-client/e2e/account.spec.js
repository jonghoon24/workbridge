const { test, expect } = require('@playwright/test');
const { apiSignup } = require('./helpers/api');

// 계정 설정. 비밀번호와 계정 자체를 바꾸므로 시드 계정이 아니라 매번 새로 가입한 계정을 쓴다.

async function loginThroughForm(page, email, password) {
  await page.goto('/login');
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
}

function header(page) {
  return page.getByRole('banner');
}

test.describe('계정 설정', () => {
  test('비밀번호를 바꾸면 이 기기는 로그인을 유지하고, 다른 기기는 로그아웃되고, 새 비밀번호로만 로그인된다', async ({ browser }) => {
    const account = await apiSignup({ label: 'password' });
    const newPassword = 'changed-password-1';

    // 두 기기: 둘 다 바꾸기 전에 로그인한다.
    const thisDevice = await browser.newContext();
    const otherDevice = await browser.newContext();
    const page = await thisDevice.newPage();
    const other = await otherDevice.newPage();
    await loginThroughForm(page, account.email, account.password);
    await expect(header(page).getByRole('button', { name: account.name })).toBeVisible();
    await loginThroughForm(other, account.email, account.password);
    await expect(header(other).getByRole('button', { name: account.name })).toBeVisible();

    // 헤더 메뉴 → 계정 설정 → 비밀번호 변경
    await header(page).getByRole('button', { name: account.name }).click();
    await header(page).getByRole('link', { name: '계정 설정' }).click();
    await expect(page.getByRole('heading', { name: '계정 설정' })).toBeVisible();
    await expect(page.getByText('이메일과 비밀번호')).toBeVisible();
    await page.getByLabel('현재 비밀번호').fill(account.password);
    await page.getByLabel('새 비밀번호', { exact: true }).fill(newPassword);
    await page.getByLabel('새 비밀번호 확인').fill(newPassword);
    await page.getByRole('button', { name: '비밀번호 변경' }).click();
    await expect(page.getByText('비밀번호를 변경했습니다. 다른 기기에서는 다시 로그인해야 합니다.')).toBeVisible();

    // 이 기기: 응답으로 받은 새 리프레시 쿠키로 토큰이 갱신되고, 보호된 화면이 로그인한 채로 열린다.
    expect((await page.request.post('/api/auth/refresh')).status()).toBe(200);
    await page.goto('/my/contracts');
    await expect(page.getByRole('heading', { name: '내 계약' })).toBeVisible();
    await expect(page).toHaveURL(/\/my\/contracts$/);
    await expect(header(page).getByRole('button', { name: account.name })).toBeVisible();

    // 다른 기기: 옛 리프레시 쿠키로는 갱신되지 않는다. 액세스 토큰이 만료되면(지워서 흉내 낸다) 로그인 화면으로 간다.
    expect((await other.request.post('/api/auth/refresh')).status()).toBe(401);
    await other.evaluate(() => window.localStorage.removeItem('accessToken'));
    await other.goto('/my/contracts');
    await expect(other).toHaveURL(/\/login\?redirect=/);

    // 옛 비밀번호는 거절되고 새 비밀번호로 로그인된다.
    await header(page).getByRole('button', { name: account.name }).click();
    await header(page).getByRole('button', { name: '로그아웃' }).click();
    await expect(header(page).getByRole('link', { name: '로그인' })).toBeVisible();
    await loginThroughForm(page, account.email, account.password);
    await expect(page.getByText('이메일 또는 비밀번호가 올바르지 않습니다.')).toBeVisible();
    await loginThroughForm(page, account.email, newPassword);
    await expect(header(page).getByRole('button', { name: account.name })).toBeVisible();

    await thisDevice.close();
    await otherDevice.close();
  });

  test('현재 비밀번호가 틀리면 오류를 보여 주고 비밀번호는 그대로다', async ({ page }) => {
    const account = await apiSignup({ label: 'wrong-password' });
    await loginThroughForm(page, account.email, account.password);
    await expect(header(page).getByRole('button', { name: account.name })).toBeVisible();

    await page.goto('/my/account');
    await page.getByLabel('현재 비밀번호').fill('not-my-password');
    await page.getByLabel('새 비밀번호', { exact: true }).fill('changed-password-2');
    await page.getByLabel('새 비밀번호 확인').fill('changed-password-2');
    await page.getByRole('button', { name: '비밀번호 변경' }).click();

    await expect(page.getByText('현재 비밀번호가 올바르지 않습니다.')).toBeVisible();
    // 401이 아니라서 로그인이 풀리지 않는다.
    await expect(page).toHaveURL(/\/my\/account$/);
    await expect(header(page).getByRole('button', { name: account.name })).toBeVisible();
  });
});
