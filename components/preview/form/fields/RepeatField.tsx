'use client'
import { Icon } from '@iconify/react'
import ciPlus from '@iconify-icons/ci/plus'
import ciTrash from '@iconify-icons/ci/trash-full'
import type { Question } from '@/lib/schemas/blueprint'
import type { QuestionPath } from '@/lib/services/questionPath'
import type { FormEngine } from '@/lib/preview/engine/formEngine'
import { renderPreviewMarkdown } from '@/lib/markdown'

interface RepeatFieldProps {
  question: Question
  path: string
  questionPath: QuestionPath
  engine: FormEngine
  renderChildren: (questions: Question[], prefix: string, parentPath: QuestionPath) => React.ReactNode
}

export function RepeatField({ question, path, questionPath, engine, renderChildren }: RepeatFieldProps) {
  const state = engine.getState(path)
  if (!state.visible) return null

  const count = engine.getRepeatCount(path)
  const instances = Array.from({ length: count }, (_, i) => i)

  return (
    <div className="space-y-3">
      {question.label && (
        <div className="preview-markdown text-sm font-medium text-nova-text" dangerouslySetInnerHTML={{ __html: renderPreviewMarkdown(state.resolvedLabel ?? question.label ?? '') }} />
      )}
      {instances.map((idx) => (
        <div key={idx} className="rounded-lg border border-pv-input-border overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 bg-pv-surface border-b border-pv-input-border">
            <span className="text-xs font-medium text-nova-text-secondary">
              #{idx + 1}
            </span>
            {count > 1 && (
              <button
                onClick={() => engine.removeRepeat(path, idx)}
                className="p-1 text-nova-text-muted hover:text-nova-rose transition-colors cursor-pointer"
              >
                <Icon icon={ciTrash} width="14" height="14" />
              </button>
            )}
          </div>
          <div className="p-4 space-y-4">
            {question.children && renderChildren(question.children, `${path}[${idx}]`, questionPath)}
          </div>
        </div>
      ))}
      <button
        onClick={() => engine.addRepeat(path)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-pv-accent hover:text-pv-accent-bright border border-pv-input-border hover:border-pv-input-focus rounded-lg transition-colors cursor-pointer"
      >
        <Icon icon={ciPlus} width="14" height="14" />
        Add {state.resolvedLabel ?? question.label ?? 'entry'}
      </button>
    </div>
  )
}
