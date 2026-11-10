import { z } from '../lib/zod';

import { ATTACHMENT_MAX_FILES } from '../lib/attachmentStorage';

/**
 * Bodies shared by the attachment routes of messages and milestone submissions
 * (docs/domain/messaging-notifications.md "첨부 파일"). The size and type policy is not here: it
 * answers 413/400 with the upload messages, in the service, before any lookup.
 */

const TOO_MANY = `Too many files (max ${ATTACHMENT_MAX_FILES})`;
const SIZE_MESSAGE = 'File size must be a whole number of bytes';

const requestedFile = z.object({
  fileName: z
    .string({ required_error: 'File name is required', invalid_type_error: 'File name is required' })
    .trim()
    .min(1, 'File name is required')
    .max(255, 'File name must be at most 255 characters')
    .openapi({ description: '원래 파일 이름. 화면과 내려받을 때의 이름이고 저장소 키에는 쓰지 않는다.' }),
  mimeType: z
    .string({ required_error: 'File type is required', invalid_type_error: 'File type is required' })
    .trim()
    .toLowerCase()
    .min(1, 'File type is required')
    .max(255, 'File type is required')
    .openapi({ description: 'MIME 형식. 브라우저가 모르면 `application/octet-stream`(허용되지 않음).', example: 'application/pdf' }),
  size: z
    .number({ required_error: SIZE_MESSAGE, invalid_type_error: SIZE_MESSAGE })
    .int(SIZE_MESSAGE)
    .min(0, SIZE_MESSAGE)
    .openapi({ description: '바이트' }),
});

/** `POST /api/conversations/:id/uploads`, `POST /api/milestones/:id/uploads`. */
export const uploadRequestBody = z.object({
  files: z
    .array(requestedFile, { required_error: 'At least one file is required', invalid_type_error: 'At least one file is required' })
    .min(1, 'At least one file is required')
    .max(ATTACHMENT_MAX_FILES, TOO_MANY),
});

/**
 * The `uploadIds` of a message or submission: the uploads to attach, in display order. Absent is
 * none.
 */
export const uploadIdsField = z
  .array(z.string({ invalid_type_error: 'Upload ids must be strings' }).min(1, 'Upload ids must be strings'), {
    invalid_type_error: 'Upload ids must be a list',
  })
  .max(ATTACHMENT_MAX_FILES, TOO_MANY)
  .refine((ids) => new Set(ids).size === ids.length, 'Upload ids must be unique')
  .default([])
  .openapi({ description: `업로드 URL을 받을 때 돌려받은 ID, 최대 ${ATTACHMENT_MAX_FILES}개. 한 번만 붙일 수 있다.` });
