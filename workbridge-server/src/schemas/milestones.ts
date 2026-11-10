import { z } from '../lib/zod';

import { uploadIdsField } from './attachments';
import { MAX_MILESTONES, MIN_MILESTONE_AMOUNT, MIN_MILESTONES } from '../lib/money';
import { kstDateString, kstDateToEndOfDay } from '../lib/time';

/**
 * Request bodies of the milestone routes. Messages are part of the API contract — tests assert
 * them exactly — so change them only together with the tests.
 */

const COUNT_MESSAGE = `A contract must have between ${MIN_MILESTONES} and ${MAX_MILESTONES} milestones`;
const AMOUNT_MESSAGE = 'Amount must be a whole number of won';
const DUE_DATE_FORMAT_MESSAGE = 'Due date must be a YYYY-MM-DD date';

function isCalendarDate(value: string): boolean {
  try {
    kstDateToEndOfDay(value);
    return true;
  } catch {
    return false;
  }
}

// Every field states its missing / wrong-type message, so no zod default (`Required`,
// `Expected number, received string`) reaches the client.
const planItem = z.object({
  title: z.string({ required_error: 'Title is required', invalid_type_error: 'Title must be a string' }).trim().min(1, 'Title is required').max(100, 'Title must be at most 100 characters'),
  description: z
    .string({ invalid_type_error: 'Description must be a string' })
    .trim()
    .max(2000, 'Description must be at most 2000 characters')
    .nullish()
    .transform((value) => (value ? value : null)),
  amount: z
    .number({ required_error: AMOUNT_MESSAGE, invalid_type_error: AMOUNT_MESSAGE })
    .int(AMOUNT_MESSAGE)
    .min(MIN_MILESTONE_AMOUNT, `Amount must be at least ${MIN_MILESTONE_AMOUNT}`),
  // Format and "not before today" are per-item checks, so they are reported in array order with
  // the other per-item checks. Today is the KST date at request time.
  dueDate: z.string({ required_error: DUE_DATE_FORMAT_MESSAGE, invalid_type_error: DUE_DATE_FORMAT_MESSAGE }).superRefine((value, ctx) => {
    if (!isCalendarDate(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: DUE_DATE_FORMAT_MESSAGE });
    } else if (value < kstDateString(new Date())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Due date cannot be in the past' });
    }
  }).openapi({ format: 'date', description: 'KST 날짜. 오늘 이전은 안 된다.', example: '2026-12-31' }),
});

/**
 * The whole plan. The order check compares entries with each other, so it runs only once every entry has
 * passed its own checks — a decreasing date is reported after any per-item failure.
 */
export const milestonePlanBody = z
  .object({
    // Missing or not a list reads as "no milestones": the same count message.
    milestones: z
      .array(planItem, { required_error: COUNT_MESSAGE, invalid_type_error: COUNT_MESSAGE })
      .min(MIN_MILESTONES, COUNT_MESSAGE)
      .max(MAX_MILESTONES, COUNT_MESSAGE),
  })
  .superRefine((body, ctx) => {
    body.milestones.forEach((item, index) => {
      if (index > 0 && item.dueDate < body.milestones[index - 1].dueDate) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['milestones', index, 'dueDate'], message: 'Due dates must not decrease' });
      }
    });
  });

function isHttpUrl(value: string): boolean {
  if (value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A submission, JSON. The files were uploaded beforehand and are named by `uploadIds`. A single
 * `links` string is a one-element list.
 */
export const submissionBody = z.object({
  message: z
    .string({ required_error: 'Message is required' })
    .trim()
    .min(1, 'Message is required')
    .max(5000, 'Message must be at most 5000 characters'),
  links: z.preprocess(
    (value) => (value === undefined || value === '' ? [] : Array.isArray(value) ? value : [value]),
    z
      .array(z.string().trim().refine(isHttpUrl, 'Links must be http or https URLs').openapi({ format: 'uri' }))
      .max(5, 'At most 5 links are allowed')
      .openapi({ description: 'http(s) URL 최대 5개. 문자열 하나는 한 개짜리 목록이다.' }),
  ),
  uploadIds: uploadIdsField,
});

/** A revision request. */
export const rejectBody = z.object({
  reason: z
    .string({ required_error: 'Reason must be at least 10 characters' })
    .trim()
    .min(10, 'Reason must be at least 10 characters')
    .max(2000, 'Reason must be at most 2000 characters'),
});
