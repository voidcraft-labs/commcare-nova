import { getSession } from '@/lib/auth-utils'
import { ApiKeyEditor } from './api-key-editor'

/**
 * Settings page — server-side auth check.
 *
 * Resolves authentication status server-side and passes it to the client
 * component. The proxy layer handles unauthenticated redirects; this RSC
 * provides the isAuthenticated flag for UI branching (label text).
 */
export default async function SettingsPage() {
  const session = await getSession()
  return <ApiKeyEditor isAuthenticated={!!session} />
}
