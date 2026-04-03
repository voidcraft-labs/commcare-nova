/**
 * Next.js 16 proxy — CSP + optimistic auth redirect.
 *
 * Runs on every page route (not API/static). Two responsibilities:
 *
 * 1. **Nonce-based CSP** — generates a per-request nonce, sets it in the
 *    `Content-Security-Policy` response header and `x-nonce` request header.
 *    Next.js reads the CSP header automatically and applies the nonce to all
 *    framework scripts, styles, and `<Script>` components.
 *
 * 2. **Optimistic auth redirect** — checks for a session cookie on protected
 *    routes (`/build/*`, `/builds`, `/admin/*`) and redirects to `/` if absent.
 *    UX optimization only — Server Components do the real auth check.
 *
 * Does NOT match / (handles its own redirect logic server-side).
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSessionCookie } from 'better-auth/cookies'

/** Routes that require an authenticated session cookie for the optimistic redirect. */
const AUTH_ROUTES = ['/build', '/builds', '/admin']

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const isDev = process.env.NODE_ENV === 'development'

  /*
   * Nonce-based CSP:
   * - script-src: nonce + strict-dynamic lets Next.js load chunks dynamically.
   *   Dev adds unsafe-eval for hot reload / React Refresh.
   * - style-src: unsafe-inline required — Motion injects runtime styles that
   *   can't carry a nonce. Inline style XSS is far harder to exploit than
   *   script injection, so this is an accepted trade-off.
   * - img-src: Google profile avatars live on *.googleusercontent.com.
   * - frame-ancestors 'none': replaces X-Frame-Options DENY.
   * - upgrade-insecure-requests: production-only (dev may run on HTTP).
   */
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

  // Optimistic auth redirect on protected routes
  const { pathname } = request.nextUrl
  if (AUTH_ROUTES.some(r => pathname === r || pathname.startsWith(r + '/'))) {
    if (!getSessionCookie(request)) {
      return NextResponse.redirect(new URL('/', request.url))
    }
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
