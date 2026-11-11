#!/usr/bin/env node
/**
 * A local stand-in for Supabase Storage, for running the app without a Supabase project
 * (`run-workbridge` skill). In memory, no auth: never expose it. Implements the calls the server
 * and the browser make: uploads to the public bucket (profile/portfolio images) and their public
 * URLs, signed upload URLs and the browser's `PUT`, object info, signed download URLs and the
 * downloads themselves, copy, list and remove. CORS is open so the browser can `PUT` from :3000.
 *
 *   node scripts/storage-stub.mjs            # http://localhost:54321
 *   STORAGE_STUB_PORT=54399 node scripts/storage-stub.mjs
 *
 * Point the server at it with `SUPABASE_URL=http://localhost:54321` (any `SUPABASE_SECRET_KEY`).
 */
import { createServer } from 'node:http';

const port = Number(process.env.STORAGE_STUB_PORT || 54321);
const PREFIX = '/storage/v1';
/** `<bucket>/<key>` → { body, contentType, createdAt } */
const objects = new Map();

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    ...(typeof body === 'object' && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
    ...headers,
  });
  res.end(payload);
}

const notFound = (res) => send(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A multipart upload (supabase-js `upload()` with a Buffer sends the raw body; a Blob sends form data). */
function fileFrom(body, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType || '')?.[1];
  if (!boundary) return { body, contentType: contentType || 'application/octet-stream' };
  const text = body.toString('latin1');
  for (const part of text.split(`--${boundary}`)) {
    const [head, ...rest] = part.split('\r\n\r\n');
    if (!/filename=/.test(head)) continue;
    const type = /Content-Type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? 'application/octet-stream';
    const content = rest.join('\r\n\r\n').replace(/\r\n$/, '');
    return { body: Buffer.from(content, 'latin1'), contentType: type };
  }
  return { body, contentType: contentType || 'application/octet-stream' };
}

function serve(res, objectPath, download) {
  const object = objects.get(objectPath);
  if (!object) return notFound(res);
  const headers = { 'Content-Type': object.contentType, 'Content-Length': object.body.length };
  if (download !== null) {
    const name = download || objectPath.split('/').pop();
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  return send(res, 200, object.body, headers);
}

createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    const url = new URL(req.url, `http://localhost:${port}`);
    if (!url.pathname.startsWith(PREFIX)) return send(res, 404, { message: 'not a storage path' });
    const path = decodeURIComponent(url.pathname.slice(PREFIX.length));
    const body = await readBody(req);
    const json = () => (body.length ? JSON.parse(body.toString('utf8')) : {});
    let m;

    if (req.method === 'POST' && (m = /^\/object\/upload\/sign\/(.+)$/.exec(path))) {
      return send(res, 200, { url: `/object/upload/sign/${m[1]}?token=stub` });
    }
    if (req.method === 'PUT' && (m = /^\/object\/upload\/sign\/(.+)$/.exec(path))) {
      if (objects.has(m[1]) && req.headers['x-upsert'] !== 'true') {
        return send(res, 400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
      }
      const file = fileFrom(body, req.headers['content-type']);
      objects.set(m[1], { ...file, createdAt: new Date().toISOString() });
      return send(res, 200, { Key: m[1] });
    }
    if (req.method === 'GET' && (m = /^\/object\/info\/(.+)$/.exec(path))) {
      const object = objects.get(m[1]);
      if (!object) return notFound(res);
      return send(res, 200, {
        id: m[1],
        name: m[1].split('/').slice(1).join('/'),
        size: object.body.length,
        content_type: object.contentType,
        created_at: object.createdAt,
        updated_at: object.createdAt,
        metadata: { size: object.body.length, mimetype: object.contentType },
      });
    }
    if (req.method === 'POST' && (m = /^\/object\/sign\/([^/]+)$/.exec(path))) {
      const { paths = [] } = json();
      return send(res, 200, paths.map((p) => ({
        path: p,
        signedURL: `/object/sign/${m[1]}/${p}?token=stub`,
        error: objects.has(`${m[1]}/${p}`) ? null : 'Object not found',
      })));
    }
    if (req.method === 'POST' && (m = /^\/object\/sign\/(.+)$/.exec(path))) {
      if (!objects.has(m[1])) return notFound(res);
      return send(res, 200, { signedURL: `/object/sign/${m[1]}?token=stub` });
    }
    if (req.method === 'GET' && (m = /^\/object\/(?:sign|public)\/(.+)$/.exec(path))) {
      return serve(res, m[1], url.searchParams.get('download'));
    }
    if (req.method === 'POST' && path === '/object/copy') {
      const { bucketId, sourceKey, destinationKey, destinationBucket } = json();
      const object = objects.get(`${bucketId}/${sourceKey}`);
      if (!object) return notFound(res);
      objects.set(`${destinationBucket || bucketId}/${destinationKey}`, { ...object });
      return send(res, 200, { Key: `${destinationBucket || bucketId}/${destinationKey}` });
    }
    if (req.method === 'POST' && (m = /^\/object\/list\/([^/]+)$/.exec(path))) {
      // The files directly in `prefix` whose names contain `search` (withdrawal's profile-image cleanup).
      const { prefix = '', search = '', limit = 100, offset = 0 } = json();
      const folder = `${m[1]}/${prefix ? `${prefix.replace(/\/$/, '')}/` : ''}`;
      const names = [...objects.keys()]
        .filter((key) => key.startsWith(folder) && !key.slice(folder.length).includes('/'))
        .map((key) => key.slice(folder.length))
        .filter((name) => name.includes(search))
        .sort();
      return send(res, 200, names.slice(offset, offset + limit).map((name) => ({ name, id: `${folder}${name}`, metadata: {} })));
    }
    if (req.method === 'DELETE' && (m = /^\/object\/([^/]+)$/.exec(path))) {
      const { prefixes = [] } = json();
      for (const key of prefixes) objects.delete(`${m[1]}/${key}`);
      return send(res, 200, prefixes.map((name) => ({ name })));
    }
    if ((req.method === 'POST' || req.method === 'PUT') && (m = /^\/object\/(.+)$/.exec(path))) {
      const file = fileFrom(body, req.headers['content-type']);
      objects.set(m[1], { ...file, createdAt: new Date().toISOString() });
      return send(res, 200, { Key: m[1] });
    }
    return send(res, 404, { message: `unsupported: ${req.method} ${path}` });
  } catch (err) {
    return send(res, 500, { message: String(err) });
  }
}).listen(port, () => {
  console.log(`storage stub on http://localhost:${port}${PREFIX}`);
});
