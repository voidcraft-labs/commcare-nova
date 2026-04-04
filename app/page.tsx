import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth-utils'
import { Landing } from './landing'

/**
 * Landing page — server-side redirect for authenticated users.
 *
 * Full session validation via `getSession()` — if the session exists in
 * Firestore, redirect to `/builds`. Stale/expired cookies correctly fall
 * through to the sign-in UI. The proxy handles the reverse direction
 * (no cookie on protected routes → `/`).
 */
export default async function LandingPage() {
  const session = await getSession()
  if (session) redirect('/builds')

  return <Landing />
}
