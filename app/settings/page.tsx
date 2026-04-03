import { PageHeader } from '@/components/ui/PageHeader'
import { getSession } from '@/lib/auth-utils'
import { ApiKeyEditor } from './api-key-editor'

/**
 * Settings page — server-side auth check with shared header.
 *
 * Resolves authentication status server-side. The proxy layer handles
 * unauthenticated redirects; this RSC provides the isAuthenticated flag
 * for UI branching (label text) and isAdmin for the header nav.
 */
export default async function SettingsPage() {
  const session = await getSession()
  const isAuthenticated = !!session
  const isAdmin = session?.user?.isAdmin === true

  return (
    <div className="min-h-screen bg-nova-void">
      <PageHeader
        isAdmin={isAdmin}
        back={{ href: isAuthenticated ? '/builds' : '/', label: 'Go back' }}
        breadcrumb={[{ label: 'Settings' }]}
      />
      <ApiKeyEditor isAuthenticated={isAuthenticated} />
    </div>
  )
}
