import { beforeEach, describe, expect, it, vi } from 'vitest';

const { storageUpload } = vi.hoisted(() => ({ storageUpload: vi.fn() }));

// No test may reach Supabase. The client is built when `middlewares/upload.ts` is imported.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        upload: storageUpload,
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://test.supabase.co/storage/v1/object/public/workbridge/${path}` },
        }),
      }),
    },
  }),
}));

import express from 'express';
import request from 'supertest';

import { getRequestContext } from '../src/lib/requestContext';
import { buildStorageKey, decodeOriginalName, extensionFor } from '../src/lib/storageKey';
import { ATTACHMENT_MAX_BYTES, assertAttachmentPolicy, isAllowedAttachmentType } from '../src/lib/attachmentStorage';
import { imageUpload, storeUploadedFile } from '../src/middlewares/attachmentUpload';
import { errorHandler } from '../src/middlewares/errorHandler';
import { bindRequestContext, requestId } from '../src/middlewares/requestId';
import { uploadToSupabase } from '../src/middlewares/upload';

/**
 * The multipart image upload (portfolio) and the attachment policy. Every rejection is a 413 or a
 * 400, never a 500. Message and submission attachments are uploaded straight to storage: their
 * routes are in attachments.test.ts.
 */

const MB = 1024 * 1024;

const app = express();
app.use(requestId);
app.use(express.json());
app.use(bindRequestContext);
app.post('/stored-image', imageUpload, async (req, res, next) => {
  try {
    const stored = req.file ? await storeUploadedFile(req.file, 'tests/folder-1') : null;
    res.json({ stored, body: req.body, requestId: getRequestContext()?.requestId });
  } catch (err) {
    next(err);
  }
});
app.post('/image', imageUpload, (req, res) => res.json({ name: req.file?.originalname ?? null }));
app.use(errorHandler);

const pdf = (name = 'report.pdf', size = 10) => [Buffer.alloc(size, 1), { filename: name, contentType: 'application/pdf' }] as const;
const png = (name = 'shot.png', size = 10) => [Buffer.alloc(size, 1), { filename: name, contentType: 'image/png' }] as const;

beforeEach(() => {
  storageUpload.mockReset();
  storageUpload.mockImplementation(async (path: string) => ({ data: { path }, error: null }));
});

describe('storeUploadedFile', () => {
  it('stores the file at <folder>/<uuid>.<ext> in the public bucket and returns its metadata', async () => {
    const res = await request(app).post('/stored-image').field('title', '작업물').attach('image', ...png());

    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ title: '작업물' });
    const { stored } = res.body;
    expect(stored.key).toMatch(/^tests\/folder-1\/[0-9a-f-]{36}\.png$/);
    expect(stored).toMatchObject({ fileName: 'shot.png', mimeType: 'image/png', size: 10 });
    expect(stored.url).toBe(`https://test.supabase.co/storage/v1/object/public/workbridge/${stored.key}`);
    expect(storageUpload.mock.calls.map(([path]) => path)).toEqual([stored.key]);
  });

  it('restores a Korean file name for display and keeps it out of the key', async () => {
    const res = await request(app).post('/stored-image').attach('image', ...png('작업 화면.png'));

    expect(res.status).toBe(200);
    expect(res.body.stored.fileName).toBe('작업 화면.png');
    expect(res.body.stored.key).toMatch(/^[\x20-\x7e]+$/);
    expect(res.body.stored.key).toMatch(/\.png$/);
  });

  it('keeps the request context across multer', async () => {
    const res = await request(app).post('/stored-image').set('X-Request-Id', 'upload-trace').attach('image', ...png());

    expect(res.body.requestId).toBe('upload-trace');
  });

  it('accepts a request with no file', async () => {
    const res = await request(app).post('/stored-image').field('title', 'text only');

    expect(res.status).toBe(200);
    expect(res.body.stored).toBeNull();
  });

  it('rejects an unexpected field name with 400', async () => {
    const res = await request(app).post('/image').attach('file', ...png());

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Unexpected file field: file' } });
  });

  it('rejects a malformed multipart body with 400', async () => {
    const res = await request(app)
      .post('/image')
      .set('Content-Type', 'multipart/form-data; boundary=----nope')
      .send('------nope\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Malformed multipart body' } });
  });

  it('turns a storage failure into a 502, never a raw 500', async () => {
    storageUpload.mockResolvedValue({ data: null, error: { message: 'Bucket not found', statusCode: '404' } });

    const res = await request(app).post('/stored-image').attach('image', ...png());

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: { message: 'File upload failed' } });
  });
});

describe('attachment policy', () => {
  it.each([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/x-hwp',
    'application/zip',
    'text/plain',
    'image/jpeg',
    'application/pdf',
  ])('accepts %s', (mimeType) => {
    expect(isAllowedAttachmentType(mimeType)).toBe(true);
    expect(() => assertAttachmentPolicy({ mimeType, size: 1 })).not.toThrow();
  });

  it('accepts a file of exactly 10 MB and rejects one byte more with 413', () => {
    expect(ATTACHMENT_MAX_BYTES).toBe(10 * MB);
    expect(() => assertAttachmentPolicy({ mimeType: 'application/pdf', size: 10 * MB })).not.toThrow();
    expect(() => assertAttachmentPolicy({ mimeType: 'application/pdf', size: 10 * MB + 1 }))
      .toThrow(expect.objectContaining({ message: 'File too large (max 10MB)', statusCode: 413 }));
  });

  it('rejects a disallowed type with 400, before the size', () => {
    expect(() => assertAttachmentPolicy({ mimeType: 'application/x-msdownload', size: 11 * MB }))
      .toThrow(expect.objectContaining({ message: 'Unsupported file type: application/x-msdownload', statusCode: 400 }));
    expect(isAllowedAttachmentType('application/octet-stream')).toBe(false);
  });
});

describe('imageUpload', () => {
  it('accepts one image on the `image` field', async () => {
    const res = await request(app).post('/image').attach('image', ...png());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'shot.png' });
  });

  it('rejects a non-image with 400', async () => {
    const res = await request(app).post('/image').attach('image', ...pdf());

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'Unsupported file type: application/pdf' } });
  });

  it('rejects an image over 5 MB with 413', async () => {
    const res = await request(app).post('/image').attach('image', ...png('big.png', 5 * MB + 1));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: { message: 'File too large (max 5MB)' } });
  });

  it('rejects a second image with 400', async () => {
    const res = await request(app).post('/image').attach('image', ...png('a.png')).attach('image', ...png('b.png'));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Too many files (max 1)');
  });
});

describe('storage keys and names', () => {
  it('decodeOriginalName undoes multer\'s latin1 decoding and leaves other names alone', () => {
    const mangled = Buffer.from('보고서.pdf', 'utf8').toString('latin1');

    expect(decodeOriginalName(mangled)).toBe('보고서.pdf');
    expect(decodeOriginalName('보고서.pdf')).toBe('보고서.pdf');
    expect(decodeOriginalName('plain.txt')).toBe('plain.txt');
    // Genuinely latin1 (not UTF-8 bytes) — decoding would produce U+FFFD, so it is kept.
    expect(decodeOriginalName('café.txt')).toBe('café.txt');
  });

  it('takes the extension from the name, else from the MIME type, else bin', () => {
    expect(extensionFor('application/pdf', 'Report.PDF')).toBe('pdf');
    expect(extensionFor('image/png', 'no-extension')).toBe('png');
    expect(extensionFor('application/x-unknown', 'no-extension')).toBe('bin');
    expect(extensionFor('image/jpeg', 'weird.한글')).toBe('jpg');
  });

  it('refuses an unsafe folder', () => {
    expect(() => buildStorageKey('../escape', 'image/png', 'a.png')).toThrow('Unsafe storage folder');
    expect(() => buildStorageKey('a//b', 'image/png', 'a.png')).toThrow('Unsafe storage folder');
    expect(buildStorageKey('portfolio', 'image/png', 'a.png')).toMatch(/^portfolio\/[0-9a-f-]{36}\.png$/);
  });

  it('uploadToSupabase still defaults to the profiles folder for the profile-image caller', async () => {
    await uploadToSupabase(Buffer.from('x'), 'image/png', 'user-1-abc.png');

    expect(storageUpload).toHaveBeenCalledWith('profiles/user-1-abc.png', expect.any(Buffer), {
      contentType: 'image/png',
      upsert: true,
    });
  });
});
