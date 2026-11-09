import { z } from '../lib/zod';

import { MAX_MILESTONES, MIN_MILESTONE_AMOUNT, MIN_MILESTONES } from '../lib/money';
import { kstDateString, kstDateToEndOfDay } from '../lib/time';

/**
 * Request bodies of the milestone routes. Messages are part of the API contract — tests assert
 * them exactly — so change them only together with the tests.
 */

const COUNT_MESSAGE = `A contract must have between ${MIN_MILESTONES} and ${MAX_MILESTONES} milestones`;

function isCalendarDate(value: string): boolean {
  try {
    kstDateToEndOfDay(value);
    return true;
  } catch {
    return false;
  }
}

const planItem = z.object({
  title: z.string().trim().min(1, 'Title is required').max(100, 'Title must be at most 100 characters'),
  description: z
    .string()
    .trim()
    .max(2000, 'Description must be at most 2000 characters')
    .nullish()
    .transform((value) => (value ? value : null)),
  amount: z
    .number()
    .int('Amount must be a whole number of won')
    .min(MIN_MILESTONE_AMOUNT, `Amount must be at least ${MIN_MILESTONE_AMOUNT}`),
  // Format and "not before today" are per-item checks, so they are reported in array order with
  // the other per-item checks. Today is the KST date at request time.
  dueDate: z.string().superRefine((value, ctx) => {
    if (!isCalendarDate(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Due date must be a YYYY-MM-DD date' });
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
    milestones: z.array(planItem).min(MIN_MILESTONES, COUNT_MESSAGE).max(MAX_MILESTONES, COUNT_MESSAGE),
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

/** A submission. Multipart fields arrive as strings; a single `links` value is a one-element list. */
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
      .openapi({ description: 'http(s) URL 최대 5개. multipart에서는 같은 필드를 반복하거나 하나만 보낸다.' }),
  ),
});

/** A revision request. */
export const rejectBody = z.object({
  reason: z
    .string({ required_error: 'Reason must be at least 10 characters' })
    .trim()
    .min(10, 'Reason must be at least 10 characters')
    .max(2000, 'Reason must be at most 2000 characters'),
});
