/**
 * Next.js 16 proxy — CSP + optimistic auth redirect.
 *
 * Runs on every page route (not API/static). Two responsibilities:
 *
 * 1. **Nonce-based CSP** — per-request nonce in `Content-Security-Policy`
 *    response header and `x-nonce` request header.
 *
 * 2. **Optimistic auth redirect** — `getSessionCookie()` checks cookie
 *    presence (fast, no validation). Unauthenticated users on protected
 *    routes are redirected to `/`. Only redirects TO `/`, never FROM it —
 *    the landing page's server component handles the reverse direction
 *    with full session validation, so stale cookies can't cause a loop.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { getSessionCookie } from 'better-auth/cookies'

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const isDev = process.env.NODE_ENV === 'development'

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: *.googleusercontent.com",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(!isDev ? ['upgrade-insecure-requests'] : []),
  ].join('; ')

  // Optimistic auth — cookie presence only, server does full validation
  const { pathname } = request.nextUrl
  if (pathname !== '/' && !getSessionCookie(request)) {
    return NextResponse.redirect(new URL('/', request.url))
  }

  // Pass nonce to RSC via request header; set CSP on the response
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', csp)

  return response
}

export const config = {
  matcher: [
    /* All page routes — excludes API, static files, image optimization, favicon */
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
}
