'use client'
import type { ConversationMessage } from '@/lib/types'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'

interface GenerationCardProps {
  message: ConversationMessage
  isGenerating: boolean
  onGenerate: () => void
  onCancel: () => void
}

export function GenerationCard({
  message,
  isGenerating,
  onGenerate,
  onCancel,
}: GenerationCardProps) {
  const isCancelled = message.cancelled

  return (
    <div className="flex justify-start">
      <div className={`max-w-[85%] rounded-xl border border-nova-violet/20 bg-nova-violet/5 overflow-hidden ${
        isCancelled ? 'opacity-50' : ''
      }`}>
        {/* Header */}
        <div className="px-3.5 py-2.5 border-b border-nova-violet/10 flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1v12M1 7h12" stroke="var(--nova-violet)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="text-sm font-medium text-nova-text">
            {message.appName}
          </span>
        </div>

        {/* Description */}
        {message.appDescription && (
          <div className="px-3.5 py-2.5 text-xs leading-relaxed text-nova-text-secondary whitespace-pre-wrap">
            {message.appDescription}
          </div>
        )}

        {/* Footer */}
        <div className="px-3.5 py-2 bg-nova-violet/5 border-t border-nova-violet/10 flex items-center justify-between">
          {isCancelled ? (
            <Badge variant="muted">Cancelled</Badge>
          ) : isGenerating ? (
            <span className="text-xs text-nova-violet flex items-center gap-1.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-nova-violet animate-pulse" />
              Generating...
            </span>
          ) : (
            <div className="flex items-center gap-2 ml-auto">
              <Button variant="ghost" size="sm" onClick={onCancel}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={onGenerate}>
                Generate
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
