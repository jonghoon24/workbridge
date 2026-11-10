import { expect } from 'vitest';

import { authed } from './api';
import type { Principal } from './api';
import { keyOfUploadUrl } from './storageFake';
import type { createStorageFake } from './storageFake';

/** The private attachment bucket under test (`SUPABASE_ATTACHMENT_BUCKET` is unset → its default). */
export const ATTACHMENT_BUCKET = 'workbridge-attachments';

export interface FileSpec {
  fileName: string;
  mimeType: string;
  size: number;
}

export const pdf = (fileName = 'report.pdf', size = 10): FileSpec => ({ fileName, mimeType: 'application/pdf', size });
export const png = (fileName = 'shot.png', size = 10): FileSpec => ({ fileName, mimeType: 'image/png', size });

/**
 * The browser's whole upload: ask `<resource>/uploads` for URLs, then `PUT` each file (into the
 * fake storage). Returns the upload ids, to send as `uploadIds`, and the storage keys.
 */
export async function uploadFiles(
  storage: ReturnType<typeof createStorageFake>,
  user: Principal,
  resource: string,
  files: readonly FileSpec[],
): Promise<{ ids: string[]; keys: string[] }> {
  const res = await authed(user).post(`${resource}/uploads`).send({ files });
  expect(res.status).toBe(201);
  const keys: string[] = [];
  res.body.uploads.forEach((upload: { uploadUrl: string }, index: number) => {
    const key = keyOfUploadUrl(upload.uploadUrl, ATTACHMENT_BUCKET);
    storage.put(ATTACHMENT_BUCKET, key, { size: files[index].size, contentType: files[index].mimeType });
    keys.push(key);
  });
  return { ids: res.body.uploads.map((u: { id: string }) => u.id), keys };
}
