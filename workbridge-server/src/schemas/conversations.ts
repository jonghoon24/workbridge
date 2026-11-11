import { z } from '../lib/zod';

import { uploadIdsField } from './attachments';
import { fieldCode, queryInt, queryString } from './common';
import { pageQuery } from './pagination';

/**
 * Query and body schemas of the conversation routes. Tests assert the error messages exactly, so
 * change them together with the tests (the client branches on the code, not the message).
 */

/** Message page size — default 30, a larger value yields 100. */
export const DEFAULT_MESSAGE_PAGE = 30;
export const MAX_MESSAGE_PAGE = 100;
/** At most this many characters after trimming. */
export const MAX_MESSAGE_LENGTH = 5000;

/** Conversation search (`q`): at most this many characters after trimming. */
export const MAX_CONVERSATION_SEARCH_LENGTH = 100;

/** `GET /api/conversations`: the shared `page`/`limit` query (`pageQuery`) and the search `q`. */
export const conversationListQuery = z.object({
  ...pageQuery,
  q: queryString()
    .transform((value, ctx) => {
      // Blank after trimming is the same as absent: list everything.
      const q = value?.trim();
      if (!q) return undefined;
      if (q.length > MAX_CONVERSATION_SEARCH_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must be at most ${MAX_CONVERSATION_SEARCH_LENGTH} characters`,
          params: fieldCode('TOO_LARGE'),
        });
        return z.NEVER;
      }
      return q;
    })
    .openapi({
      description:
        '프로젝트 제목이나 상대방 이름에 들어 있는 글자(대소문자 무시, 앞뒤 공백 제거). '
        + `공백뿐이면 없는 것과 같다. 최대 ${MAX_CONVERSATION_SEARCH_LENGTH}자.`,
    }),
});

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
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['before'], message: 'Use either before or after, not both', params: fieldCode('CONFLICT') });
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
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['body'], message: MESSAGE_REQUIRED, params: fieldCode('REQUIRED') });
    }
  });
