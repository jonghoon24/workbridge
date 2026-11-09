import { z } from '../lib/zod';

import { queryInt, queryString } from './common';
import { pageQuery } from './pagination';

/**
 * Query and body schemas of the conversation routes (BEHAVIOR.md MG1, MG11, MG14, MG15). Messages
 * are part of the spec — tests assert them exactly — so keep them in sync with BEHAVIOR.md.
 */

/** MG1: message page size — default 30, a larger value yields 100. */
export const DEFAULT_MESSAGE_PAGE = 30;
export const MAX_MESSAGE_PAGE = 100;
/** MG1: at most this many characters after trimming. */
export const MAX_MESSAGE_LENGTH = 5000;

/** `GET /api/conversations` (MG11): `page`/`limit` exactly as CT2. */
export const conversationListQuery = z.object({ ...pageQuery });

/** `GET /api/conversations/:id/messages` (MG14). */
export const messageListQuery = z
  .object({
    before: queryString().openapi({ description: '이 메시지 ID보다 오래된 메시지' }),
    after: queryString().openapi({ description: '이 메시지 ID보다 새로운 메시지. `before`와 함께 쓸 수 없다.' }),
    limit: queryInt({ min: 1, fallback: DEFAULT_MESSAGE_PAGE })
      .transform((limit) => Math.min(limit, MAX_MESSAGE_PAGE))
      .openapi({ description: `${MAX_MESSAGE_PAGE}보다 크면 ${MAX_MESSAGE_PAGE}로 줄인다.` }),
  })
  .superRefine((query, ctx) => {
    if (query.before !== undefined && query.after !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['before'], message: 'Use either before or after, not both' });
    }
  });

export type MessageListQuery = z.infer<typeof messageListQuery>;

/**
 * `POST /api/conversations/:id/messages` (MG15), multipart or JSON. An absent `body` is `''`.
 * "Empty and no files" needs `req.files`, which a body schema cannot see — the controller checks
 * it right after this, still before any lookup (MG15 step 1).
 */
export const messageBody = z.object({
  body: z.preprocess(
    (value) => value ?? '',
    z.string().trim().max(MAX_MESSAGE_LENGTH, `Message must be at most ${MAX_MESSAGE_LENGTH} characters`),
  ),
});

export const MESSAGE_REQUIRED = 'body: Message or attachment is required';
