import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth-utils'
import { Landing } from './landing'

/**
 * Landing page — server-side redirect for authenticated users.
 *
 * Authenticated users are redirected to /builds before the page renders.
 * Unauthenticated users see the sign-in UI (client component handles
 * BYOK redirect since that requires localStorage).
 */
export default async function LandingPage() {
  const session = await getSession()
  if (session) redirect('/builds')

  return <Landing />
}
