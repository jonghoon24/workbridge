import { randomUUID } from 'node:crypto';

/**
 * Storage object keys and display names for attachment and portfolio-image uploads
 * (`middlewares/attachmentUpload.ts`).
 *
 * Keys are always `<folder>/<uuid>.<ext>`, ASCII only: the original file name never goes into
 * a key, because Supabase Storage may reject non-ASCII keys and multer mangles them anyway.
 */

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'text/plain': 'txt',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/x-hwp': 'hwp',
};

const SAFE_FOLDER = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

/**
 * multer 1.4.5-lts builds Busboy without `defParamCharset`, so a UTF-8 file name arrives decoded
 * as latin1 (`보고서.pdf` → `ë³´ê³ ì\u0084\u009c.pdf`). Re-encode to recover it. A name that is
 * already beyond latin1, or that does not decode as valid UTF-8, is returned unchanged.
 */
export function decodeOriginalName(originalname: string): string {
  if ([...originalname].some((ch) => ch.charCodeAt(0) > 0xff)) return originalname;
  const decoded = Buffer.from(originalname, 'latin1').toString('utf8');
  return decoded.includes('�') ? originalname : decoded;
}

/** Lowercase extension from the file name if it looks sane, else from the MIME type, else `bin`. */
export function extensionFor(mimetype: string, originalname: string): string {
  const fromName = /\.([A-Za-z0-9]{1,10})$/.exec(decodeOriginalName(originalname));
  if (fromName) return fromName[1].toLowerCase();
  return MIME_EXTENSIONS[mimetype] ?? 'bin';
}

/** `<folder>/<uuid>.<ext>`. `folder` comes from code (`milestones/<id>`), never from the user. */
export function buildStorageKey(folder: string, mimetype: string, originalname: string): string {
  if (!SAFE_FOLDER.test(folder)) {
    throw new Error(`Unsafe storage folder: "${folder}"`);
  }
  return `${folder}/${randomUUID()}.${extensionFor(mimetype, originalname)}`;
}
