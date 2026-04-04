'use client'
import { motion } from 'motion/react'
import { Icon } from '@iconify/react/offline'
import ciPlayCircle from '@iconify-icons/ci/play-circle-outline'
import Link from 'next/link'
import type { ProjectSummary } from '@/lib/db/projects'
import { formatRelativeDate, STATUS_STYLES } from '@/lib/utils/format'
import { ConnectBadge } from './ConnectBadge'

interface ProjectCardProps {
  project: Pick<ProjectSummary, 'id' | 'app_name' | 'connect_type' | 'module_count' | 'form_count' | 'status' | 'updated_at'>
  /** Animation stagger index. */
  index: number
  /** If provided, the card links to this URL on click. */
  href?: string
  /** Called when the replay button is clicked. Omit to hide replay. */
  onReplay?: (projectId: string, appName: string) => void
  /** The project ID currently being replayed (disables all replay buttons). */
  replayingId?: string | null
}

/**
 * Shared project card used by the builds page and admin user profile.
 * Renders project name, metadata, status badge, and optional replay button.
 * When `href` is provided, the card is a clickable link.
 */
export function ProjectCard({ project, index, href, onReplay, replayingId }: ProjectCardProps) {
  const style = STATUS_STYLES[project.status]
  const isFailed = project.status === 'error'
  const updatedAt = new Date(project.updated_at)

  const content = (
    <div className="flex items-center justify-between">
      <div>
        <h3 className={`font-medium ${isFailed ? 'text-nova-text-muted' : href ? 'group-hover:text-nova-text' : ''} transition-colors`}>
          {project.app_name || 'Untitled'}
        </h3>
        <p className="text-sm text-nova-text-secondary mt-1 flex items-center gap-3">
          {isFailed ? (
            <span className="text-nova-rose/70">Generation failed</span>
          ) : (
            <>
              <span>{formatRelativeDate(updatedAt)}</span>
              <span className="text-nova-text-muted">
                {project.module_count} module{project.module_count !== 1 ? 's' : ''}
                {' \u00b7 '}
                {project.form_count} form{project.form_count !== 1 ? 's' : ''}
              </span>
              {project.connect_type && <ConnectBadge type={project.connect_type} />}
            </>
          )}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {!isFailed && onReplay && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (!replayingId) onReplay(project.id, project.app_name)
            }}
            disabled={replayingId !== undefined && replayingId !== null}
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
        )}
        <span className={`text-xs px-2 py-1 rounded-md ${style.bg} ${style.text}`}>
          {style.label}
        </span>
      </div>
    </div>
  )

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03 }}
    >
      {isFailed || !href ? (
        <div className={`block p-4 bg-nova-surface border border-nova-border rounded-lg ${isFailed ? 'opacity-60' : ''}`}>
          {content}
        </div>
      ) : (
        <Link
          href={href}
          className="block p-4 bg-nova-surface border border-nova-border rounded-lg hover:border-nova-border-bright transition-colors group"
        >
          {content}
        </Link>
      )}
    </motion.div>
  )
}
