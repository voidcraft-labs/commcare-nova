import { Suspense } from 'react'
import Link from 'next/link'
import { Icon } from '@iconify/react/offline'
import ciPlus from '@iconify-icons/ci/plus'
import { requireAuth } from '@/lib/auth-utils'
import { ProjectList } from './project-list'
import { ProjectListSkeleton } from './loading'

/**
 * Builds page — streams the page shell immediately, project list via Suspense.
 *
 * Auth is enforced by the builds layout. The global header is rendered by the
 * root layout. Title and "New Build" button render instantly. The project list
 * — which requires a Firestore query — streams in via a Suspense boundary.
 */
export default async function BuildsPage() {
  const session = await requireAuth()
  const isAdmin = session.session.isAdmin === true

  return (
    <main className="max-w-4xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-display font-semibold">Your Projects</h1>
        <Link
          href="/build/new"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-nova-violet text-white border border-transparent hover:bg-nova-violet-bright shadow-[var(--nova-glow-violet)] transition-all duration-200"
        >
          <Icon icon={ciPlus} width="14" height="14" />
          New Build
        </Link>
      </div>

      <Suspense fallback={<ProjectListSkeleton />}>
        <ProjectList email={session.user.email} isAdmin={isAdmin} />
      </Suspense>
    </main>
  )
}
