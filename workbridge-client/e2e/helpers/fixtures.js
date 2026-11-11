// Role-based page fixtures. Each role gets its own browser context, logged in without the UI:
// `/api/auth/login` through the context's request sets the httpOnly `refreshToken` cookie (which
// `middleware.js` checks), and an init script mirrors `accessToken`/`user` into localStorage the
// way `authStore.setAuth` does. Both pages can be used in one test to play client and freelancer.
const base = require('@playwright/test');
const { ACCOUNTS, PASSWORD } = require('./accounts');

/** Native confirm()/alert() dialogs are accepted, and their messages kept for assertions. */
function acceptDialogs(page) {
  const messages = [];
  page.on('dialog', async (dialog) => {
    messages.push(dialog.message());
    await dialog.accept();
  });
  return messages;
}

async function loggedInPage(browser, baseURL, { email }) {
  const context = await browser.newContext({ baseURL, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const response = await context.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  if (!response.ok()) {
    throw new Error(`login ${email} -> ${response.status()}: ${await response.text()}`);
  }
  const { accessToken, user } = await response.json();
  await context.addInitScript(({ token, userJson }) => {
    window.localStorage.setItem('accessToken', token);
    window.localStorage.setItem('user', userJson);
  }, { token: accessToken, userJson: JSON.stringify(user) });

  const page = await context.newPage();
  page.dialogs = acceptDialogs(page);
  return { context, page };
}

const test = base.test.extend({
  clientPage: async ({ browser, baseURL }, use) => {
    const { context, page } = await loggedInPage(browser, baseURL, ACCOUNTS.client);
    await use(page);
    await context.close();
  },
  freelancerPage: async ({ browser, baseURL }, use) => {
    const { context, page } = await loggedInPage(browser, baseURL, ACCOUNTS.freelancer);
    await use(page);
    await context.close();
  },
});

module.exports = { test, expect: base.expect, acceptDialogs, loggedInPage };
