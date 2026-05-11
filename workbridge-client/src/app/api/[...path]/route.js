import { NextResponse } from 'next/server';
import { getApiUrl } from '@/lib/server/authProxy';

function buildBackendUrl(request, path) {
  const backendPath = path.map(encodeURIComponent).join('/');
  return `${getApiUrl()}/api/${backendPath}${request.nextUrl.search}`;
}

async function proxyApiRequest(request, { params }) {
  const headers = new Headers();
  const contentType = request.headers.get('content-type');
  const authorization = request.headers.get('authorization');

  if (contentType) headers.set('content-type', contentType);
  if (authorization) headers.set('authorization', authorization);

  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
  };

  if (!['GET', 'HEAD'].includes(request.method)) {
    const body = await request.arrayBuffer();
    if (body.byteLength > 0) init.body = body;
  }

  const backendResponse = await fetch(buildBackendUrl(request, params.path), init);
  const body = await backendResponse.text();

  return new NextResponse(body, {
    status: backendResponse.status,
    headers: {
      'content-type': backendResponse.headers.get('content-type') || 'application/json',
    },
  });
}

export async function GET(request, context) {
  return proxyApiRequest(request, context);
}

export async function POST(request, context) {
  return proxyApiRequest(request, context);
}

export async function PATCH(request, context) {
  return proxyApiRequest(request, context);
}

export async function DELETE(request, context) {
  return proxyApiRequest(request, context);
}
