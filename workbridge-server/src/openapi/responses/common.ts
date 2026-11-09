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

/** A `YYYY-MM` month in KST (portfolio and career months, BEHAVIOR.md PF2). */
export const month = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .openapi({ description: '`YYYY-MM`(KST 월)', example: '2025-03' });

/** An amount in whole won. */
export const won = z.number().int().openapi({ description: '원 단위 정수' });

/**
 * An amount stored before amounts had to be whole won: `Application.expectedRate` and the
 * `Contract.amount` copied from it may be fractional on old rows (BEHAVIOR.md M7). Everything
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

/** The body of every error response (`errorHandler`, BEHAVIOR.md rule 1). */
export const errorBody = z
  .object({
    error: z.object({
      message: z.string().min(1).openapi({ example: 'Project not found' }),
    }),
  })
  .openapi('Error');

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
