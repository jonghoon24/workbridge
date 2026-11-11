const { test, expect } = require('@playwright/test');
const { apiLogin, apiSignup } = require('./helpers/api');

// 공개 프로필. 프로필 값을 바꾸므로 시드 계정이 아니라 매번 새로 가입한 프리랜서를 쓴다.

test('경력 0년 프리랜서의 공개 프로필은 경력을 0년으로 보여 준다', async ({ page }) => {
  const account = await apiSignup({ label: 'zero-years' });
  const freelancer = await apiLogin(account.email, account.password);
  await freelancer.patch('/api/users/me', {
    experienceYears: 0,
    hourlyRate: 45000,
    activityCategory: '웹 개발',
    skills: ['React'],
  });
  const userId = freelancer.user.id;
  await freelancer.dispose();

  await page.goto(`/users/${userId}`);
  await expect(page.getByRole('heading', { name: account.name })).toBeVisible();

  const experience = page.locator('div', { has: page.getByText('경력', { exact: true }) }).last();
  await expect(experience).toHaveText(/경력\s*0년/);
  await expect(page.getByText('45,000원', { exact: true })).toBeVisible();
});
