/**
 * Inline settings panel for inspect cursor mode.
 *
 * Renders below the selected question inside the form DOM, replacing the
 * floating ContextualEditor. Uses the same sub-editors (UI, Logic, Data,
 * Footer) but lays them out as vertically stacked collapsible sections
 * at full form width instead of tabs in a 288px popover.
 *
 * The panel is a sibling of EditableQuestionWrapper (not inside it), so
 * it pushes subsequent questions down naturally and scrolls with the
 * question. Drag-drop still works — the panel is inside SortableQuestion
 * and moves with the question during drag.
 */

'use client'
import { useState, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react/offline'
import ciChevronDown from '@iconify-icons/ci/chevron-down'
import type { Builder } from '@/lib/services/builder'
import type { Question } from '@/lib/schemas/blueprint'
import type { QuestionPath } from '@/lib/services/questionPath'
import { ContextualEditorUI } from './contextual/ContextualEditorUI'
import { ContextualEditorLogic } from './contextual/ContextualEditorLogic'
import { ContextualEditorData } from './contextual/ContextualEditorData'
import { ContextualEditorFooter } from './contextual/ContextualEditorFooter'

interface InlineSettingsPanelProps {
  builder: Builder
  question: Question
  questionPath: QuestionPath
  moduleIndex: number
  formIndex: number
}

/** Section identifier for collapse state tracking. */
type Section = 'appearance' | 'logic' | 'data'

/** Section header with collapse chevron. */
function SectionHeader({ label, expanded, onToggle }: { label: string; expanded: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-1.5 w-full py-2 text-xs font-semibold uppercase tracking-wider text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
      data-no-drag
    >
      <Icon
        icon={ciChevronDown}
        width="14"
        height="14"
        className={`transition-transform duration-150 ${expanded ? '' : '-rotate-90'}`}
      />
      {label}
    </button>
  )
}

export function InlineSettingsPanel({ builder, question, questionPath, moduleIndex, formIndex }: InlineSettingsPanelProps) {
  const mb = builder.mb!
  const { notifyBlueprintChanged } = builder
  const selected = builder.selected!
  const panelRef = useRef<HTMLDivElement>(null)

  /* Track which sections are expanded. All start open. */
  const [expanded, setExpanded] = useState<Record<Section, boolean>>({
    appearance: true,
    logic: true,
    data: true,
  })

  const toggle = useCallback((section: Section) => {
    setExpanded(prev => ({ ...prev, [section]: !prev[section] }))
  }, [])

  /* Reset section state when the selected question changes. Hidden questions
   * start with Logic expanded and Appearance collapsed. */
  const prevPathRef = useRef(questionPath)
  if (questionPath !== prevPathRef.current) {
    prevPathRef.current = questionPath
    const isHidden = question.type === 'hidden'
    setExpanded({
      appearance: !isHidden,
      logic: true,
      data: true,
    })
  }

  /* Stop click from propagating to the parent (which would re-select the question). */
  const stopClick = useCallback((e: React.MouseEvent) => e.stopPropagation(), [])


  return (
    <AnimatePresence>
      <motion.div
        ref={panelRef}
        key={questionPath}
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
        onClick={stopClick}
        className="mt-2 rounded-lg border border-nova-border bg-nova-surface/50 overflow-hidden"
        data-no-drag
      >
        <div className="px-4 py-2 space-y-0.5">
          {/* ── Appearance section (UI tab contents) ── */}
          <SectionHeader label="Appearance" expanded={expanded.appearance} onToggle={() => toggle('appearance')} />
          {expanded.appearance && (
            <div className="pb-3">
              <ContextualEditorUI
                question={question}
                selected={selected}
                mb={mb}
                builder={builder}
                notifyBlueprintChanged={notifyBlueprintChanged}
              />
            </div>
          )}

          {/* ── Logic section ── */}
          <SectionHeader label="Logic" expanded={expanded.logic} onToggle={() => toggle('logic')} />
          {expanded.logic && (
            <div className="pb-3">
              <ContextualEditorLogic
                question={question}
                selected={selected}
                mb={mb}
                notifyBlueprintChanged={notifyBlueprintChanged}
              />
            </div>
          )}

          {/* ── Data section ── */}
          <SectionHeader label="Data" expanded={expanded.data} onToggle={() => toggle('data')} />
          {expanded.data && (
            <div className="pb-3">
              <ContextualEditorData
                question={question}
                selected={selected}
                mb={mb}
                builder={builder}
                notifyBlueprintChanged={notifyBlueprintChanged}
              />
            </div>
          )}
        </div>

        {/* ── Footer: move, duplicate, delete ── */}
        <div className="border-t border-nova-border">
          <ContextualEditorFooter
            selected={selected}
            mb={mb}
            builder={builder}
            notifyBlueprintChanged={notifyBlueprintChanged}
          />
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
