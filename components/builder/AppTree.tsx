'use client'
import { motion, AnimatePresence } from 'motion/react'
import type { AppBlueprint, BlueprintModule, BlueprintForm, BlueprintQuestion } from '@/lib/schemas/blueprint'
import { BuilderPhase } from '@/lib/services/builder'
import { Badge } from '@/components/ui/Badge'

interface AppTreeProps {
  blueprint: AppBlueprint | null
  selected: { type: string; moduleIndex: number; formIndex?: number; questionPath?: string } | null
  onSelect: (selected: any) => void
  phase: BuilderPhase
  actions?: React.ReactNode
}

export function AppTree({ blueprint, selected, onSelect, phase, actions }: AppTreeProps) {
  if (!blueprint) {
    return (
      <div className="h-full flex items-center justify-center text-nova-text-muted">
        Waiting for generation...
      </div>
    )
  }

  return (
    <div className="p-6 space-y-4 max-w-3xl mx-auto">
      {/* App name header + actions */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-6 flex items-start justify-between gap-4"
      >
        <div>
          <h1 className="text-2xl font-display font-semibold">{blueprint.app_name}</h1>
          <p className="text-sm text-nova-text-secondary mt-1">
            {blueprint.modules.length} module{blueprint.modules.length !== 1 ? 's' : ''}
          </p>
        </div>
        {actions && (
          <div className="flex items-center gap-2 shrink-0">
            {actions}
          </div>
        )}
      </motion.div>

      {/* Module cards */}
      <AnimatePresence mode="sync">
        {blueprint.modules.map((mod, mIdx) => (
          <ModuleCard
            key={mIdx}
            module={mod}
            moduleIndex={mIdx}
            selected={selected}
            onSelect={onSelect}
            delay={mIdx * 0.1}
          />
        ))}
      </AnimatePresence>
    </div>
  )
}

function ModuleCard({
  module: mod,
  moduleIndex,
  selected,
  onSelect,
  delay,
}: {
  module: BlueprintModule
  moduleIndex: number
  selected: AppTreeProps['selected']
  onSelect: AppTreeProps['onSelect']
  delay: number
}) {
  const isSelected = selected?.type === 'module' && selected.moduleIndex === moduleIndex

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className={`rounded-xl border transition-colors ${
        isSelected ? 'border-nova-violet bg-nova-surface' : 'border-nova-border bg-nova-deep hover:border-nova-border-bright'
      }`}
    >
      {/* Module header */}
      <div
        className="px-4 py-3 cursor-pointer flex items-center justify-between"
        onClick={() => onSelect({ type: 'module', moduleIndex })}
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-nova-violet/10 flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-nova-violet-bright">
              <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/>
              <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/>
              <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/>
              <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
          </div>
          <div>
            <h3 className="font-medium text-sm">{mod.name}</h3>
            {mod.case_type && (
              <span className="text-xs text-nova-text-muted font-mono">
                case: {mod.case_type}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {mod.case_list_columns && mod.case_list_columns.length > 0 && (
            <Badge variant="cyan">
              {mod.case_list_columns.length} col{mod.case_list_columns.length !== 1 ? 's' : ''}
            </Badge>
          )}
          <Badge variant="muted">
            {mod.forms.length} form{mod.forms.length !== 1 ? 's' : ''}
          </Badge>
        </div>
      </div>

      {/* Case list columns */}
      {mod.case_list_columns && mod.case_list_columns.length > 0 && (
        <div className="px-4 pb-2">
          <div className="flex gap-1.5 flex-wrap">
            {mod.case_list_columns.map((col, i) => (
              <span key={i} className="text-xs px-1.5 py-0.5 bg-nova-cyan/5 text-nova-cyan-bright rounded border border-nova-cyan/10">
                {col.header}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Forms */}
      <div className="border-t border-nova-border">
        {mod.forms.map((form, fIdx) => (
          <FormCard
            key={fIdx}
            form={form}
            moduleIndex={moduleIndex}
            formIndex={fIdx}
            selected={selected}
            onSelect={onSelect}
            delay={delay + (fIdx + 1) * 0.05}
          />
        ))}
      </div>
    </motion.div>
  )
}

function FormCard({
  form,
  moduleIndex,
  formIndex,
  selected,
  onSelect,
  delay,
}: {
  form: BlueprintForm
  moduleIndex: number
  formIndex: number
  selected: AppTreeProps['selected']
  onSelect: AppTreeProps['onSelect']
  delay: number
}) {
  const isSelected = selected?.type === 'form' && selected.moduleIndex === moduleIndex && selected.formIndex === formIndex
  const typeColors = {
    registration: 'emerald',
    followup: 'cyan',
    survey: 'amber',
  } as const

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay, duration: 0.3 }}
      className={`border-b border-nova-border last:border-b-0 ${
        isSelected ? 'bg-nova-surface/50' : ''
      }`}
    >
      <div
        className="px-4 py-2.5 cursor-pointer hover:bg-nova-surface/30 transition-colors flex items-center gap-3"
        onClick={() => onSelect({ type: 'form', moduleIndex, formIndex })}
      >
        <div className="w-1 h-6 rounded-full bg-nova-border" />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{form.name}</span>
            <Badge variant={typeColors[form.type]}>{form.type}</Badge>
          </div>
        </div>
        {form.questions && form.questions.length > 0 && (
          <span className="text-xs text-nova-text-muted">
            {countQuestions(form.questions)} q
          </span>
        )}
      </div>

      {/* Questions */}
      {form.questions && form.questions.length > 0 && (
        <div className="pl-12 pr-4 pb-2 space-y-0.5">
          <AnimatePresence mode="sync">
            {form.questions.map((q, qIdx) => (
              <QuestionRow
                key={q.id || qIdx}
                question={q}
                moduleIndex={moduleIndex}
                formIndex={formIndex}
                onSelect={onSelect}
                selected={selected}
                depth={0}
                delay={delay + qIdx * 0.02}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  )
}

function QuestionRow({
  question: q,
  moduleIndex,
  formIndex,
  onSelect,
  selected,
  depth,
  delay,
}: {
  question: BlueprintQuestion
  moduleIndex: number
  formIndex: number
  onSelect: AppTreeProps['onSelect']
  selected: AppTreeProps['selected']
  depth: number
  delay: number
}) {
  const isSelected = selected?.type === 'question' && selected.questionPath === q.id
  const typeIcons: Record<string, string> = {
    text: 'Aa',
    int: '#',
    decimal: '#.',
    date: '\u{1F4C5}',
    select1: '\u25C9',
    select: '\u2611',
    group: '{ }',
    repeat: '\u27F3',
    hidden: '\u{1F441}',
    geopoint: '\u{1F4CD}',
    image: '\u{1F5BC}',
    phone: '\u{1F4F1}',
    barcode: '\u25AE\u25AF',
    trigger: '\u26A1',
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: -5 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.2 }}
    >
      <div
        className={`flex items-center gap-2 py-1 px-2 rounded cursor-pointer transition-colors text-sm ${
          isSelected ? 'bg-nova-violet/10 text-nova-text' : 'hover:bg-nova-surface/50 text-nova-text-secondary'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={(e) => {
          e.stopPropagation()
          onSelect({ type: 'question', moduleIndex, formIndex, questionPath: q.id })
        }}
      >
        <span className="w-5 text-center text-xs font-mono text-nova-text-muted shrink-0">
          {typeIcons[q.type] || '?'}
        </span>
        <span className="truncate">{q.label || q.id}</span>
        <span className="text-xs text-nova-text-muted font-mono shrink-0 ml-auto">
          {q.type}
        </span>
      </div>

      {/* Nested children for groups/repeats */}
      {q.children && q.children.length > 0 && (
        <div className="ml-2 border-l border-nova-border/50">
          {q.children.map((child, cIdx) => (
            <QuestionRow
              key={child.id || cIdx}
              question={child}
              moduleIndex={moduleIndex}
              formIndex={formIndex}
              onSelect={onSelect}
              selected={selected}
              depth={depth + 1}
              delay={delay + (cIdx + 1) * 0.02}
            />
          ))}
        </div>
      )}
    </motion.div>
  )
}

function countQuestions(questions: BlueprintQuestion[]): number {
  let count = 0
  for (const q of questions) {
    count++
    if (q.children) count += countQuestions(q.children)
  }
  return count
}
