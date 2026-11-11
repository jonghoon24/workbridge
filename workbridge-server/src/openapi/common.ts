import type { ResponseConfig, ZodRequestBody } from '@asteasolutions/zod-to-openapi';
import type { ZodTypeAny } from 'zod';

import { z } from '../lib/zod';
import { ERROR_CODES } from '../lib/errorCodes';
import type { ErrorCode, ErrorHttpStatus } from '../lib/errorCodes';
import { errorBodyFor } from './responses/common';

/**
 * Helpers shared by the path registrations in `src/openapi/paths/`. They keep each `registerPath`
 * short: who may call it (`security`), what it answers on success (`ok`, `created`), and which
 * errors it gives, as error codes with when each happens (`errors(...)`).
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

/** One cause of an error response: its code and, in Korean, when it happens. */
export interface ErrorCause {
  code: ErrorCode;
  when: string;
  /** Sub-points of `when` (the notable field failures of a `VALIDATION_FAILED`). */
  details?: readonly string[];
}

/** A group of causes shared by many routes (the guards, the upload policies). */
export type ErrorSpec = readonly ErrorCause[];

export function cause(code: ErrorCode, when: string, details?: readonly string[]): ErrorCause {
  return details && details.length > 0 ? { code, when, details } : { code, when };
}

const STATUS_TITLES: Record<ErrorHttpStatus, string> = {
  400: '잘못된 요청',
  401: '인증 실패',
  403: '권한 없음',
  404: '찾을 수 없음',
  409: '상태 충돌',
  410: '더 이상 지원하지 않음',
  413: '본문이나 파일이 너무 큼',
  415: '지원하지 않는 본문 인코딩',
  429: '요청 한도 초과',
  500: '서버 오류',
  502: '외부 서비스 실패',
};

/**
 * The causes any route can give, before it runs: `express.json()` reads a JSON body on every
 * method, and Express decodes every path parameter. `ApiRegistry` (`registry.ts`) adds them to
 * every operation, so a test that sends one of them to any documented route still conforms.
 */
export function requestLevelCauses(path: string): ErrorSpec {
  return [
    cause('MALFORMED_BODY', '`Content-Type: application/json` 본문이 JSON으로 읽히지 않음(인증·검증보다 먼저)'),
    ...(path.includes('{') ? [cause('MALFORMED_REQUEST', '경로 파라미터의 퍼센트 인코딩이 깨짐')] : []),
    cause('PAYLOAD_TOO_LARGE', 'JSON 본문이 100KB를 넘음'),
    cause('UNSUPPORTED_MEDIA_TYPE', '본문의 문자셋이나 `Content-Encoding`을 읽을 수 없음'),
  ];
}

/** The causes each error response was built from, so `withCauses` can add more. */
const causesOf = new WeakMap<ResponseConfig, ErrorCause[]>();

function errorResponse(status: ErrorHttpStatus, causes: ErrorCause[]): ResponseConfig {
  const lines = causes.flatMap((c) => [
    `- \`${c.code}\` — ${c.when}`,
    ...(c.details ?? []).map((detail) => `  - ${detail}`),
  ]);
  const codes = [...new Set(causes.map((c) => c.code))];
  const response: ResponseConfig = {
    description: [STATUS_TITLES[status], '', ...lines].join('\n'),
    ...(status === 429
      ? { headers: z.object({ 'Retry-After': z.string().openapi({ description: '다시 시도할 수 있을 때까지의 초' }) }) }
      : {}),
    content: { 'application/json': { schema: errorBodyFor(codes) } },
  };
  causesOf.set(response, causes);
  return response;
}

/**
 * Error responses, one per status, from the causes of the route: the guards first, then its own.
 * Each status is documented with exactly the codes listed for it, so the test suite's response check
 * (`test/helpers/openapi.ts`) fails any test that receives a code the route does not document.
 * The status of a code comes from `ERROR_CODES`.
 */
export function errors(...items: (ErrorCause | ErrorSpec)[]): Record<string, ResponseConfig> {
  return withCauses({}, items.flat());
}

/** `responses` with `causes` merged into its error responses (built by `errors`). */
export function withCauses(responses: Record<string, ResponseConfig>, causes: readonly ErrorCause[]): Record<string, ResponseConfig> {
  const merged = new Map<ErrorHttpStatus, ErrorCause[]>();
  for (const [key, response] of Object.entries(responses)) {
    const existing = causesOf.get(response);
    if (existing) merged.set(Number(key) as ErrorHttpStatus, [...existing]);
  }
  for (const c of causes) {
    const status = ERROR_CODES[c.code].status;
    const list = merged.get(status) ?? [];
    if (!list.some((known) => known.code === c.code && known.when === c.when)) list.push(c);
    merged.set(status, list);
  }

  const out: Record<string, ResponseConfig> = { ...responses };
  for (const status of [...merged.keys()].sort((x, y) => x - y)) {
    const key = String(status);
    if (out[key] && !causesOf.has(out[key])) {
      throw new Error(`status ${key} is documented both as a success and as an error`);
    }
    out[key] = errorResponse(status, merged.get(status) ?? []);
  }
  return out;
}

// Causes shared by many routes. Route-specific causes are written next to the route.

/** `authenticate`. */
export const AUTHENTICATED: ErrorSpec = [
  cause('AUTH_REQUIRED', '`Authorization: Bearer <토큰>` 헤더가 없음'),
  cause('TOKEN_INVALID', '토큰이 위조됐거나 만료됨'),
];

/** `authenticate` → `requireActiveUser`, on the routes that mount it. */
export const ACTIVE_USER: ErrorSpec = [...AUTHENTICATED, cause('ACCOUNT_INACTIVE', '탈퇴(소프트 삭제)한 사용자')];

/** `requireRole(role)`. */
export function role(name: 'CLIENT' | 'FREELANCER'): ErrorCause {
  return cause('FORBIDDEN_ROLE', `${name} 역할이 아님`);
}

/** `requireCompleteProfile` (see `docs/domain/README.md`, 프로필 완성). */
export const COMPLETE_PROFILE = cause('PROFILE_INCOMPLETE', '역할의 프로필 필수 항목이 비어 있음');

/**
 * `validate()`, and the field checks a service makes itself (`invalidField`): a `VALIDATION_FAILED`
 * about the first failing field. `notes` name the notable ones as "`<path>` `<FIELD_CODE>` — <when>".
 */
export function invalid(...notes: string[]): ErrorCause {
  return cause('VALIDATION_FAILED', '요청 검증 실패. `fields`에 첫 번째 원인 필드 하나', notes);
}

/** Issuing upload URLs: the per-file policy (before any lookup) and the storage call (502). */
export const UPLOAD_POLICY: ErrorSpec = [
  invalid(
    '`files` `REQUIRED` — 파일 목록이 없거나 비어 있음',
    '`files` `TOO_LARGE` — 파일이 5개 넘음',
  ),
  cause('FILE_TYPE_UNSUPPORTED', '이미지·문서·압축 파일이 아님'),
  cause('FILE_TOO_LARGE', '10MB 넘는 파일'),
  cause('UPLOAD_FAILED', '저장소(Supabase Storage)가 업로드 URL을 만들지 못함'),
];

/** Claiming uploads by `uploadIds` on a message or submission: checked against storage. */
export const UPLOAD_CLAIM: ErrorSpec = [
  invalid(
    '`uploadIds` `TOO_LARGE` — 업로드가 5개 넘음',
    '`uploadIds` `NOT_UNIQUE` — 같은 업로드를 두 번 보냄',
  ),
  cause('UPLOAD_NOT_FOUND', '내가 이 대상에 받은 업로드가 아니거나, 만료됐거나, 이미 붙음'),
  cause('FILE_NOT_UPLOADED', '업로드 URL로 파일을 올리지 않음'),
  cause('FILE_TYPE_UNSUPPORTED', '저장된 파일의 형식이 허용되지 않음'),
  cause('FILE_TOO_LARGE', '저장된 파일이 10MB 넘음'),
  cause('STORAGE_UNAVAILABLE', '저장소(Supabase Storage)에서 파일을 확인하지 못함'),
];

/** The attachment download routes. */
export const ATTACHMENT_DOWNLOAD: ErrorSpec = [
  cause('STORAGE_UNAVAILABLE', '저장소(Supabase Storage)가 다운로드 URL을 만들지 못함'),
];

/** `imageUpload` (field `image`, one 5 MB image) and storing it (502). */
export const IMAGE_UPLOAD: ErrorSpec = [
  cause('TOO_MANY_FILES', '이미지가 둘 이상'),
  cause('FILE_TYPE_UNSUPPORTED', '이미지가 아님'),
  cause('MALFORMED_BODY', '`image` 말고 다른 필드에 파일을 보냈거나 multipart 본문이 깨짐'),
  cause('FILE_TOO_LARGE', '5MB 넘는 이미지'),
  cause('UPLOAD_FAILED', '저장소(Supabase Storage) 업로드 실패'),
];

export const NOT_OWNER = cause('FORBIDDEN_RESOURCE', '호출자의 리소스가 아님');

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
