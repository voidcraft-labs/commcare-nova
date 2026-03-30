'use client'
import { Icon } from '@iconify/react/offline'
import type { Question } from '@/lib/schemas/blueprint'
import { questionTypeIcons } from '@/lib/questionTypeIcons'
import { ExpressionContent } from '@/lib/references/ExpressionContent'

/**
 * Edit-mode-only representation of a hidden question. These have no label or
 * visible input — they're system-level values driven by calculate expressions
 * or static defaults. The card shows the question ID as the primary identifier
 * and surfaces any calculate/default expressions with dimmed inline chips for
 * hashtag references.
 */
export function HiddenField({ question }: { question: Question }) {
  const expr = question.calculate || question.default_value

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg border border-dashed border-nova-text-muted/25 bg-nova-text-muted/[0.03]">
      <div className="flex items-center gap-1.5 shrink-0">
        <Icon icon={questionTypeIcons.hidden} width="14" height="14" className="text-nova-text-muted/60" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-nova-text-muted/50">
          Hidden
        </span>
      </div>

      <div className="w-px h-4 bg-nova-text-muted/15 shrink-0" />

      <span className="text-xs font-mono font-medium text-nova-text/70 shrink-0">
        {question.id}
      </span>

      {expr && (
        <>
          <div className="w-px h-4 bg-nova-text-muted/15 shrink-0" />
          <span className="text-[11px] font-mono text-nova-text-muted/50 truncate min-w-0" title={expr}>
            {question.calculate
              ? <><span className="text-nova-violet/50">f</span>{' '}</>
              : <><span className="text-nova-amber/50">=</span>{' '}</>
            }
            <ExpressionContent expr={expr} />
          </span>
        </>
      )}
    </div>
  )
}
