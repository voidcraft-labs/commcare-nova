import { requireAdminAccess } from '@/lib/auth-utils'

/**
 * Admin layout gate — protects the entire /admin/* route tree.
 *
 * Server-side auth check via Better Auth's getSession() with Next.js headers().
 * Non-admins are redirected before any HTML is sent to the browser. Child pages
 * can assume admin access without self-gating.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdminAccess()
  return children
}
