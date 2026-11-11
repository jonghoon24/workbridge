import {
  ApplicationStatus,
  ApprovalType,
  ContractStatus,
  EmploymentType,
  MessageKind,
  MilestoneStatus,
  PaymentStatus,
  ProjectStatus,
  Role,
  SettlementStatus,
  SubmissionDecision,
} from '@prisma/client';

import type { ZodTypeAny } from 'zod';

import { ALL_ERROR_CODES, ERROR_CODES, FIELD_ERROR_CODES } from '../../lib/errorCodes';
import type { ErrorCode } from '../../lib/errorCodes';
import { z } from '../../lib/zod';

/**
 * Building blocks of the response schemas (`src/openapi/responses/*.ts`). Response schemas describe
 * what the controllers and services actually send — Prisma rows serialized by `res.json` — so a
 * `DateTime` column is an ISO 8601 string, a nullable column is `.nullable()`, and every key the
 * code emits is listed. The test suite checks every response against them (`test/helpers/openapi.ts`),
 * strictly: a key that is sent but not listed here fails the test that received it.
 *
 * A schema given a name with `.openapi('Name')` becomes `#/components/schemas/Name`.
 */

/** A `DateTime` column as `res.json` serializes it. */
export const dateTime = z.string().datetime();

/** A `YYYY-MM` month in KST (portfolio and career months). */
export const month = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .openapi({ description: '`YYYY-MM`(KST 월)', example: '2025-03' });

/** An amount in whole won. */
export const won = z.number().int().openapi({ description: '원 단위 정수' });

/**
 * An amount stored before amounts had to be whole won: `Application.expectedRate` and the
 * `Contract.amount` copied from it may be fractional on old rows. Everything
 * derived from them (milestones, payments, `contractAmount`) is rounded to whole won.
 */
export const legacyWon = z
  .number()
  .openapi({ description: '원. 새 행은 정수지만, 정수 규칙 이전에 만든 행은 소수일 수 있다.' });

/** A count or other non-negative integer. */
export const count = z.number().int().min(0);

export const id = z.string().openapi({ format: 'uuid' });

// Prisma enums, so the documented values cannot drift from the schema.
export const roleEnum = z.nativeEnum(Role).openapi('Role');
export const projectStatusEnum = z.nativeEnum(ProjectStatus).openapi('ProjectStatus');
export const applicationStatusEnum = z.nativeEnum(ApplicationStatus).openapi('ApplicationStatus');
export const contractStatusEnum = z.nativeEnum(ContractStatus).openapi('ContractStatus');
export const paymentStatusEnum = z.nativeEnum(PaymentStatus).openapi('PaymentStatus');
export const milestoneStatusEnum = z.nativeEnum(MilestoneStatus).openapi('MilestoneStatus');
export const approvalTypeEnum = z.nativeEnum(ApprovalType).openapi('ApprovalType');
export const submissionDecisionEnum = z.nativeEnum(SubmissionDecision).openapi('SubmissionDecision');
export const settlementStatusEnum = z.nativeEnum(SettlementStatus).openapi('SettlementStatus');
export const messageKindEnum = z.nativeEnum(MessageKind).openapi('MessageKind');
export const employmentTypeEnum = z.nativeEnum(EmploymentType).openapi('EmploymentType');

// ---------------------------------------------------------------------------------------------
// Errors (`errorHandler`)
// ---------------------------------------------------------------------------------------------

const ERROR_CODE_TABLE = [
  '오류 코드. 클라이언트는 이 값으로 분기한다 — `message`는 개발자용 영어 문장이라 바뀔 수 있다. '
    + '한 번 쓴 코드는 이름을 바꾸거나 다른 원인에 다시 쓰지 않고, 코드가 HTTP 상태를 정한다. '
    + '경로마다 내는 코드는 그 경로의 응답에 적혀 있다.',
  '',
  '| 코드 | HTTP | 뜻 |',
  '|---|---|---|',
  ...ALL_ERROR_CODES.map((code) => `| \`${code}\` | ${ERROR_CODES[code].status} | ${ERROR_CODES[code].description} |`),
].join('\n');

/** Every error code, with the table of what each means (`ErrorCode`). */
export const errorCodeEnum = z
  .enum(ALL_ERROR_CODES as [ErrorCode, ...ErrorCode[]])
  .openapi('ErrorCode', { description: ERROR_CODE_TABLE });

export const fieldErrorCodeEnum = z.enum(FIELD_ERROR_CODES).openapi('FieldErrorCode', {
  description: '필드가 틀린 이유: 없음(`REQUIRED`), 형식·값(`INVALID`), 최솟값·최댓값(`TOO_SMALL`·`TOO_LARGE` — 길이, 개수, '
    + '날짜 포함), 목록 안 중복(`NOT_UNIQUE`), 다른 필드와 맞지 않음(`CONFLICT`), 이 항목에 허용되지 않음(`NOT_ALLOWED`).',
});

export const fieldViolation = z
  .object({
    path: z.string().openapi({ description: '점으로 이은 필드 경로(`milestones.2.amount`). 본문·쿼리 전체가 원인이면 빈 문자열', example: 'budget' }),
    code: fieldErrorCodeEnum,
  })
  .openapi('FieldViolation');

const message = z
  .string()
  .min(1)
  .openapi('ErrorMessage', { description: '개발자와 로그를 위한 영어 문장. 바뀔 수 있으니 분기에 쓰지 않는다', example: 'Project not found' });

/** The body of every error response, with any code (`Error`). A 500 is `INTERNAL_ERROR`. */
export const errorBody = z
  .object({ error: z.object({ code: errorCodeEnum, message }) })
  .openapi('Error');

/** `VALIDATION_FAILED`: the error plus the failing field (`ValidationError`). */
export const validationErrorBody = z
  .object({
    error: z.object({
      code: z.literal('VALIDATION_FAILED'),
      message,
      fields: z.array(fieldViolation).min(1).openapi({ description: '원인 필드. 지금은 첫 번째 하나만 담지만 배열로 다룬다' }),
    }),
  })
  .openapi('ValidationError');

/** The 500 body — always exactly this. */
export const internalErrorBody = z.object({
  error: z.object({ code: z.literal('INTERNAL_ERROR'), message: z.literal('Internal Server Error') }),
});

/**
 * The error body of one documented status of one route: `code` is one of `codes`, the ones the route
 * documents for that status. A `VALIDATION_FAILED` among them has its own shape, with `fields`.
 */
export function errorBodyFor(codes: readonly ErrorCode[]): ZodTypeAny {
  const others = codes.filter((code) => code !== 'VALIDATION_FAILED');
  const other = others.length > 0
    ? z.object({ error: z.object({ code: z.enum(others as [ErrorCode, ...ErrorCode[]]), message }) })
    : null;
  if (!codes.includes('VALIDATION_FAILED')) return other ?? errorBody;
  return other ? z.union([validationErrorBody, other]) : validationErrorBody;
}

/** `{ id, name, profileImage }` — the user card on messages, contracts and reviews. */
export const userCard = z
  .object({
    id,
    name: z.string(),
    profileImage: z.string().nullable(),
  })
  .openapi('UserCard');

/** The `meta` of a paginated list (`page`/`limit` queries). */
export const paginationMeta = z
  .object({
    total: count,
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
    totalPages: count,
  })
  .openapi('PaginationMeta');

/** `{ message }` bodies of routes that report success in words. */
export const messageBody = z.object({ message: z.string() });

/** `{ unreadCount }` (notifications and conversations). */
export const unreadCountBody = z.object({ unreadCount: count });
