'use client'
import { useState, useCallback, useDeferredValue, useMemo } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react'
import ciMoreGridBig from '@iconify-icons/ci/more-grid-big'
import ciTable from '@iconify-icons/ci/table'
import ciChevronRight from '@iconify-icons/ci/chevron-right'
import ciSearchMagnifyingGlass from '@iconify-icons/ci/search-magnifying-glass'
import ciCloseSm from '@iconify-icons/ci/close-sm'
import type { Question } from '@/lib/schemas/blueprint'
import { BuilderPhase, type TreeData } from '@/lib/services/builder'
import { type QuestionPath, qpath } from '@/lib/services/questionPath'
import { Badge } from '@/components/ui/Badge'
import { questionTypeIcons, formTypeIcons } from '@/lib/questionTypeIcons'
import { filterTree, highlightSegments, type MatchIndices } from '@/lib/filterTree'

interface AppTreeProps {
  data: TreeData | undefined
  selected: { type: string; moduleIndex: number; formIndex?: number; questionPath?: QuestionPath } | undefined
  onSelect: (selected: any) => void
  phase: BuilderPhase
  actions?: React.ReactNode
  hideHeader?: boolean
  /** Compact mode for side-panel rendering — tighter spacing, no max-width constraint */
  compact?: boolean
}

export function AppTree({ data, selected, onSelect, phase, actions, hideHeader, compact }: AppTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const deferredQuery = useDeferredValue(searchQuery)
  const filtered = useMemo(
    () => data && deferredQuery.trim() ? filterTree(data, deferredQuery.trim()) : null,
    [data, deferredQuery],
  )

  const toggle = useCallback((key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  if (!data) {
    return (
      <div className="h-full flex items-center justify-center text-nova-text-muted text-sm">
        Waiting for generation...
      </div>
    )
  }

  const displayModules = filtered ? filtered.data.modules : data.modules

  return (
    <div className="h-full flex flex-col">
      {!hideHeader && (
        <div className="flex items-center justify-between px-6 h-12 border-b border-nova-border shrink-0">
          <div className="flex items-center min-w-0">
            <span className="text-sm font-medium text-nova-text truncate">{data.app_name}</span>
          </div>
          {actions && (
            <div className="flex items-center gap-2 shrink-0">
              {actions}
            </div>
          )}
        </div>
      )}

      {/* Search input — compact/sidebar mode only */}
      {compact && (
        <div className="px-3 pt-3 shrink-0">
          <div className="relative">
            <Icon
              icon={ciSearchMagnifyingGlass}
              width="14"
              height="14"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-nova-text-muted pointer-events-none"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  if (searchQuery) setSearchQuery('')
                  else (e.target as HTMLInputElement).blur()
                }
              }}
              placeholder="Filter questions..."
              autoComplete="off"
              data-1p-ignore
              className="w-full pl-8 pr-7 py-1.5 text-xs bg-nova-surface border border-nova-border rounded-lg text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:border-nova-violet transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
              >
                <Icon icon={ciCloseSm} width="12" height="12" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Scrollable module cards */}
      <div className={`flex-1 overflow-auto ${compact ? 'p-3 space-y-3' : 'p-6 space-y-4'}`}>
        {filtered && displayModules.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-nova-text-muted text-xs">
            No matches
          </div>
        ) : (
          <div className={compact ? 'space-y-3' : 'max-w-3xl mx-auto space-y-4'}>
            <AnimatePresence mode="sync">
              {displayModules.map((mod, mIdx) => (
                <ModuleCard
                  key={mIdx}
                  module={mod}
                  moduleIndex={mIdx}
                  selected={selected}
                  onSelect={onSelect}
                  compact={compact}
                  collapsed={collapsed}
                  toggle={toggle}
                  forceExpand={filtered?.forceExpand}
                  matchMap={filtered?.matchMap}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  )
}

/** Reusable disclosure chevron — rotates 90deg when expanded */
function CollapseChevron({ isCollapsed, onClick }: { isCollapsed: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      className="w-6 h-6 -m-1 flex items-center justify-center shrink-0 cursor-pointer rounded text-nova-text-muted hover:text-nova-text hover:bg-nova-surface/50 transition-colors"
      onClick={onClick}
    >
      <Icon
        icon={ciChevronRight}
        width="10"
        height="10"
        className="transition-transform duration-150"
        style={{ transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}
      />
    </button>
  )
}

function ModuleCard({
  module: mod,
  moduleIndex,
  selected,
  onSelect,
  compact,
  collapsed,
  toggle,
  forceExpand,
  matchMap,
}: {
  module: TreeData['modules'][number]
  moduleIndex: number
  selected: AppTreeProps['selected']
  onSelect: AppTreeProps['onSelect']
  compact?: boolean
  collapsed: Set<string>
  toggle: (key: string) => void
  forceExpand?: Set<string>
  matchMap?: Map<string, MatchIndices>
}) {
  const isSelected = selected?.type === 'module' && selected.moduleIndex === moduleIndex
  const collapseKey = `m${moduleIndex}`
  const isCollapsed = forceExpand?.has(collapseKey) ? false : collapsed.has(collapseKey)
  const nameIndices = matchMap?.get(collapseKey)

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
        <div className="flex items-center gap-2">
          <CollapseChevron
            isCollapsed={isCollapsed}
            onClick={(e) => { e.stopPropagation(); toggle(collapseKey) }}
          />
          <div className="w-8 h-8 rounded-lg bg-nova-violet/10 flex items-center justify-center">
            <Icon icon={ciMoreGridBig} width="16" height="16" className="text-nova-violet-bright" />
          </div>
          <div>
            <h3 className="font-medium text-sm">
              {nameIndices ? <HighlightedText text={mod.name} indices={nameIndices} /> : mod.name}
            </h3>
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

      {!isCollapsed && (
        <>
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
                  collapsed={collapsed}
                  toggle={toggle}
                  forceExpand={forceExpand}
                  matchMap={matchMap}
                />
              ))}
            </AnimatePresence>
          </div>
        </>
      )}
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
  collapsed,
  toggle,
  forceExpand,
  matchMap,
}: {
  form: TreeData['modules'][number]['forms'][number]
  moduleIndex: number
  formIndex: number
  selected: AppTreeProps['selected']
  onSelect: AppTreeProps['onSelect']
  delay: number
  collapsed: Set<string>
  toggle: (key: string) => void
  forceExpand?: Set<string>
  matchMap?: Map<string, MatchIndices>
}) {
  const isSelected = selected?.type === 'form' && selected.moduleIndex === moduleIndex && selected.formIndex === formIndex
  const formIcon = formTypeIcons[form.type] ?? formTypeIcons.survey
  const collapseKey = `f${moduleIndex}_${formIndex}`
  const isCollapsed = forceExpand?.has(collapseKey) ? false : collapsed.has(collapseKey)
  const hasQuestions = form.questions && form.questions.length > 0
  const oddPaths = hasQuestions ? buildOddPaths(form.questions!, collapsed) : undefined
  const nameIndices = matchMap?.get(collapseKey)

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
        className="px-4 py-2.5 cursor-pointer hover:bg-nova-surface/30 transition-colors flex items-center gap-2"
        onClick={() => onSelect({ type: 'form', moduleIndex, formIndex })}
      >
        {hasQuestions ? (
          <CollapseChevron
            isCollapsed={isCollapsed}
            onClick={(e) => { e.stopPropagation(); toggle(collapseKey) }}
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Icon icon={formIcon} width="14" height="14" className="text-nova-text-muted shrink-0" />
            <span className="text-sm font-medium truncate">
              {nameIndices ? <HighlightedText text={form.name} indices={nameIndices} /> : form.name}
            </span>
          </div>
        </div>
        {hasQuestions && (
          <span className="text-xs text-nova-text-muted shrink-0">
            {countQuestions(form.questions!)} q
          </span>
        )}
      </div>

      {/* Questions */}
      {hasQuestions && !isCollapsed && (
        <div className="pl-6 pr-3 pb-1.5">
          <AnimatePresence mode="sync">
            {form.questions!.map((q, qIdx) => (
              <QuestionRow
                key={q.id ? `${moduleIndex}_${formIndex}_${qIdx}_${q.id}` : `${moduleIndex}_${formIndex}_${qIdx}`}
                question={q}
                questionPath={qpath(q.id)}
                moduleIndex={moduleIndex}
                formIndex={formIndex}
                onSelect={onSelect}
                selected={selected}
                depth={0}
                delay={delay + qIdx * 0.02}
                collapsed={collapsed}
                toggle={toggle}
                oddPaths={oddPaths!}
                forceExpand={forceExpand}
                matchMap={matchMap}
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
  questionPath,
  moduleIndex,
  formIndex,
  onSelect,
  selected,
  depth,
  delay,
  collapsed,
  toggle,
  oddPaths,
  forceExpand,
  matchMap,
}: {
  question: Question
  questionPath: QuestionPath
  moduleIndex: number
  formIndex: number
  onSelect: AppTreeProps['onSelect']
  selected: AppTreeProps['selected']
  depth: number
  delay: number
  collapsed: Set<string>
  toggle: (key: string) => void
  oddPaths: Set<string>
  forceExpand?: Set<string>
  matchMap?: Map<string, MatchIndices>
}) {
  const isSelected = selected?.type === 'question' && selected.moduleIndex === moduleIndex && selected.formIndex === formIndex && selected.questionPath === questionPath
  const iconData = questionTypeIcons[q.type]
  const hasChildren = q.children && q.children.length > 0
  const isCollapsed = hasChildren && (forceExpand?.has(questionPath) ? false : collapsed.has(questionPath))
  const isOdd = oddPaths.has(questionPath)
  const labelIndices = matchMap?.get(questionPath)
  const idIndices = matchMap?.get(`${questionPath}__id`)
  // Show the ID badge when the match came from the ID (and question has a separate label)
  const showIdMatch = !!(idIndices && q.label)
  // Highlight the main display text: label match, or id match when there's no label
  const textIndices = labelIndices ?? (!q.label ? idIndices : undefined)
  const displayText = q.label || q.id

  return (
    <motion.div
      initial={{ opacity: 0, x: -5 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.2 }}
    >
      <div
        data-tree-question={questionPath}
        className={`flex items-center gap-1.5 py-1.5 px-1.5 -mx-1.5 cursor-pointer transition-colors text-xs ${
          isSelected ? 'bg-nova-violet/10 text-nova-text' : `${isOdd ? 'bg-white/[0.025]' : ''} hover:bg-white/10 text-nova-text-secondary`
        }`}
        style={{ paddingLeft: `${depth * 6}px` }}
        onClick={(e) => {
          e.stopPropagation()
          onSelect({ type: 'question', moduleIndex, formIndex, questionPath })
        }}
      >
        {hasChildren ? (
          <CollapseChevron
            isCollapsed={!!isCollapsed}
            onClick={(e) => { e.stopPropagation(); toggle(questionPath) }}
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <span className="w-4 text-center text-nova-text-muted shrink-0 flex items-center justify-center">
          {iconData ? <Icon icon={iconData} width="12" height="12" /> : '?'}
        </span>
        {showIdMatch ? (
          <span className="flex items-center gap-1.5 min-w-0 flex-1">
            <span className={`truncate shrink ${hasChildren ? 'font-medium text-[#b8b8dd]' : ''}`}>
              {textIndices ? <HighlightedText text={displayText} indices={textIndices} /> : displayText}
            </span>
            <span className="truncate shrink-0 max-w-[45%] font-mono text-[10px] text-nova-text-muted">
              (<HighlightedText text={q.id} indices={idIndices} />)
            </span>
          </span>
        ) : (
          <span className={`truncate ${hasChildren ? 'font-medium text-[#b8b8dd]' : ''}`}>
            {textIndices ? <HighlightedText text={displayText} indices={textIndices} /> : displayText}
          </span>
        )}
        {hasChildren && isCollapsed && (
          <span className="text-[10px] text-nova-text-muted ml-auto shrink-0">
            {countQuestions(q.children!)}
          </span>
        )}
      </div>

      {/* Nested children for groups/repeats */}
      {hasChildren && !isCollapsed && (
        <div className="ml-1 border-l border-nova-text-muted/20">
          {q.children!.map((child, cIdx) => (
            <QuestionRow
              key={child.id ? `${moduleIndex}_${formIndex}_${cIdx}_${child.id}` : `${moduleIndex}_${formIndex}_${cIdx}`}
              question={child}
              questionPath={qpath(child.id, questionPath)}
              moduleIndex={moduleIndex}
              formIndex={formIndex}
              onSelect={onSelect}
              selected={selected}
              depth={depth + 1}
              delay={delay + (cIdx + 1) * 0.02}
              collapsed={collapsed}
              toggle={toggle}
              oddPaths={oddPaths}
              forceExpand={forceExpand}
              matchMap={matchMap}
            />
          ))}
        </div>
      )}
    </motion.div>
  )
}

/** Inline highlighted text with match indices */
function HighlightedText({ text, indices }: { text: string; indices: MatchIndices }) {
  const segments = highlightSegments(text, indices)
  return (
    <>
      {segments.map((seg, i) =>
        seg.highlight
          ? <mark key={i} className="bg-nova-violet/20 text-inherit rounded-sm">{seg.text}</mark>
          : <span key={i}>{seg.text}</span>
      )}
    </>
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

/** Pre-flatten visible question paths and return the set of odd-indexed ones. */
function buildOddPaths(questions: Question[], collapsed: Set<string>, parentPath?: QuestionPath): Set<string> {
  const flat: string[] = []
  function walk(qs: Question[], parent?: QuestionPath) {
    for (const q of qs) {
      const p = qpath(q.id, parent)
      flat.push(p)
      if (q.children && q.children.length > 0 && !collapsed.has(p)) {
        walk(q.children, p)
      }
    }
  }
  walk(questions, parentPath)
  const odd = new Set<string>()
  for (let i = 1; i < flat.length; i += 2) odd.add(flat[i])
  return odd
}
