/**
 * Next.js 16 proxy — optimistic auth redirect layer.
 *
 * Checks for the existence of a session cookie before the page renders.
 * This is a UX optimization, not a security boundary — unauthenticated users
 * are redirected before downloading any protected page JS. Real auth validation
 * happens in Server Components via requireAuth() / requireAdminAccess().
 *
 * Does NOT match /build/* (supports BYOK unauthenticated users) or / (handles
 * its own redirect logic server-side).
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSessionCookie } from 'better-auth/cookies'

export function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request)
  if (!sessionCookie) {
    return NextResponse.redirect(new URL('/', request.url))
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/builds', '/admin/:path*', '/settings'],
}
