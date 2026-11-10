import multer from 'multer';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { requestContext } from '../lib/requestContext';
import { buildStorageKey, decodeOriginalName } from '../lib/storageKey';
import { uploadToSupabase } from './upload';

/**
 * Multipart upload middleware for portfolio images. Message and milestone-submission attachments
 * no longer pass through the server: the browser uploads them straight to the private bucket
 * (`lib/attachmentStorage.ts`, `services/attachments.service.ts`).
 * Unlike the profile-image `upload` in `./upload.ts` — whose filter throws a plain `Error`, so an
 * oversized or non-image profile image still surfaces as a 500 — every rejection here is an
 * `AppError`: oversized → 413, anything else → 400. The profile-image middleware has not been
 * moved to this pattern yet.
 */

export interface UploadPolicy {
  fieldName: string;
  maxFiles: number;
  maxBytes: number;
  allow(mimetype: string): boolean;
}

const MB = 1024 * 1024;

function toHttpError(err: unknown, policy: UploadPolicy): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof multer.MulterError) {
    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        return new AppError(`File too large (max ${policy.maxBytes / MB}MB)`, 413);
      case 'LIMIT_FILE_COUNT':
        return new AppError(`Too many files (max ${policy.maxFiles})`, 400);
      case 'LIMIT_UNEXPECTED_FILE':
        return new AppError(
          err.field === policy.fieldName
            ? `Too many files (max ${policy.maxFiles})`
            : `Unexpected file field: ${err.field}`,
          400,
        );
      default:
        return new AppError(err.message, 400);
    }
  }

  // Busboy parse failures ("Unexpected end of form", malformed headers) are client errors.
  return new AppError('Malformed multipart body', 400);
}

export function createUpload(policy: UploadPolicy): RequestHandler {
  const instance = multer({
    storage: multer.memoryStorage(),
    // Busboy flags a file as over the limit as soon as it *reaches* `fileSize` bytes, so a file
    // of exactly `maxBytes` would be rejected. One extra byte makes the limit inclusive.
    limits: { fileSize: policy.maxBytes + 1, files: policy.maxFiles },
    fileFilter: (req, file, cb) => {
      if (policy.allow(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new AppError(`Unsupported file type: ${file.mimetype}`, 400));
      }
    },
  });

  const parse = policy.maxFiles === 1
    ? instance.single(policy.fieldName)
    : instance.array(policy.fieldName, policy.maxFiles);

  return (req: Request, res: Response, next: NextFunction) => {
    // Busboy finishes in the socket's async context; re-enter the request's so the logger and
    // `enqueueJob` still see its request id downstream.
    const context = requestContext.getStore();
    parse(req, res, (err?: unknown) => {
      const forward = () => next(err ? toHttpError(err, policy) : undefined);
      if (context) {
        requestContext.run(context, forward);
      } else {
        forward();
      }
    });
  };
}

/** Field `image`: one image, 5 MB. Sets `req.file`. */
export const imageUpload = createUpload({
  fieldName: 'image',
  maxFiles: 1,
  maxBytes: 5 * MB,
  allow: (mimetype) => mimetype.startsWith('image/'),
});

export interface StoredFile {
  url: string;
  key: string;
  /** The original name restored to UTF-8, for display. */
  fileName: string;
  mimeType: string;
  size: number;
}

/**
 * Uploads one parsed file to the public bucket under `folder` (`portfolio`) with a `<uuid>.<ext>` key.
 * A storage failure is an upstream failure → 502, never a raw 500.
 */
export async function storeUploadedFile(file: Express.Multer.File, folder: string): Promise<StoredFile> {
  const key = buildStorageKey(folder, file.mimetype, file.originalname);
  const slash = key.lastIndexOf('/');

  let url: string;
  try {
    url = await uploadToSupabase(file.buffer, file.mimetype, key.slice(slash + 1), key.slice(0, slash));
  } catch (err) {
    logger.warn('file upload failed', { key, err });
    throw new AppError('File upload failed', 502);
  }

  return {
    url,
    key,
    fileName: decodeOriginalName(file.originalname),
    mimeType: file.mimetype,
    size: file.size,
  };
}
