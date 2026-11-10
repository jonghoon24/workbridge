import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

import { env } from '../env';
import { AppError } from './errors';
import { logger } from './logger';

/**
 * Message and milestone-submission attachments in the **private** Supabase bucket
 * (`SUPABASE_ATTACHMENT_BUCKET`, docs/domain/messaging-notifications.md "첨부 파일").
 *
 * The browser uploads straight to storage with a signed upload URL, so a file never passes
 * through a Vercel function and its 4.5 MB request-body limit. Reads hand out short-lived signed
 * download URLs; the bucket has no public URLs. The profile image (`middlewares/upload.ts`) and
 * portfolio images stay in the public `workbridge` bucket — they are shown on public profiles.
 */

const MB = 1024 * 1024;

/** At most this many files per message or submission. */
export const ATTACHMENT_MAX_FILES = 5;
/** Each file at most this many bytes (inclusive). */
export const ATTACHMENT_MAX_BYTES = 10 * MB;

/** Signed upload URLs from Supabase are valid for 2 hours; an issued upload expires with its URL. */
export const UPLOAD_URL_TTL_MS = 2 * 60 * 60 * 1000;
/** The `url` of an attachment in a read response (inline previews, a plain link). */
export const ATTACHMENT_URL_TTL_SECONDS = 15 * 60;
/** The URL of the download route: used right away by the browser. */
export const DOWNLOAD_URL_TTL_SECONDS = 60;

const ATTACHMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'text/plain',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/x-hwp',
]);

/**
 * Images, PDF, ZIP, plain text, Office documents (docx/xlsx/pptx and the legacy formats) and HWP.
 * Keep in sync with the bucket's Allowed MIME types (docs/ENV.md): Supabase accepts `type/*` but
 * not a partial wildcard, so the Office Open XML types are listed one by one.
 */
export function isAllowedAttachmentType(mimetype: string): boolean {
  return mimetype.startsWith('image/') || ATTACHMENT_MIME_TYPES.has(mimetype);
}

/**
 * The per-file policy: an unsupported type is a 400, then a file over 10 MB is a 413 — the
 * order and messages the multipart upload middleware used.
 */
export function assertAttachmentPolicy(file: { mimeType: string; size: number }): void {
  if (!isAllowedAttachmentType(file.mimeType)) {
    throw new AppError(`Unsupported file type: ${file.mimeType}`, 400);
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    throw new AppError(`File too large (max ${ATTACHMENT_MAX_BYTES / MB}MB)`, 413);
  }
}

// ---------------------------------------------------------------------------
// Storage calls
// ---------------------------------------------------------------------------

let client: SupabaseClient | null = null;

/** The public bucket attachments lived in before (profile and portfolio images still do). */
export const LEGACY_PUBLIC_BUCKET = 'workbridge';

function storageClient(): SupabaseClient {
  client ??= createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
  return client;
}

/** Created on first use, so a server without Supabase settings still boots. */
function bucket() {
  return storageClient().storage.from(env.SUPABASE_ATTACHMENT_BUCKET);
}

export const UPLOAD_FAILED = 'File upload failed';
export const STORAGE_UNAVAILABLE = 'File storage is unavailable';

/** A signed URL the browser `PUT`s the file to. Storage failure → 502. */
export async function createUploadUrl(key: string): Promise<string> {
  const { data, error } = await bucket().createSignedUploadUrl(key);
  if (error || !data) {
    logger.warn('attachment upload url failed', { key, err: error });
    throw new AppError(UPLOAD_FAILED, 502);
  }
  return data.signedUrl;
}

function isNotFound(error: unknown): boolean {
  const e = error as { status?: unknown; statusCode?: unknown } | null;
  return e?.status === 404 || String(e?.statusCode) === '404';
}

/**
 * The stored object's real size and type, or `null` when nothing was uploaded at `key`.
 * Any other storage failure → 502.
 */
export async function statObject(key: string): Promise<{ size: number; mimeType: string } | null> {
  const { data, error } = await bucket().info(key);
  if (error) {
    if (isNotFound(error)) return null;
    logger.warn('attachment info failed', { key, err: error });
    throw new AppError(STORAGE_UNAVAILABLE, 502);
  }
  // `metadata` is untyped in storage-js; read it as unknown values.
  const metadata: Record<string, unknown> = data.metadata ?? {};
  const size = typeof data.size === 'number' ? data.size : Number(metadata.size);
  const metadataType = typeof metadata.mimetype === 'string' ? metadata.mimetype : undefined;
  const mimeType = data.contentType ?? metadataType ?? 'application/octet-stream';
  return { size: Number.isFinite(size) ? size : 0, mimeType };
}

/**
 * Signed download URLs for many keys in one storage call, in input order. A failure is not
 * fatal to a read: it logs a warning and yields `null` for the keys it could not sign.
 */
export async function signDownloadUrls(keys: readonly string[], ttlSeconds: number): Promise<(string | null)[]> {
  if (keys.length === 0) return [];
  const { data, error } = await bucket().createSignedUrls([...keys], ttlSeconds);
  if (error || !data) {
    logger.warn('attachment url signing failed', { count: keys.length, err: error });
    return keys.map(() => null);
  }
  const byPath = new Map(data.filter((d) => !d.error && d.path).map((d) => [d.path as string, d.signedUrl]));
  return keys.map((key) => byPath.get(key) ?? null);
}

/** One download URL that saves the file under its original name. Storage failure → 502. */
export async function signDownloadUrl(key: string, fileName: string, ttlSeconds: number): Promise<string> {
  const { data, error } = await bucket().createSignedUrl(key, ttlSeconds, { download: fileName });
  if (error || !data) {
    logger.warn('attachment download url failed', { key, err: error });
    throw new AppError(STORAGE_UNAVAILABLE, 502);
  }
  return data.signedUrl;
}

/** Deletes objects; a key that is already gone is not an error. Throws on a storage failure (jobs retry). */
export async function removeObjects(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const { error } = await bucket().remove([...keys]);
  if (error) throw new Error(`attachment remove failed: ${error.message}`);
}

/**
 * Copies a legacy attachment from the public bucket to the same key in the private bucket. An
 * object already at the destination (a rerun) counts as copied. Throws on any other failure.
 */
export async function copyFromLegacyBucket(key: string): Promise<void> {
  const { error } = await storageClient()
    .storage.from(LEGACY_PUBLIC_BUCKET)
    .copy(key, key, { destinationBucket: env.SUPABASE_ATTACHMENT_BUCKET });
  if (!error) return;
  const e = error as { status?: unknown; statusCode?: unknown };
  if (e.status === 409 || String(e.statusCode) === '409' || /already exists|duplicate/i.test(error.message)) return;
  throw new Error(`legacy attachment copy failed for ${key}: ${error.message}`);
}
