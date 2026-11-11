import { vi } from 'vitest';

/**
 * An in-memory Supabase Storage for tests (no test may reach Supabase). Hand the shared instance
 * to `vi.mock('@supabase/supabase-js', …)` at the top of the test file — the factory imports this
 * module, so the test's own `import { storage }` gets the same instance:
 *
 * ```ts
 * vi.mock('@supabase/supabase-js', async () => {
 *   const { storage } = await import('./helpers/storageFake.js');
 *   return { createClient: () => storage.client };
 * });
 * import { storage } from './helpers/storageFake';
 * ```
 *
 * Every bucket method is a `vi.fn` over the in-memory behavior, so a test can make one call fail
 * with `mockResolvedValueOnce`. `put()` stands in for the browser's `PUT` to a signed upload URL.
 * Call `reset()` in `beforeEach`.
 */

export const STORAGE_BASE = 'https://test.supabase.co/storage/v1';

interface StoredObject {
  size: number;
  contentType: string;
}

const notFound = () => ({ data: null, error: Object.assign(new Error('Object not found'), { status: 400, statusCode: '404' }) });

export function createStorageFake() {
  const objects = new Map<string, StoredObject>();
  const at = (bucket: string, key: string) => `${bucket}/${key}`;

  function methodsFor(bucket: string) {
    return {
      upload: vi.fn(async (path: string, body: Buffer, options?: { contentType?: string }) => {
        objects.set(at(bucket, path), { size: body.length, contentType: options?.contentType ?? 'application/octet-stream' });
        return { data: { path }, error: null };
      }),
      getPublicUrl: vi.fn((path: string) => ({ data: { publicUrl: `${STORAGE_BASE}/object/public/${bucket}/${path}` } })),
      createSignedUploadUrl: vi.fn(async (path: string) => ({
        data: { signedUrl: `${STORAGE_BASE}/object/upload/sign/${bucket}/${path}?token=upload-token`, token: 'upload-token', path },
        error: null,
      })),
      info: vi.fn(async (path: string) => {
        const object = objects.get(at(bucket, path));
        if (!object) return notFound();
        return { data: { name: path, size: object.size, contentType: object.contentType, metadata: {} }, error: null };
      }),
      createSignedUrls: vi.fn(async (paths: string[], expiresIn: number) => ({
        data: paths.map((path) => ({
          error: null,
          path,
          signedUrl: `${STORAGE_BASE}/object/sign/${bucket}/${path}?token=read-token&expiresIn=${expiresIn}`,
        })),
        error: null,
      })),
      createSignedUrl: vi.fn(async (path: string, expiresIn: number, options?: { download?: string | boolean }) => ({
        data: {
          signedUrl: `${STORAGE_BASE}/object/sign/${bucket}/${path}?token=download-token&expiresIn=${expiresIn}`
            + (typeof options?.download === 'string' ? `&download=${encodeURIComponent(options.download)}` : ''),
        },
        error: null,
      })),
      copy: vi.fn(async (fromPath: string, toPath: string, options?: { destinationBucket?: string }) => {
        const object = objects.get(at(bucket, fromPath));
        if (!object) return notFound();
        objects.set(at(options?.destinationBucket ?? bucket, toPath), { ...object });
        return { data: { path: toPath }, error: null };
      }),
      /** The files directly in `folder` whose names contain `search`, paged like Supabase. */
      list: vi.fn(async (folder: string, options?: { search?: string; limit?: number; offset?: number }) => {
        const prefix = `${bucket}/${folder}/`;
        const names = [...objects.keys()]
          .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
          .map((key) => key.slice(prefix.length))
          .filter((name) => !options?.search || name.includes(options.search))
          .sort();
        const offset = options?.offset ?? 0;
        return { data: names.slice(offset, offset + (options?.limit ?? 100)).map((name) => ({ name })), error: null };
      }),
      remove: vi.fn(async (paths: string[]) => {
        for (const path of paths) objects.delete(at(bucket, path));
        return { data: paths.map((name) => ({ name })), error: null };
      }),
    };
  }

  const buckets = new Map<string, ReturnType<typeof methodsFor>>();
  function bucket(name: string) {
    let methods = buckets.get(name);
    if (!methods) {
      methods = methodsFor(name);
      buckets.set(name, methods);
    }
    return methods;
  }

  return {
    client: { storage: { from: (name: string) => bucket(name) } },
    bucket,
    /** The browser's `PUT` to a signed upload URL. */
    put(bucketName: string, key: string, object: StoredObject) {
      objects.set(at(bucketName, key), object);
    },
    has(bucketName: string, key: string) {
      return objects.has(at(bucketName, key));
    },
    reset() {
      objects.clear();
      for (const methods of buckets.values()) {
        for (const fn of Object.values(methods)) fn.mockClear();
      }
      buckets.clear();
    },
  };
}

/** The object key inside a signed upload URL. */
export function keyOfUploadUrl(uploadUrl: string, bucket: string): string {
  const marker = `/object/upload/sign/${bucket}/`;
  const start = uploadUrl.indexOf(marker);
  if (start < 0) throw new Error(`not an upload URL of ${bucket}: ${uploadUrl}`);
  return uploadUrl.slice(start + marker.length).split('?')[0];
}

/** The instance every test file shares (each file runs in its own module graph). */
export const storage = createStorageFake();
