import type { ResponseConfig, ZodRequestBody } from '@asteasolutions/zod-to-openapi';
import type { ZodTypeAny } from 'zod';

import { z } from '../lib/zod';
import { errorBody } from './responses/common';

/**
 * Helpers shared by the path registrations in `src/openapi/paths/`. They keep each `registerPath`
 * short: who may call it (`security`), what it answers on success (`ok`, `created`), and which
 * errors it gives, as lists of the exact messages (`errors(...)`).
 */

// ---------------------------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------------------------

/** Names of `components.securitySchemes` (registered in `registry.ts`). */
export const SECURITY_SCHEMES = {
  bearer: 'bearerAuth',
  refreshCookie: 'refreshTokenCookie',
  internalToken: 'internalToken',
} as const;

/** `Authorization: Bearer <access token>` (`authenticate`). */
export const bearer = [{ [SECURITY_SCHEMES.bearer]: [] }];
/** No credentials. */
export const publicRoute: [] = [];

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export function ok(schema: ZodTypeAny, description = '성공'): ResponseConfig {
  return { description, content: { 'application/json': { schema } } };
}

export function created(schema: ZodTypeAny, description = '생성됨'): ResponseConfig {
  return ok(schema, description);
}

/** Statuses an error response may have (`AppError`, `validate()`, guards, uploads). */
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 502;

/** Per status, one line per cause: "`<message>` — <when>". */
export type ErrorSpec = Partial<Record<ErrorStatus, readonly string[]>>;

const STATUS_TITLES: Record<ErrorStatus, string> = {
  400: '잘못된 요청',
  401: '인증 실패',
  403: '권한 없음',
  404: '찾을 수 없음',
  409: '상태 충돌',
  410: '더 이상 지원하지 않음',
  413: '파일이 너무 큼',
  429: '요청 한도 초과',
  502: '외부 서비스 실패',
};

/**
 * Error responses, merged from several specs (guards first, then the route's own causes). Every
 * one has the `{ error: { message } }` body; a 429 also documents `Retry-After`.
 */
export function errors(...specs: ErrorSpec[]): Record<string, ResponseConfig> {
  const merged = new Map<ErrorStatus, string[]>();
  for (const spec of specs) {
    for (const [key, lines] of Object.entries(spec) as [string, readonly string[]][]) {
      const status = Number(key) as ErrorStatus;
      merged.set(status, [...(merged.get(status) ?? []), ...lines]);
    }
  }

  const responses: Record<string, ResponseConfig> = {};
  for (const status of [...merged.keys()].sort((a, b) => a - b)) {
    const lines = merged.get(status) ?? [];
    responses[String(status)] = {
      description: [STATUS_TITLES[status], '', ...lines.map((line) => `- ${line}`)].join('\n'),
      ...(status === 429
        ? { headers: z.object({ 'Retry-After': z.string().openapi({ description: '다시 시도할 수 있을 때까지의 초' }) }) }
        : {}),
      content: { 'application/json': { schema: errorBody } },
    };
  }
  return responses;
}

// Causes shared by many routes. Route-specific causes are written next to the route.

/** `authenticate`. */
export const AUTHENTICATED: ErrorSpec = {
  401: [
    '`Authentication required` — `Authorization: Bearer <토큰>` 헤더가 없음',
    '`Invalid or expired token` — 토큰이 위조됐거나 만료됨',
  ],
};

/** `authenticate` → `requireActiveUser` (expansion routes). */
export const ACTIVE_USER: ErrorSpec = {
  401: [...(AUTHENTICATED[401] ?? []), '`Account is no longer active` — 탈퇴(소프트 삭제)한 사용자'],
};

/** `requireRole(role)`. */
export function role(name: 'CLIENT' | 'FREELANCER'): ErrorSpec {
  return { 403: [`\`Insufficient permissions\` — ${name} 역할이 아님`] };
}

/** `requireCompleteProfile` (BEHAVIOR.md rule 4). */
export const COMPLETE_PROFILE: ErrorSpec = {
  403: ['`프로필을 먼저 완성해주세요` — 역할의 프로필 필수 항목이 비어 있음'],
};

/** `validate()`: the first failing field, as `<path>: <message>`. */
export function invalid(...lines: string[]): ErrorSpec {
  return { 400: ['`<필드>: <메시지>` — 요청 검증 실패(첫 번째 오류 하나만)', ...lines] };
}

/** `attachmentUpload` (field `files`, 5 × 10 MB) and storing the files (502). */
export const ATTACHMENT_UPLOAD: ErrorSpec = {
  400: [
    '`Too many files (max 5)` — 파일이 5개 넘음',
    '`Unsupported file type: <MIME>` — 이미지·문서·압축 파일이 아님',
    '`Unexpected file field: <필드>` — `files` 말고 다른 필드에 파일을 보냄',
    '`Malformed multipart body` — multipart 본문이 깨짐',
  ],
  413: ['`File too large (max 10MB)` — 10MB 넘는 파일'],
  502: ['`File upload failed` — 저장소(Supabase Storage) 업로드 실패'],
};

/** `imageUpload` (field `image`, one 5 MB image) and storing it (502). */
export const IMAGE_UPLOAD: ErrorSpec = {
  400: [
    '`Too many files (max 1)` — 이미지가 둘 이상',
    '`Unsupported file type: <MIME>` — 이미지가 아님',
    '`Unexpected file field: <필드>` — `image` 말고 다른 필드에 파일을 보냄',
    '`Malformed multipart body` — multipart 본문이 깨짐',
  ],
  413: ['`File too large (max 5MB)` — 5MB 넘는 이미지'],
  502: ['`File upload failed` — 저장소(Supabase Storage) 업로드 실패'],
};

/** A 404 of a resource lookup: "`<message>` — <when>". */
export function notFound(message: string, when: string): ErrorSpec {
  return { 404: [`\`${message}\` — ${when}`] };
}

export const NOT_OWNER: ErrorSpec = { 403: ['`Not authorized` — 호출자의 리소스가 아님'] };

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/** Path parameters: every one is a resource id (a UUID — not validated; an unknown id is a 404). */
export function pathParams<K extends string>(params: Record<K, string>) {
  const shape = Object.fromEntries(
    Object.entries<string>(params).map(([name, description]) => [
      name,
      z.string().openapi({ format: 'uuid', description }),
    ]),
  ) as Record<K, z.ZodString>;
  return z.object(shape);
}

export function jsonBody(schema: ZodTypeAny): ZodRequestBody {
  return { required: true, content: { 'application/json': { schema } } };
}

/** A file field of a multipart body. */
export const binaryFile = z.string().openapi({ format: 'binary' });
