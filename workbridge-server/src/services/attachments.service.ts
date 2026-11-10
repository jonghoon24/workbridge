import { randomUUID } from 'node:crypto';
import type { AttachmentUploadScope } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import {
  ATTACHMENT_URL_TTL_SECONDS,
  DOWNLOAD_URL_TTL_SECONDS,
  UPLOAD_URL_TTL_MS,
  LEGACY_PUBLIC_BUCKET,
  assertAttachmentPolicy,
  copyFromLegacyBucket,
  createUploadUrl,
  signDownloadUrl,
  signDownloadUrls,
  statObject,
} from '../lib/attachmentStorage';
import { buildStorageKey } from '../lib/storageKey';
import type { PrismaTransactionClient } from '../types/index';

/**
 * Attachments of messages and milestone submissions, stored in the private bucket
 * (docs/domain/messaging-notifications.md "첨부 파일"). Three steps:
 *
 * 1. **Issue** — the caller passes the domain checks, then {@link issueUploads} checks the policy,
 *    signs one upload URL per file and records an `AttachmentUpload` for the caller and target.
 * 2. The browser `PUT`s each file to its URL. Nothing of ours runs.
 * 3. **Claim** — the message or submission names the upload ids. {@link verifyUploads} (before the
 *    transaction) checks each was issued to this caller for this target and has not expired, and
 *    re-reads the stored object's real size and type against the policy. {@link consumeUploads}
 *    (inside the transaction) deletes the upload rows conditionally, so an upload is attached once.
 *
 * Reads never expose a storage key: {@link presignAttachments} turns each attachment row into the
 * public shape with a short-lived signed URL (or the legacy public URL of an old row).
 */

export interface RequestedFile {
  fileName: string;
  mimeType: string;
  size: number;
}

export const UPLOAD_NOT_FOUND = 'uploadIds: Upload not found or expired';
export const FILE_NOT_UPLOADED = 'uploadIds: File has not been uploaded';

/** Policy per file, in request order. Runs before any lookup, like the upload middleware did. */
export function assertRequestedFiles(files: readonly RequestedFile[]): void {
  for (const file of files) assertAttachmentPolicy(file);
}

/** Signs an upload URL per file and records the uploads. `folder` comes from code, never the user. */
export async function issueUploads(
  userId: string,
  scope: AttachmentUploadScope,
  targetId: string,
  folder: string,
  files: readonly RequestedFile[],
  now: Date,
) {
  const expiresAt = new Date(now.getTime() + UPLOAD_URL_TTL_MS);
  const planned = files.map((file) => ({
    id: randomUUID(),
    storageKey: buildStorageKey(folder, file.mimeType, file.fileName),
    ...file,
  }));
  const urls = await Promise.all(planned.map((p) => createUploadUrl(p.storageKey)));

  await prisma.attachmentUpload.createMany({
    data: planned.map((p) => ({
      id: p.id,
      userId,
      scope,
      targetId,
      storageKey: p.storageKey,
      fileName: p.fileName,
      mimeType: p.mimeType,
      size: p.size,
      expiresAt,
    })),
  });

  return {
    uploads: planned.map((p, index) => ({
      id: p.id,
      fileName: p.fileName,
      mimeType: p.mimeType,
      size: p.size,
      uploadUrl: urls[index],
      expiresAt,
    })),
  };
}

export interface VerifiedUpload {
  id: string;
  storageKey: string;
  fileName: string;
  /** The stored object's own values, not the browser's declaration. */
  mimeType: string;
  size: number;
}

/**
 * The uploads `uploadIds` name, in that order, after checking each one was issued to `userId` for
 * this target, has not expired, and holds a file that passes the policy. Network calls only — run
 * it before the transaction.
 */
export async function verifyUploads(
  userId: string,
  scope: AttachmentUploadScope,
  targetId: string,
  uploadIds: readonly string[],
  now: Date,
): Promise<VerifiedUpload[]> {
  if (uploadIds.length === 0) return [];
  const rows = await prisma.attachmentUpload.findMany({
    where: { id: { in: [...uploadIds] }, userId, scope, targetId, expiresAt: { gt: now } },
  });
  if (rows.length !== uploadIds.length) throw new AppError(UPLOAD_NOT_FOUND, 400);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = uploadIds.map((id) => byId.get(id)!);

  const stats = await Promise.all(ordered.map((row) => statObject(row.storageKey)));
  return ordered.map((row, index) => {
    const stat = stats[index];
    if (!stat) throw new AppError(FILE_NOT_UPLOADED, 400);
    assertAttachmentPolicy(stat);
    return { id: row.id, storageKey: row.storageKey, fileName: row.fileName, mimeType: stat.mimeType, size: stat.size };
  });
}

/**
 * Deletes the claimed upload rows inside the attaching transaction. A concurrent claim of the same
 * upload deletes fewer rows here and rolls this transaction back with a 400.
 */
export async function consumeUploads(
  tx: PrismaTransactionClient,
  userId: string,
  uploads: readonly VerifiedUpload[],
): Promise<void> {
  if (uploads.length === 0) return;
  const { count } = await tx.attachmentUpload.deleteMany({ where: { id: { in: uploads.map((u) => u.id) }, userId } });
  if (count !== uploads.length) throw new AppError(UPLOAD_NOT_FOUND, 400);
}

/**
 * The `create` rows of a message's or submission's attachments. `createdAt` steps by 1 ms so that
 * reading them by `createdAt` keeps the `uploadIds` order.
 */
export function attachmentRows(uploads: readonly VerifiedUpload[], now: Date) {
  return uploads.map((u, index) => ({
    storageKey: u.storageKey,
    fileName: u.fileName,
    mimeType: u.mimeType,
    size: u.size,
    createdAt: new Date(now.getTime() + index),
  }));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The select of an attachment row: the public keys plus where the file is. */
export const attachmentSelect = {
  id: true,
  storageKey: true,
  url: true,
  fileName: true,
  mimeType: true,
  size: true,
  createdAt: true,
} as const;

interface StoredAttachment {
  id: string;
  storageKey: string | null;
  url: string | null;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: Date;
}

function isStoredAttachment(value: object): value is StoredAttachment {
  return 'storageKey' in value && 'fileName' in value && 'url' in value;
}

function collect(value: unknown, found: StoredAttachment[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, found);
  } else if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    if (isStoredAttachment(value)) {
      found.push(value);
      return;
    }
    for (const child of Object.values(value)) collect(child, found);
  }
}

/**
 * Rewrites, in place, every attachment row (selected with {@link attachmentSelect}) inside a
 * response payload to the public shape `{ id, url, fileName, mimeType, size, createdAt }`, signing
 * all private files in one storage call. A legacy row keeps its public URL. `url` is `null` when
 * signing failed — the read still succeeds, and the download route can be retried.
 */
export async function presignAttachments<T>(payload: T): Promise<T> {
  const found: StoredAttachment[] = [];
  collect(payload, found);
  const keyed = found.filter((a) => a.storageKey !== null);
  const urls = await signDownloadUrls(keyed.map((a) => a.storageKey!), ATTACHMENT_URL_TTL_SECONDS);
  const signed = new Map(keyed.map((a, index) => [a, urls[index]]));

  for (const attachment of found) {
    const url = attachment.storageKey !== null ? signed.get(attachment) ?? null : attachment.url;
    const target = attachment as unknown as Record<string, unknown>;
    delete target.storageKey;
    target.url = url;
  }
  return payload;
}

/** The download route's answer: a URL that saves the file under its original name. */
export async function downloadUrlFor(attachment: Pick<StoredAttachment, 'storageKey' | 'url' | 'fileName'>, now: Date) {
  if (attachment.storageKey === null) {
    return { url: attachment.url ?? '', expiresAt: null };
  }
  const url = await signDownloadUrl(attachment.storageKey, attachment.fileName, DOWNLOAD_URL_TTL_SECONDS);
  return { url, expiresAt: new Date(now.getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000) };
}

// ---------------------------------------------------------------------------
// Legacy rows
// ---------------------------------------------------------------------------

const LEGACY_URL = new RegExp(`/storage/v1/object/public/${LEGACY_PUBLIC_BUCKET}/(.+)$`);

/** The key of a legacy public URL in the public bucket, or `null` for any other URL. */
export function legacyKeyOf(url: string): string | null {
  const match = LEGACY_URL.exec(url.split('?')[0]);
  return match ? decodeURIComponent(match[1]) : null;
}

export interface LegacyMigrationResult {
  /** Rows whose file is in the public bucket. */
  found: number;
  /** Rows moved to the private bucket (always 0 without `apply`). */
  migrated: number;
  /** Rows with some other URL (seed placeholders, a foreign host): left as they are. */
  skipped: number;
  failed: { id: string; error: string }[];
}

/**
 * Moves message and submission attachments that still point at the public bucket into the private
 * one: copy the object to the same key, then set `storageKey` and clear `url` (conditionally, so a
 * rerun is a no-op). Without `apply` it only counts. The public copies are left for an operator to
 * delete once the run is verified (docs/DEPLOYMENT.md). Run by `scripts/migrate-legacy-attachments.ts`.
 */
export async function migrateLegacyAttachments({ apply }: { apply: boolean }): Promise<LegacyMigrationResult> {
  const result: LegacyMigrationResult = { found: 0, migrated: 0, skipped: 0, failed: [] };
  const legacy = { storageKey: null, url: { not: null } } as const;
  const tables = [
    {
      rows: await prisma.messageAttachment.findMany({ where: legacy, select: { id: true, url: true } }),
      update: (id: string, key: string) =>
        prisma.messageAttachment.updateMany({ where: { id, storageKey: null }, data: { storageKey: key, url: null } }),
    },
    {
      rows: await prisma.milestoneAttachment.findMany({ where: legacy, select: { id: true, url: true } }),
      update: (id: string, key: string) =>
        prisma.milestoneAttachment.updateMany({ where: { id, storageKey: null }, data: { storageKey: key, url: null } }),
    },
  ];

  for (const { rows, update } of tables) {
    for (const row of rows) {
      const key = row.url ? legacyKeyOf(row.url) : null;
      if (!key) {
        result.skipped += 1;
        continue;
      }
      result.found += 1;
      if (!apply) continue;
      try {
        await copyFromLegacyBucket(key);
        await update(row.id, key);
        result.migrated += 1;
      } catch (err) {
        result.failed.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return result;
}
