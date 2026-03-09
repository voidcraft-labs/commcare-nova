'use client'
import { motion } from 'motion/react'
import type { AppBlueprint, BlueprintForm, BlueprintQuestion } from '@/lib/schemas/blueprint'
import { Badge } from '@/components/ui/Badge'

interface DetailPanelProps {
  blueprint: AppBlueprint
  selected: { type: string; moduleIndex: number; formIndex?: number; questionPath?: string }
  onUpdate: (blueprint: AppBlueprint) => void
  onClose: () => void
}

export function DetailPanel({ blueprint, selected, onUpdate, onClose }: DetailPanelProps) {
  const mod = blueprint.modules[selected.moduleIndex]
  if (!mod) return null

  const form = selected.formIndex !== undefined ? mod.forms[selected.formIndex] : undefined

  // Find question by ID (recursively)
  function findQuestion(questions: BlueprintQuestion[], id: string): BlueprintQuestion | undefined {
    for (const q of questions) {
      if (q.id === id) return q
      if (q.children) {
        const found = findQuestion(q.children, id)
        if (found) return found
      }
    }
    return undefined
  }

  const question = selected.questionPath && form
    ? findQuestion(form.questions || [], selected.questionPath)
    : undefined

  return (
    <motion.div
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="w-80 border-l border-nova-border bg-nova-deep overflow-y-auto shrink-0"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-nova-border flex items-center justify-between">
        <h3 className="text-sm font-medium text-nova-text-secondary">
          {selected.type === 'module' ? 'Module' : selected.type === 'form' ? 'Form' : 'Question'}
        </h3>
        <button
          onClick={onClose}
          className="text-nova-text-muted hover:text-nova-text transition-colors p-1"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* Module details */}
        {selected.type === 'module' && (
          <>
            <div>
              <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Name</label>
              <p className="text-sm font-medium">{mod.name}</p>
            </div>
            {mod.case_type && (
              <div>
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Case Type</label>
                <p className="text-sm font-mono text-nova-cyan-bright">{mod.case_type}</p>
              </div>
            )}
            {mod.case_list_columns && mod.case_list_columns.length > 0 && (
              <div>
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Case List Columns</label>
                <div className="space-y-1">
                  {mod.case_list_columns.map((col, i) => (
                    <div key={i} className="flex items-center justify-between text-sm px-2 py-1 bg-nova-surface rounded">
                      <span className="text-nova-text-secondary">{col.header}</span>
                      <span className="font-mono text-xs text-nova-text-muted">{col.field}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Forms</label>
              <div className="space-y-1">
                {mod.forms.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <Badge variant={f.type === 'registration' ? 'emerald' : f.type === 'followup' ? 'cyan' : 'amber'}>
                      {f.type}
                    </Badge>
                    <span>{f.name}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Form details */}
        {selected.type === 'form' && form && (
          <>
            <div>
              <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Name</label>
              <p className="text-sm font-medium">{form.name}</p>
            </div>
            <div>
              <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Type</label>
              <Badge variant={form.type === 'registration' ? 'emerald' : form.type === 'followup' ? 'cyan' : 'amber'}>
                {form.type}
              </Badge>
            </div>
            {form.case_name_field && (
              <div>
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Case Name Field</label>
                <p className="text-sm font-mono text-nova-cyan-bright">{form.case_name_field}</p>
              </div>
            )}
            {form.case_properties && Object.keys(form.case_properties).length > 0 && (
              <div>
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Case Properties</label>
                <div className="space-y-1">
                  {Object.entries(form.case_properties).map(([prop, qId]) => (
                    <div key={prop} className="flex items-center justify-between text-xs px-2 py-1 bg-nova-surface rounded">
                      <span className="text-nova-text-secondary">{prop}</span>
                      <span className="font-mono text-nova-text-muted">&larr; {qId}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {form.case_preload && Object.keys(form.case_preload).length > 0 && (
              <div>
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Case Preload</label>
                <div className="space-y-1">
                  {Object.entries(form.case_preload).map(([qId, prop]) => (
                    <div key={qId} className="flex items-center justify-between text-xs px-2 py-1 bg-nova-surface rounded">
                      <span className="font-mono text-nova-text-muted">{qId}</span>
                      <span className="text-nova-text-secondary">&larr; {prop}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {form.close_case && (
              <div>
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Close Case</label>
                <p className="text-sm text-nova-rose">
                  {form.close_case.question
                    ? `When ${form.close_case.question} = "${form.close_case.answer}"`
                    : 'Always (unconditional)'}
                </p>
              </div>
            )}
            <div>
              <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Questions</label>
              <p className="text-sm text-nova-text-secondary">{form.questions?.length || 0} questions</p>
            </div>
          </>
        )}

        {/* Question details */}
        {selected.type === 'question' && question && (
          <>
            {question.label && (
              <div>
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Label</label>
                <p className="text-sm font-medium">{question.label}</p>
              </div>
            )}
            <div>
              <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">ID</label>
              <p className="text-sm font-mono text-nova-violet-bright">{question.id}</p>
            </div>
            <div>
              <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Type</label>
              <Badge variant="violet">{question.type}</Badge>
            </div>
            {question.hint && (
              <div>
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Hint</label>
                <p className="text-sm text-nova-text-secondary">{question.hint}</p>
              </div>
            )}
            {question.required && (
              <div>
                <Badge variant="amber">Required</Badge>
              </div>
            )}
            {question.readonly && (
              <div>
                <Badge variant="muted">Read-only</Badge>
              </div>
            )}
            {question.constraint && (
              <div>
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Constraint</label>
                <p className="text-sm font-mono text-nova-text-secondary">{question.constraint}</p>
                {question.constraint_msg && (
                  <p className="text-xs text-nova-amber mt-1">{question.constraint_msg}</p>
                )}
              </div>
            )}
            {question.relevant && (
              <div>
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Show When</label>
                <p className="text-sm font-mono text-nova-text-secondary">{question.relevant}</p>
              </div>
            )}
            {question.default_value && (
              <div>
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Default Value</label>
                <p className="text-sm font-mono text-nova-text-secondary">{question.default_value}</p>
              </div>
            )}
            {question.calculate && (
              <div>
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Calculate</label>
                <p className="text-sm font-mono text-nova-text-secondary">{question.calculate}</p>
              </div>
            )}
            {question.options && question.options.length > 0 && (
              <div>
                <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Options</label>
                <div className="space-y-1">
                  {question.options.map((opt, i) => (
                    <div key={i} className="flex items-center justify-between text-xs px-2 py-1 bg-nova-surface rounded">
                      <span>{opt.label}</span>
                      <span className="font-mono text-nova-text-muted">{opt.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </motion.div>
  )
}
