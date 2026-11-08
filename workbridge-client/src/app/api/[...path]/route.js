import { NextResponse } from 'next/server';
import { getApiUrl } from '@/lib/apiUrl';
import { buildForwardHeaders, buildResponseHeaders } from '@/lib/server/authProxy';

function buildBackendUrl(request, path) {
  const backendPath = path.map(encodeURIComponent).join('/');
  return `${getApiUrl()}/api/${backendPath}${request.nextUrl.search}`;
}

async function proxyApiRequest(request, { params }) {
  const init = {
    method: request.method,
    headers: buildForwardHeaders(request),
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
    headers: buildResponseHeaders(backendResponse),
  });
}

// Every method the backend uses must be exported here, or Next answers 405 before the request
// reaches the backend — and neither `npm run build` nor `lint` would notice.

export async function GET(request, context) {
  return proxyApiRequest(request, context);
}

export async function POST(request, context) {
  return proxyApiRequest(request, context);
}

export async function PUT(request, context) {
  return proxyApiRequest(request, context);
}

export async function PATCH(request, context) {
  return proxyApiRequest(request, context);
}

export async function DELETE(request, context) {
  return proxyApiRequest(request, context);
}
