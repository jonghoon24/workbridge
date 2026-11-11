const { test, expect, loggedInPage } = require('./helpers/fixtures');
const { ACCOUNTS, uniqueTitle } = require('./helpers/accounts');
const { apiLogin, apiSignup, createProject, applyToProject } = require('./helpers/api');

// A freshly signed-up freelancer, so the tab counts are exact on every run (park's applications
// pile up across runs). State: two PENDING applications and one REJECTED, none ACCEPTED — distinct
// counts catch a tab showing another tab's number, and the empty ACCEPTED tab shows the empty state.
let account;
let pendingProjects;
let rejectedProject;

test.beforeAll(async () => {
  account = await apiSignup({ role: 'FREELANCER', label: 'app-tabs' });
  const client = await apiLogin(ACCOUNTS.client.email);
  const freelancer = await apiLogin(account.email);
  // Applying needs a complete freelancer profile (requireCompleteProfile).
  await freelancer.patch('/api/users/me', {
    experienceYears: 3,
    hourlyRate: 45000,
    activityCategory: '웹 개발',
    skills: ['React'],
  });

  pendingProjects = [
    await createProject(client, { title: uniqueTitle('지원 탭 검토 A') }),
    await createProject(client, { title: uniqueTitle('지원 탭 검토 B') }),
  ];
  rejectedProject = await createProject(client, { title: uniqueTitle('지원 탭 거절') });

  for (const project of pendingProjects) await applyToProject(freelancer, project);
  const rejected = await applyToProject(freelancer, rejectedProject);
  await client.patch(`/api/projects/${rejectedProject.id}/applications/${rejected.id}`, { status: 'REJECTED' });

  await Promise.all([client.dispose(), freelancer.dispose()]);
});

test('내 지원 현황의 상태 탭이 개수를 보여 주고 고른 상태의 지원만 보인다', async ({ browser, baseURL }) => {
  const { context, page } = await loggedInPage(browser, baseURL, account);
  const tab = (label, count) => page.getByRole('button', { name: new RegExp(`^${label}\\s*${count}$`) });
  const cards = page.getByTestId('application-card');
  const projectLink = (project) => page.getByRole('link', { name: project.title });

  await page.goto('/my/applications');
  await expect(page.getByRole('heading', { name: '내 지원 현황' })).toBeVisible();

  // 탭마다 개수가 붙고, 처음에는 전체 탭이 선택되어 모든 지원이 보인다
  await expect(tab('전체', 3)).toHaveAttribute('aria-pressed', 'true');
  await expect(tab('검토 중', 2)).toHaveAttribute('aria-pressed', 'false');
  await expect(tab('수락됨', 0)).toBeVisible();
  await expect(tab('거절됨', 1)).toBeVisible();
  await expect(cards).toHaveCount(3);

  // 검토 중: 거절된 지원은 빠진다
  await tab('검토 중', 2).click();
  await expect(tab('검토 중', 2)).toHaveAttribute('aria-pressed', 'true');
  await expect(tab('전체', 3)).toHaveAttribute('aria-pressed', 'false');
  await expect(cards).toHaveCount(2);
  for (const project of pendingProjects) await expect(projectLink(project)).toBeVisible();
  await expect(projectLink(rejectedProject)).toHaveCount(0);

  // 거절됨: 거절된 지원 하나만, 거절됨 배지와 함께
  await tab('거절됨', 1).click();
  await expect(cards).toHaveCount(1);
  await expect(cards.filter({ has: projectLink(rejectedProject) }).getByText('거절됨')).toBeVisible();

  // 수락됨: 지원이 없으면 빈 상태 문구
  await tab('수락됨', 0).click();
  await expect(cards).toHaveCount(0);
  await expect(page.getByText('해당 상태의 지원이 없습니다')).toBeVisible();

  // 전체로 돌아오면 다시 모두 보인다
  await tab('전체', 3).click();
  await expect(cards).toHaveCount(3);

  await context.close();
});
