import Link from 'next/link'
import { Icon } from '@iconify/react/offline'
import ciChevronLeft from '@iconify-icons/ci/chevron-left'
import { getSession } from '@/lib/auth-utils'
import { ApiKeyEditor } from './api-key-editor'

/**
 * Settings page — in-page back link + API key editor.
 *
 * The global header is rendered by the root layout. Back navigation lives
 * in the page content — authenticated users go to /builds, BYOK users go
 * to the landing page.
 */
export default async function SettingsPage() {
  const session = await getSession()
  const isAuthenticated = !!session

  return (
    <main className="max-w-md mx-auto px-6 py-10 space-y-6">
      {/* ── In-page back navigation ───────────────────────── */}
      <nav>
        <Link
          href={isAuthenticated ? '/builds' : '/'}
          className="inline-flex items-center gap-0.5 text-sm text-nova-text-muted hover:text-nova-text transition-colors"
        >
          <Icon icon={ciChevronLeft} width="16" height="16" />
          {isAuthenticated ? 'Projects' : 'Home'}
        </Link>
      </nav>

      <h1 className="text-2xl font-display font-semibold">Settings</h1>

      <ApiKeyEditor isAuthenticated={isAuthenticated} />
    </main>
  )
}
