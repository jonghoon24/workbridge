import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { SECURITY_SCHEMES } from './common';
import { registerApplicationPaths } from './paths/applications';
import { registerAuthPaths } from './paths/auth';
import { registerContractPaths } from './paths/contracts';
import { registerConversationPaths } from './paths/conversations';
import { registerMilestonePaths } from './paths/milestones';
import { registerNotificationPaths } from './paths/notifications';
import { registerPaymentPaths } from './paths/payments';
import { registerProfilePaths } from './paths/profile';
import { registerProjectPaths } from './paths/projects';
import { registerReviewPaths } from './paths/reviews';
import { registerSettlementPaths } from './paths/settlements';
import { registerSystemPaths } from './paths/system';
import { registerUserPaths } from './paths/users';

/**
 * Every documented route, with the shared components. A new route is registered in
 * `paths/<domain>.ts`; `test/openapi.test.ts` fails until the app's routes and this registry match
 * both ways, and every test's responses are checked against the schemas registered here.
 *
 * Built fresh on each call (registration is cheap and keeps no module state).
 */
export function buildRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  registry.registerComponent('securitySchemes', SECURITY_SCHEMES.bearer, {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Access Token(기본 15분). 로그인·가입·`/api/auth/refresh`가 발급한다.',
  });
  registry.registerComponent('securitySchemes', SECURITY_SCHEMES.refreshCookie, {
    type: 'apiKey',
    in: 'cookie',
    name: 'refreshToken',
    description: 'Refresh Token(기본 7일). 로그인·가입·역할 선택이 HttpOnly 쿠키로 설정한다.',
  });
  registry.registerComponent('securitySchemes', SECURITY_SCHEMES.internalToken, {
    type: 'apiKey',
    in: 'header',
    name: 'X-Internal-Token',
    description: '서버의 `INTERNAL_JOB_TOKEN`과 같은 값(상수 시간 비교).',
  });

  registerSystemPaths(registry);
  registerAuthPaths(registry);
  registerUserPaths(registry);
  registerProfilePaths(registry);
  registerProjectPaths(registry);
  registerApplicationPaths(registry);
  registerContractPaths(registry);
  registerMilestonePaths(registry);
  registerPaymentPaths(registry);
  registerSettlementPaths(registry);
  registerReviewPaths(registry);
  registerNotificationPaths(registry);
  registerConversationPaths(registry);

  return registry;
}
