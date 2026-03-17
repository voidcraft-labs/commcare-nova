'use client'
import type { Question } from '@/lib/schemas/blueprint'
import type { FormEngine } from '@/lib/preview/engine/formEngine'

interface GroupFieldProps {
  question: Question
  path: string
  engine: FormEngine
  renderChildren: (questions: Question[], prefix: string) => React.ReactNode
}

export function GroupField({ question, path, engine, renderChildren }: GroupFieldProps) {
  const state = engine.getState(path)
  if (!state.visible) return null

  return (
    <div className="rounded-lg border border-pv-input-border overflow-hidden">
      {question.label && (
        <div className="px-4 py-2 bg-pv-surface border-b border-pv-input-border">
          <h4 className="text-sm font-medium text-nova-text">{state.resolvedLabel ?? question.label}</h4>
          {question.hint && (
            <p className="text-xs text-nova-text-muted mt-0.5">{state.resolvedHint ?? question.hint}</p>
          )}
        </div>
      )}
      <div className="p-4 space-y-4">
        {question.children && renderChildren(question.children, path)}
      </div>
    </div>
  )
}
