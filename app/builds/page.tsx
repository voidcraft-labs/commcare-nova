import Link from 'next/link'
import { Icon } from '@iconify/react/offline'
import ciPlus from '@iconify-icons/ci/plus'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireAuth } from '@/lib/auth-utils'
import { listProjects } from '@/lib/db/projects'
import { ReplayableProjectList } from '@/components/ui/ReplayableProjectList'

/**
 * Builds page — server-rendered project list.
 *
 * Auth and data fetch happen server-side before any HTML is sent. The page
 * structure (header, heading, empty state) renders on the server. Only the
 * interactive leaves (NewBuildButton, ProjectList with replay) are client components.
 */
export default async function BuildsPage() {
  const session = await requireAuth()
  const projects = await listProjects(session.user.email)
  const isAdmin = session.user.isAdmin === true

  return (
    <div className="min-h-screen bg-nova-void">
      <PageHeader isAdmin={isAdmin} />

      {/* ── Content ─────────────────────────────────────────── */}
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

        <ReplayableProjectList
          projects={projects}
          logsUrlPrefix="/api/projects"
          linkToProjects
          showReplay={isAdmin}
          emptyState={
            <div className="text-center py-20">
              <p className="text-nova-text-secondary mb-4">No projects yet</p>
              <Link
                href="/build/new"
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm leading-6 font-medium rounded-lg bg-nova-violet text-white border border-transparent hover:bg-nova-violet-bright shadow-[var(--nova-glow-violet)] transition-all duration-200"
              >
                Create your first app
              </Link>
            </div>
          }
        />
      </main>
    </div>
  )
}
