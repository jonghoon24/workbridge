import { z } from '../lib/zod';

import { uploadIdsField } from './attachments';
import { queryInt, queryString } from './common';
import { pageQuery } from './pagination';

/**
 * Query and body schemas of the conversation routes. The error messages are part of the API
 * contract — tests assert them exactly — so change them only together with the tests.
 */

/** Message page size — default 30, a larger value yields 100. */
export const DEFAULT_MESSAGE_PAGE = 30;
export const MAX_MESSAGE_PAGE = 100;
/** At most this many characters after trimming. */
export const MAX_MESSAGE_LENGTH = 5000;

/** `GET /api/conversations`: the shared `page`/`limit` query (`pageQuery`). */
export const conversationListQuery = z.object({ ...pageQuery });

/** `GET /api/conversations/:id/messages`. */
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

export const MESSAGE_REQUIRED = 'Message or attachment is required';

/**
 * `POST /api/conversations/:id/messages`, JSON. An absent `body` is `''`; the files were uploaded
 * beforehand and are named by `uploadIds`. Empty with no uploads is a 400 on `body`.
 */
export const messageBody = z
  .object({
    body: z.preprocess(
      (value) => value ?? '',
      z.string().trim().max(MAX_MESSAGE_LENGTH, `Message must be at most ${MAX_MESSAGE_LENGTH} characters`),
    ),
    uploadIds: uploadIdsField,
  })
  .superRefine((value, ctx) => {
    if (value.body === '' && value.uploadIds.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['body'], message: MESSAGE_REQUIRED });
    }
  });
