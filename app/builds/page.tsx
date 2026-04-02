'use client'
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import { Icon } from '@iconify/react/offline'
import ciSettings from '@iconify-icons/ci/settings'
import ciPlus from '@iconify-icons/ci/plus'
import ciPlayCircle from '@iconify-icons/ci/play-circle-outline'
import Link from 'next/link'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/hooks/useAuth'
import type { ProjectSummary } from '@/lib/db/projects'
import type { StoredEvent } from '@/lib/db/types'
import { extractReplayStages, setReplayData } from '@/lib/services/logReplay'

/** Status badge colors and labels. */
const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  complete: { bg: 'bg-nova-emerald/15', text: 'text-emerald-400', label: 'Complete' },
  generating: { bg: 'bg-nova-violet/15', text: 'text-violet-400', label: 'Generating' },
  error: { bg: 'bg-nova-rose/15', text: 'text-rose-400', label: 'Error' },
}

/** Shape of the JSON response from GET /api/projects. */
interface ProjectsApiResponse {
  projects: Array<Omit<ProjectSummary, 'created_at' | 'updated_at'> & {
    created_at: string
    updated_at: string
  }>
}

/** Format a date as a relative string (e.g. "2 hours ago", "Yesterday"). */
function formatRelativeDate(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  const diffHours = Math.floor(diffMs / 3_600_000)
  const diffDays = Math.floor(diffMs / 86_400_000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 30) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

export default function BuildsPage() {
  const router = useRouter()
  const { isAuthenticated, isPending: authPending } = useAuth()
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [replayingId, setReplayingId] = useState<string | null>(null)

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
        return res.json() as Promise<ProjectsApiResponse>
      })
      .then(data => {
        setProjects(
          (data.projects ?? []).map(p => ({
            ...p,
            created_at: new Date(p.created_at),
            updated_at: new Date(p.updated_at),
          })),
        )
        setLoading(false)
      })
      .catch(err => {
        console.error('[builds] fetch failed:', err)
        setError('Failed to load your projects. Please try again.')
        setLoading(false)
      })
  }, [isAuthenticated])

  /**
   * Load a project's generation log from Firestore and replay it through
   * the builder — same pipeline as file-based replay, just a different data source.
   */
  const handleReplay = useCallback(async (projectId: string, appName: string) => {
    setReplayingId(projectId)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/logs`)
      if (!res.ok) throw new Error('Failed to load logs')
      const { events } = await res.json() as { events: StoredEvent[] }
      if (!events.length) {
        setError('No generation logs found for this project.')
        return
      }

      const result = extractReplayStages(events)
      if (!result.success) {
        setError(result.error)
        return
      }

      setReplayData(result.stages, result.doneIndex, appName || undefined)
      router.push('/build/new')
    } catch (err) {
      console.error('[builds] replay failed:', err)
      setError('Failed to load replay data. Please try again.')
    } finally {
      setReplayingId(null)
    }
  }, [router])

  if (authPending || !isAuthenticated) return null

  return (
    <div className="min-h-screen bg-nova-void">
      {/* ── Header ──────────────────────────────────────────── */}
      <header className="border-b border-nova-border px-6 py-4 flex items-center justify-between">
        <Link href="/">
          <Logo size="sm" />
        </Link>
        <div className="flex items-center gap-2">
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
            {projects.map((project, i) => {
              const style = STATUS_STYLES[project.status] ?? STATUS_STYLES.complete
              return (
                <motion.div
                  key={project.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                >
                  <Link
                    href={`/build/${project.id}`}
                    className="block p-4 bg-nova-surface border border-nova-border rounded-lg hover:border-nova-border-bright transition-colors group"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium group-hover:text-nova-text transition-colors">
                          {project.app_name || 'Untitled'}
                        </h3>
                        <p className="text-sm text-nova-text-secondary mt-1 flex items-center gap-3">
                          <span>{formatRelativeDate(project.updated_at)}</span>
                          <span className="text-nova-text-muted">
                            {project.module_count} module{project.module_count !== 1 ? 's' : ''}
                            {' \u00b7 '}
                            {project.form_count} form{project.form_count !== 1 ? 's' : ''}
                          </span>
                          {project.connect_type && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-nova-cyan/10 text-cyan-400">
                              {project.connect_type}
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            if (!replayingId) handleReplay(project.id, project.app_name)
                          }}
                          disabled={replayingId !== null}
                          className="p-1.5 text-nova-text-muted hover:text-nova-violet transition-colors rounded-md hover:bg-nova-violet/10 disabled:opacity-40 disabled:cursor-not-allowed"
                          title="Replay generation"
                        >
                          <Icon
                            icon={ciPlayCircle}
                            width="18"
                            height="18"
                            className={replayingId === project.id ? 'animate-pulse' : ''}
                          />
                        </button>
                        <span className={`text-xs px-2 py-1 rounded-md ${style.bg} ${style.text}`}>
                          {style.label}
                        </span>
                      </div>
                    </div>
                  </Link>
                </motion.div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
