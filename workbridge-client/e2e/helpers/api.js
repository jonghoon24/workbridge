// Thin API client for building state before a spec drives the UI. It goes through the client's
// same-origin `/api/*` proxy (E2E_BASE_URL), exactly like the browser does.
const { request } = require('@playwright/test');
const { BASE_URL, PASSWORD, uniqueTitle } = require('./accounts');

class Api {
  constructor(context, accessToken, user) {
    this.context = context;
    this.accessToken = accessToken;
    this.user = user;
  }

  async call(method, path, { data, multipart } = {}) {
    const response = await this.context.fetch(path, {
      method,
      headers: { Authorization: `Bearer ${this.accessToken}` },
      ...(data !== undefined ? { data } : {}),
      ...(multipart !== undefined ? { multipart } : {}),
    });
    const text = await response.text();
    if (!response.ok()) {
      throw new Error(`${method} ${path} -> ${response.status()}: ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }

  get(path) {
    return this.call('GET', path);
  }

  post(path, data) {
    return this.call('POST', path, { data });
  }

  patch(path, data) {
    return this.call('PATCH', path, { data });
  }

  dispose() {
    return this.context.dispose();
  }
}

/** Logs in through `/api/auth/login` and returns an `Api` carrying the Bearer access token. */
async function apiLogin(email, password = PASSWORD) {
  const context = await request.newContext({ baseURL: BASE_URL });
  const response = await context.post('/api/auth/login', { data: { email, password } });
  if (!response.ok()) {
    throw new Error(`login ${email} -> ${response.status()}: ${await response.text()}`);
  }
  const { accessToken, user } = await response.json();
  return new Api(context, accessToken, user);
}

function dateOffset(days) {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

// --- State builders --------------------------------------------------------

/** An OPEN project owned by the client behind `clientApi`. */
function createProject(clientApi, overrides = {}) {
  return clientApi.post('/api/projects', {
    title: uniqueTitle('프로젝트'),
    description: 'E2E 테스트가 만든 프로젝트입니다.',
    category: '웹 개발',
    budget: 3000000,
    deadline: dateOffset(30),
    requiredSkills: ['React', 'Node.js'],
    ...overrides,
  });
}

/** The freelancer applies at the project's budget, so accepting needs no amount confirmation. */
function applyToProject(freelancerApi, project, overrides = {}) {
  return freelancerApi.post(`/api/projects/${project.id}/applications`, {
    coverLetter: 'E2E 테스트 지원서입니다. 비슷한 프로젝트 경험이 있습니다.',
    expectedRate: project.budget,
    expectedDuration: '1개월',
    ...overrides,
  });
}

/** Accepting creates the contract (PENDING) with its default milestone. Returns the contract. */
async function acceptApplication(clientApi, projectId, applicationId) {
  const result = await clientApi.patch(`/api/projects/${projectId}/applications/${applicationId}`, {
    status: 'ACCEPTED',
  });
  return result.contract;
}

/** project -> application -> PENDING contract. */
async function buildPendingContract(clientApi, freelancerApi, projectOverrides = {}) {
  const project = await createProject(clientApi, projectOverrides);
  const application = await applyToProject(freelancerApi, project);
  const contract = await acceptApplication(clientApi, project.id, application.id);
  return { project, application, contract };
}

/** project -> application -> contract signed by both sides (ACTIVE). Returns the full contract. */
async function buildActiveContract(clientApi, freelancerApi, projectOverrides = {}) {
  const { project, contract } = await buildPendingContract(clientApi, freelancerApi, projectOverrides);
  await clientApi.post(`/api/contracts/${contract.id}/sign`);
  await freelancerApi.post(`/api/contracts/${contract.id}/sign`);
  const active = await clientApi.get(`/api/contracts/${contract.id}`);
  return { project, contract: active };
}

module.exports = {
  Api,
  apiLogin,
  createProject,
  applyToProject,
  acceptApplication,
  buildPendingContract,
  buildActiveContract,
};
