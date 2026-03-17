'use client'
import { Icon } from '@iconify/react'
import ciImage from '@iconify-icons/ci/image'
import type { Question } from '@/lib/schemas/blueprint'

export function MediaField({ question }: { question: Question }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-pv-surface border border-dashed border-pv-input-border">
      <Icon icon={ciImage} width="20" height="20" className="text-nova-text-muted" />
      <span className="text-sm text-nova-text-muted">
        {question.type} capture (not available in preview)
      </span>
    </div>
  )
}
