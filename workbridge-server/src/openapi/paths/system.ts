import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { runJobsBody } from '../../schemas/internal';
import { cause, errors, invalid, ok, publicRoute, SECURITY_SCHEMES } from '../common';
import { health, runJobsResult } from '../responses/internal';

export function registerSystemPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/health',
    operationId: 'health',
    tags: ['System'],
    summary: '헬스 체크',
    description: 'DB에 닿지 않는다.',
    security: publicRoute,
    responses: { 200: ok(health) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/internal/jobs/run',
    operationId: 'runJobs',
    tags: ['Internal'],
    summary: '작업 큐 한 번 실행',
    description:
      '외부 스케줄러(GitHub Actions `jobs.yml`, 15분마다)가 부른다. 반복 작업을 보장하고, 멈춘 작업을 회수한 뒤 '
      + '기한이 된 작업을 `limit`개까지 실행한다. 서버에 `INTERNAL_JOB_TOKEN`이 없으면 경로가 없는 것처럼 404다.',
    security: [{ [SECURITY_SCHEMES.internalToken]: [] }],
    request: {
      body: { required: false, content: { 'application/json': { schema: runJobsBody } } },
    },
    responses: {
      200: ok(runJobsResult, '이번 실행의 집계'),
      ...errors(invalid(), [
        cause('INTERNAL_TOKEN_INVALID', '`X-Internal-Token`이 없거나 틀림'),
        cause('ROUTE_NOT_FOUND', '`INTERNAL_JOB_TOKEN`이 설정되지 않음. 일치하는 경로가 없는 요청과 같은 응답이다'),
      ]),
    },
  });
}
