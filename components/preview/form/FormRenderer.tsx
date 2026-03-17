'use client'
import { motion } from 'motion/react'
import type { Question } from '@/lib/schemas/blueprint'
import type { FormEngine } from '@/lib/preview/engine/formEngine'
import { renderPreviewMarkdown } from '@/lib/markdown'
import { QuestionField } from './QuestionField'
import { GroupField } from './fields/GroupField'
import { LabelField } from './fields/LabelField'
import { RepeatField } from './fields/RepeatField'

interface FormRendererProps {
  questions: Question[]
  engine: FormEngine
  prefix?: string
}

export function FormRenderer({ questions, engine, prefix = '/data' }: FormRendererProps) {
  const renderChildren = (children: Question[], childPrefix: string) => (
    <FormRenderer questions={children} engine={engine} prefix={childPrefix} />
  )

  return (
    <div className="space-y-4">
      {questions.map((q, idx) => {
        const path = `${prefix}/${q.id}`
        const state = engine.getState(path)

        // Hidden questions produce no UI
        if (q.type === 'hidden') return null

        // Check visibility
        if (!state.visible) return null

        // Group
        if (q.type === 'group') {
          return (
            <motion.div
              key={q.id || idx}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.03, duration: 0.25 }}
            >
              <GroupField
                question={q}
                path={path}
                engine={engine}
                renderChildren={renderChildren}
              />
            </motion.div>
          )
        }

        // Repeat
        if (q.type === 'repeat') {
          return (
            <motion.div
              key={q.id || idx}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.03, duration: 0.25 }}
            >
              <RepeatField
                question={q}
                path={path}
                engine={engine}
                renderChildren={renderChildren}
              />
            </motion.div>
          )
        }

        // Label (display-only, no input)
        if (q.type === 'label') {
          return (
            <motion.div
              key={q.id || idx}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.03, duration: 0.25 }}
            >
              <LabelField question={q} state={state} />
            </motion.div>
          )
        }

        // Regular question
        return (
          <motion.div
            key={q.id || idx}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.03, duration: 0.25 }}
            data-invalid={state.touched && !state.valid ? 'true' : undefined}
          >
            <label className="block space-y-1.5">
              {q.label && (
                <div className="flex items-center gap-1">
                  <span className="preview-markdown text-sm font-medium text-nova-text" dangerouslySetInnerHTML={{ __html: renderPreviewMarkdown(state.resolvedLabel ?? q.label) }} />
                  {state.required && <span className="text-nova-rose text-xs">*</span>}
                </div>
              )}
              {q.hint && (
                <div className="preview-markdown text-xs text-nova-text-muted" dangerouslySetInnerHTML={{ __html: renderPreviewMarkdown(state.resolvedHint ?? q.hint) }} />
              )}
              <QuestionField
                question={q}
                state={state}
                onChange={(value) => engine.setValue(path, value)}
                onBlur={() => engine.touch(path)}
              />
            </label>
          </motion.div>
        )
      })}
    </div>
  )
}
