import { NextResponse } from 'next/server';

const protectedRoutes = ['/profile', '/my', '/projects/new', '/contracts', '/settlements'];
const authRoutes = ['/login', '/signup'];

export function middleware(request) {
  const { pathname } = request.nextUrl;
  const refreshToken = request.cookies.get('refreshToken');

  const isProtected = protectedRoutes.some((route) => pathname.startsWith(route));
  const isAuthRoute = authRoutes.includes(pathname);

  if (isProtected && !refreshToken) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('redirect', pathname);
    return NextResponse.redirect(url);
  }

  if (isAuthRoute && refreshToken) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
