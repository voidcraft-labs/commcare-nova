'use client'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react'
import ciMoreGridBig from '@iconify-icons/ci/more-grid-big'
import ciTable from '@iconify-icons/ci/table'
import ciText from '@iconify-icons/ci/text'
import tabler123 from '@iconify-icons/tabler/123'
import tablerDecimal from '@iconify-icons/tabler/decimal'
import ciCalendar from '@iconify-icons/ci/calendar'
import ciRadioFill from '@iconify-icons/ci/radio-fill'
import ciCheckboxCheck from '@iconify-icons/ci/checkbox-check'
import ciGroup from '@iconify-icons/ci/group'
import ciRepeat from '@iconify-icons/ci/repeat'
import ciHide from '@iconify-icons/ci/hide'
import ciLocation from '@iconify-icons/ci/location'
import ciImage from '@iconify-icons/ci/image'
import ciPhone from '@iconify-icons/ci/phone'
import ciBarcode from '@iconify-icons/ci/barcode'
import ciCircleWarning from '@iconify-icons/ci/circle-warning'
import ciFileAdd from '@iconify-icons/ci/file-add'
import ciFileEdit from '@iconify-icons/ci/file-edit'
import ciFileBlank from '@iconify-icons/ci/file-blank'
import type { Question } from '@/lib/schemas/blueprint'
import { BuilderPhase, type TreeData } from '@/lib/services/builder'
import { Badge } from '@/components/ui/Badge'

interface AppTreeProps {
  data: TreeData | null
  selected: { type: string; moduleIndex: number; formIndex?: number; questionPath?: string } | null
  onSelect: (selected: any) => void
  phase: BuilderPhase
  actions?: React.ReactNode
}

export function AppTree({ data, selected, onSelect, phase, actions }: AppTreeProps) {
  if (!data) {
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
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="mb-6 flex items-start justify-between gap-4"
      >
        <div>
          <h1 className="text-2xl font-display font-semibold">{data.app_name}</h1>
          <p className="text-sm text-nova-text-secondary mt-1">
            {data.modules.length} module{data.modules.length !== 1 ? 's' : ''}
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
        {data.modules.map((mod, mIdx) => (
          <ModuleCard
            key={mIdx}
            module={mod}
            moduleIndex={mIdx}
            selected={selected}
            onSelect={onSelect}
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
}: {
  module: TreeData['modules'][number]
  moduleIndex: number
  selected: AppTreeProps['selected']
  onSelect: AppTreeProps['onSelect']
}) {
  const isSelected = selected?.type === 'module' && selected.moduleIndex === moduleIndex

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
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
            <Icon icon={ciMoreGridBig} width="16" height="16" className="text-nova-violet-bright" />
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
        <Badge variant="muted">
          {mod.forms.length} form{mod.forms.length !== 1 ? 's' : ''}
        </Badge>
      </div>

      {/* Case list columns */}
      {mod.case_list_columns && mod.case_list_columns.length > 0 && (
        <div className="mx-4 mb-3 rounded-lg border border-nova-cyan/12 bg-nova-cyan/[0.03] overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-nova-cyan/8">
            <Icon icon={ciTable} width="12" height="12" className="text-nova-cyan/50" />
            <span className="text-[10px] font-medium text-nova-cyan/50 uppercase tracking-widest">Case List</span>
          </div>
          <div className="flex">
            {mod.case_list_columns.map((col, i) => (
              <div
                key={i}
                className={`flex-1 px-3 py-2 text-xs font-medium text-nova-cyan-bright ${
                  i > 0 ? 'border-l border-nova-cyan/8' : ''
                }`}
              >
                {col.header}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Forms */}
      <div className="border-t border-nova-border">
        <AnimatePresence mode="sync">
          {mod.forms.map((form, fIdx) => (
            <FormCard
              key={`${moduleIndex}-${fIdx}`}
              form={form}
              moduleIndex={moduleIndex}
              formIndex={fIdx}
              selected={selected}
              onSelect={onSelect}
              delay={fIdx * 0.08}
            />
          ))}
        </AnimatePresence>
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
  form: TreeData['modules'][number]['forms'][number]
  moduleIndex: number
  formIndex: number
  selected: AppTreeProps['selected']
  onSelect: AppTreeProps['onSelect']
  delay: number
}) {
  const isSelected = selected?.type === 'form' && selected.moduleIndex === moduleIndex && selected.formIndex === formIndex
  const formTypeIcons = {
    registration: ciFileAdd,
    followup: ciFileEdit,
    survey: ciFileBlank,
  } as const
  const formIcon = formTypeIcons[form.type as keyof typeof formTypeIcons] ?? ciFileBlank

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
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
            <Icon icon={formIcon} width="14" height="14" className="text-nova-text-muted shrink-0" />
            <span className="text-sm font-medium">{form.name}</span>
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
  question: Question
  moduleIndex: number
  formIndex: number
  onSelect: AppTreeProps['onSelect']
  selected: AppTreeProps['selected']
  depth: number
  delay: number
}) {
  const isSelected = selected?.type === 'question' && selected.moduleIndex === moduleIndex && selected.formIndex === formIndex && selected.questionPath === q.id
  const typeIcons: Record<string, React.ReactNode> = {
    text: <Icon icon={ciText} width="14" height="14" />,
    int: <Icon icon={tabler123} width="14" height="14" />,
    decimal: <Icon icon={tablerDecimal} width="14" height="14" />,
    date: <Icon icon={ciCalendar} width="14" height="14" />,
    select1: <Icon icon={ciRadioFill} width="14" height="14" />,
    select: <Icon icon={ciCheckboxCheck} width="14" height="14" />,
    group: <Icon icon={ciGroup} width="14" height="14" />,
    repeat: <Icon icon={ciRepeat} width="14" height="14" />,
    hidden: <Icon icon={ciHide} width="14" height="14" />,
    geopoint: <Icon icon={ciLocation} width="14" height="14" />,
    image: <Icon icon={ciImage} width="14" height="14" />,
    phone: <Icon icon={ciPhone} width="14" height="14" />,
    barcode: <Icon icon={ciBarcode} width="14" height="14" />,
    label: <Icon icon={ciCircleWarning} width="14" height="14" />,
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
        <span className="w-6 text-center text-xs font-mono text-nova-text-muted shrink-0 flex items-center justify-center">
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

function countQuestions(questions: Question[]): number {
  let count = 0
  for (const q of questions) {
    count++
    if (q.children) count += countQuestions(q.children)
  }
  return count
}
