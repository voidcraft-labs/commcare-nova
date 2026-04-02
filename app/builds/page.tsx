'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import { Icon } from '@iconify/react/offline'
import ciSettings from '@iconify-icons/ci/settings'
import ciPlus from '@iconify-icons/ci/plus'
import Link from 'next/link'
import tablerLayoutDashboard from '@iconify-icons/tabler/layout-dashboard'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'
import { ProjectCard } from '@/components/ui/ProjectCard'
import { useAuth } from '@/hooks/useAuth'
import { useReplay } from '@/hooks/useReplay'
import type { ProjectSummary } from '@/lib/db/projects'

export default function BuildsPage() {
  const router = useRouter()
  const { isAuthenticated, isAdmin, isPending: authPending } = useAuth()
  const buildUrl = (id: string) => `/api/projects/${id}/logs`
  const { handleReplay, replayingId, replayError } = useReplay({ buildUrl })
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  /* Redirect BYOK / unauthenticated users — they have no saved projects. */
  useEffect(() => {
    if (authPending) return
    if (!isAuthenticated) router.replace('/build/new')
  }, [authPending, isAuthenticated, router])

  /* Fetch project list from Firestore. */
  useEffect(() => {
    if (!isAuthenticated) return
    fetch('/api/projects')
      .then(res => {
        if (!res.ok) throw new Error('Failed to load projects')
        return res.json() as Promise<{ projects: ProjectSummary[] }>
      })
      .then(data => {
        setProjects(data.projects ?? [])
        setLoading(false)
      })
      .catch(err => {
        console.error('[builds] fetch failed:', err)
        setFetchError('Failed to load your projects. Please try again.')
        setLoading(false)
      })
  }, [isAuthenticated])

  const error = fetchError || replayError

  if (authPending || !isAuthenticated) return null

  return (
    <div className="min-h-screen bg-nova-void">
      {/* ── Header ──────────────────────────────────────────── */}
      <header className="border-b border-nova-border px-6 py-4 flex items-center justify-between">
        <Link href="/">
          <Logo size="sm" />
        </Link>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <Link
              href="/admin"
              className="p-1.5 text-nova-text-muted hover:text-nova-text transition-colors rounded-lg hover:bg-nova-surface"
              title="Admin Dashboard"
            >
              <Icon icon={tablerLayoutDashboard} width="18" height="18" />
            </Link>
          )}
          <Link
            href="/settings"
            className="p-1.5 text-nova-text-muted hover:text-nova-text transition-colors rounded-lg hover:bg-nova-surface"
            title="Settings"
          >
            <Icon icon={ciSettings} width="18" height="18" />
          </Link>
          <Button onClick={() => router.push('/build/new')} size="sm">
            <Icon icon={ciPlus} width="14" height="14" />
            New Build
          </Button>
        </div>
      </header>

      {/* ── Content ─────────────────────────────────────────── */}
      <main className="max-w-4xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-display font-semibold mb-8">Your Projects</h1>

        {/* Error state */}
        {error && (
          <div className="text-center py-12" role="alert">
            <p className="text-nova-rose mb-4">{error}</p>
            <Button onClick={() => window.location.reload()} size="sm" variant="secondary">
              Retry
            </Button>
          </div>
        )}

        {/* Loading skeletons */}
        {loading && !error && (
          <div className="grid gap-3">
            {[0, 1, 2].map(i => (
              <div
                key={i}
                className="p-4 bg-nova-surface border border-nova-border rounded-lg animate-pulse"
              >
                <div className="flex items-center justify-between">
                  <div className="space-y-2">
                    <div className="h-5 w-48 bg-nova-border rounded" />
                    <div className="h-3 w-32 bg-nova-border/50 rounded" />
                  </div>
                  <div className="h-6 w-16 bg-nova-border rounded" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && projects.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-20"
          >
            <p className="text-nova-text-secondary mb-4">No projects yet</p>
            <Button onClick={() => router.push('/build/new')}>
              Create your first app
            </Button>
          </motion.div>
        )}

        {/* Project list */}
        {!loading && !error && projects.length > 0 && (
          <div className="grid gap-3">
            {projects.map((project, i) => (
              <ProjectCard
                key={project.id}
                project={project}
                index={i}
                href={project.status !== 'error' ? `/build/${project.id}` : undefined}
                onReplay={isAdmin ? handleReplay : undefined}
                replayingId={replayingId}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
