'use client'
import { useState, useCallback, useEffect, useMemo, useRef, Fragment, createContext, useContext } from 'react'
import { DragDropProvider, DragOverlay, PointerSensor } from '@dnd-kit/react'
import { useSortable } from '@dnd-kit/react/sortable'
import { CollisionPriority } from '@dnd-kit/abstract'
import { PointerActivationConstraints } from '@dnd-kit/dom'
import { RestrictToElement } from '@dnd-kit/dom/modifiers'
import { move } from '@dnd-kit/helpers'
import type { Question } from '@/lib/schemas/blueprint'
import { type QuestionPath, qpath, qpathId } from '@/lib/services/questionPath'
import type { FormEngine } from '@/lib/preview/engine/formEngine'
import { renderPreviewMarkdown } from '@/lib/markdown'
import { LabelContent } from '@/lib/references/LabelContent'
import { useEditContext } from '@/hooks/useEditContext'
import { QuestionField } from './QuestionField'
import { GroupField } from './fields/GroupField'
import { LabelField } from './fields/LabelField'
import { RepeatField } from './fields/RepeatField'
import { EditableQuestionWrapper } from './EditableQuestionWrapper'
import { HiddenField } from './fields/HiddenField'
import { HelpTooltip } from './HelpTooltip'
import { InsertionPoint } from './InsertionPoint'

/** EMA smoothing factor for cursor velocity. Lower = smoother, slower response. */
const EMA_ALPHA = 0.01
/** Time (ms) without mouse events before EMA resets to raw speed instead of smoothing. Prevents stale EMA from lingering after long pauses. */
const GAP_RESET = 5000

/** Sentinel group identifier for root-level questions. */
const ROOT_GROUP = '__root__'

/** Suffix used on items-map keys for group/repeat containers, matching the
 *  `useDroppable` id in GroupField / RepeatField so the `move` helper can
 *  route dragged items into empty containers. */
const CONTAINER_SUFFIX = ':container'

interface FormRendererProps {
  questions: Question[]
  engine: FormEngine
  prefix?: string
  parentPath?: QuestionPath
}

/** Sensor config: 5px distance to distinguish click from drag. */
const SENSORS = [
  PointerSensor.configure({
    activationConstraints: [
      new PointerActivationConstraints.Distance({ value: 5 }),
    ],
  }),
]

// ── Controlled drag state ─────────────────────────────────────────────
// Follows the official dnd-kit "droppable columns" pattern: onDragOver +
// move() + React state + render from state. Required because the
// OptimisticSortingPlugin only processes SortableDroppable instances —
// plain useDroppable targets (used for empty group containers) are invisible
// to it. The controlled approach lets the move() helper detect container
// drops via target.id matching items-map keys.

interface DragReorderState {
  /** Group → ordered questionPaths. Updated by `move` helper during drag. */
  itemsMap: Record<string, string[]>
  /** Flat lookup: questionPath → Question object (stable for the drag). */
  questionsById: Map<string, Question>
  /** The questionPath currently being dragged (for placeholder rendering). */
  activePath: QuestionPath
}

const DragReorderContext = createContext<DragReorderState | null>(null)

/** Shared cursor speed refs from the root FormRenderer to all nested instances. */
const CursorSpeedContext = createContext<{
  speedRef: React.RefObject<number>
  lastRef: React.RefObject<{ x: number; y: number; t: number } | undefined>
} | null>(null)

/** Build controlled drag state from the question tree. */
function buildDragState(questions: Question[], activePath: QuestionPath): DragReorderState {
  const itemsMap: Record<string, string[]> = {}
  const questionsById = new Map<string, Question>()

  function walk(qs: Question[], groupKey: string, pathPrefix: string) {
    if (!itemsMap[groupKey]) itemsMap[groupKey] = []
    for (const q of qs) {
      const qPath = pathPrefix ? `${pathPrefix}/${q.id}` : q.id
      itemsMap[groupKey].push(qPath)
      questionsById.set(qPath, q)
      if ((q.type === 'group' || q.type === 'repeat') && q.children) {
        const containerKey = `${qPath}${CONTAINER_SUFFIX}`
        if (!itemsMap[containerKey]) itemsMap[containerKey] = []
        walk(q.children, containerKey, qPath)
      }
    }
  }
  walk(questions, ROOT_GROUP, '')
  return { itemsMap, questionsById, activePath }
}

/** Find a question by bare ID anywhere in the tree. */
function findQuestionInTree(questions: Question[], id: string): Question | undefined {
  for (const q of questions) {
    if (q.id === id) return q
    if (q.children) {
      const found = findQuestionInTree(q.children, id)
      if (found) return found
    }
  }
  return undefined
}

/** Strip the :container suffix to recover the actual QuestionPath. */
function stripContainerSuffix(group: string): string {
  return group.endsWith(CONTAINER_SUFFIX) ? group.slice(0, -CONTAINER_SUFFIX.length) : group
}

// ── SortableQuestion ──────────────────────────────────────────────────

function SortableQuestion({
  q,
  questionPath,
  sortIndex,
  path,
  engine,
  renderChildren,
  group,
  isActiveDrag,
}: {
  q: Question
  questionPath: QuestionPath
  sortIndex: number
  path: string
  engine: FormEngine
  renderChildren: (children: Question[], childPrefix: string, parentPath: QuestionPath) => React.ReactNode
  group: string
  /** True if this item is the one currently being dragged. */
  isActiveDrag: boolean
}) {
  const state = engine.getState(path)
  const ctx = useEditContext()
  const isEditMode = ctx?.mode === 'edit'

  // Groups/repeats get Lowest collision priority so their inner container
  // droppable (Low) wins when items are dragged over the content area.
  const isContainer = q.type === 'group' || q.type === 'repeat'

  const { ref, isDragging } = useSortable({
    id: questionPath,
    index: sortIndex,
    group,
    type: 'question',
    accept: 'question',
    disabled: !isEditMode,
    ...(isContainer && { collisionPriority: CollisionPriority.Lowest }),
  })

  if (q.type === 'hidden' && !isEditMode) return null
  if (!isEditMode && !state.visible) return null

  // Use isDragging from dnd-kit OR the context flag (covers cross-group remount where isDragging resets)
  const showAsPlaceholder = isDragging || isActiveDrag

  // In edit mode: suppress validation display entirely
  const showInvalid = !isEditMode && state.touched && !state.valid

  // In edit mode (preview): show clean inputs — no values, no validation errors.
  // Engine state is preserved internally for when the user switches back to live.
  const displayState = isEditMode ? {
    ...state,
    value: '',
    touched: false,
    valid: true,
    errorMessage: undefined,
  } : state

  // Build content based on question type
  let content: React.ReactNode

  if (q.type === 'group') {
    content = (
      <EditableQuestionWrapper questionPath={questionPath} isDragging={showAsPlaceholder}>
        <GroupField question={q} path={path} questionPath={questionPath} engine={engine} renderChildren={renderChildren} />
      </EditableQuestionWrapper>
    )
  } else if (q.type === 'repeat') {
    content = (
      <EditableQuestionWrapper questionPath={questionPath} isDragging={showAsPlaceholder}>
        <RepeatField question={q} path={path} questionPath={questionPath} engine={engine} renderChildren={renderChildren} />
      </EditableQuestionWrapper>
    )
  } else if (q.type === 'label') {
    content = (
      <EditableQuestionWrapper questionPath={questionPath} isDragging={showAsPlaceholder}>
        <LabelField question={q} state={displayState} />
      </EditableQuestionWrapper>
    )
  } else if (q.type === 'hidden') {
    content = (
      <EditableQuestionWrapper questionPath={questionPath} isDragging={showAsPlaceholder}>
        <HiddenField question={q} />
      </EditableQuestionWrapper>
    )
  } else {
    content = (
      <EditableQuestionWrapper questionPath={questionPath} isDragging={showAsPlaceholder}>
        <label className="block space-y-1.5">
          {q.label && (
            <div className="flex items-center gap-1">
              <div className="text-sm font-medium text-nova-text"><LabelContent label={q.label} resolvedLabel={state.resolvedLabel} isEditMode={isEditMode} /></div>
              {state.required && <span className="text-nova-rose text-xs">*</span>}
              {q.help && <HelpTooltip help={q.help} isEditMode={isEditMode} />}
            </div>
          )}
          {q.hint && (
            <div className="text-xs text-nova-text-muted"><LabelContent label={q.hint} resolvedLabel={state.resolvedHint} isEditMode={isEditMode} /></div>
          )}
          <QuestionField
            question={q}
            state={displayState}
            onChange={(value) => engine.setValue(path, value)}
            onBlur={() => engine.touch(path)}
          />
        </label>
      </EditableQuestionWrapper>
    )
  }

  return (
    <div
      ref={ref}
      className="relative mb-4"
      data-invalid={showInvalid ? 'true' : undefined}
      data-question-id={questionPath}
    >
      {showAsPlaceholder && (
        <div className="absolute inset-0 rounded-lg border-2 border-dashed border-nova-cyan/30 bg-nova-cyan/[0.02]" />
      )}
      <div className={showAsPlaceholder ? 'invisible' : undefined}>
        {content}
      </div>
    </div>
  )
}

// ── FormRenderer ──────────────────────────────────────────────────────

export function FormRenderer({ questions, engine, prefix = '/data', parentPath }: FormRendererProps) {
  const ctx = useEditContext()
  const isEditMode = ctx?.mode === 'edit'
  const isRoot = !parentPath
  const [dragState, setDragState] = useState<DragReorderState | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  /** Group identifier for sortable items at this level.
   *  Nested levels use the `:container` suffix to match the droppable id in
   *  GroupField / RepeatField so the `move` helper can route items there. */
  const group = parentPath ? `${parentPath as string}${CONTAINER_SUFFIX}` : ROOT_GROUP

  // Nested FormRenderers read drag state from context; root uses its own state.
  const dragCtx = useContext(DragReorderContext)
  const activeDragReorder = isRoot ? dragState : dragCtx

  // Cursor velocity tracking (EMA-smoothed, document-level so EMA is warm before cursor reaches insertion points)
  // Root creates the refs and provides them via CursorSpeedContext; nested instances consume.
  const cursorCtx = useContext(CursorSpeedContext)
  const ownSpeedRef = useRef(0)
  const ownLastRef = useRef<{ x: number; y: number; t: number } | undefined>(undefined)
  const cursorSpeedRef = isRoot ? ownSpeedRef : (cursorCtx?.speedRef ?? ownSpeedRef)
  const lastCursorRef = isRoot ? ownLastRef : (cursorCtx?.lastRef ?? ownLastRef)
  useEffect(() => {
    if (!isEditMode || !isRoot) return
    const handler = (e: MouseEvent) => {
      const now = performance.now()
      const last = lastCursorRef.current
      if (last) {
        const dt = now - last.t
        if (dt > 0) {
          const dx = e.clientX - last.x
          const dy = e.clientY - last.y
          const speed = Math.sqrt(dx * dx + dy * dy) / dt
          // Long gap = cursor was stopped, EMA is stale — reset to raw speed
          cursorSpeedRef.current = dt > GAP_RESET ? speed : EMA_ALPHA * speed + (1 - EMA_ALPHA) * cursorSpeedRef.current
        }
      }
      lastCursorRef.current = { x: e.clientX, y: e.clientY, t: now }
    }
    const wheelHandler = (e: WheelEvent) => {
      const now = performance.now()
      const last = lastCursorRef.current
      if (last) {
        const dt = now - last.t
        if (dt > 0) {
          // Normalize: deltaMode 0=px, 1=lines (~16px each)
          const pxDelta = Math.abs(e.deltaY) * (e.deltaMode === 1 ? 16 : 1)
          const speed = pxDelta / dt
          cursorSpeedRef.current = dt > GAP_RESET ? speed : EMA_ALPHA * speed + (1 - EMA_ALPHA) * cursorSpeedRef.current
        }
        // Update timestamp so poll knows there's activity; position stays unchanged
        last.t = now
      }
    }
    document.addEventListener('mousemove', handler)
    document.addEventListener('wheel', wheelHandler, { passive: true })
    return () => {
      document.removeEventListener('mousemove', handler)
      document.removeEventListener('wheel', wheelHandler)
    }
  }, [isEditMode, isRoot])

  const renderChildren = useCallback((children: Question[], childPrefix: string, parentPath: QuestionPath) => (
    <FormRenderer questions={children} engine={engine} prefix={childPrefix} parentPath={parentPath} />
  ), [engine])

  // During drag: render from the controlled items map (reflects cross-group moves).
  // Otherwise: render from the questions prop.
  const visibleQuestions = useMemo(() => {
    if (activeDragReorder) {
      const ids = activeDragReorder.itemsMap[group] ?? []
      return ids
        .map(id => activeDragReorder.questionsById.get(id))
        .filter((q): q is Question => !!q)
    }
    // In preview mode, filter hidden questions at the list level so SortableQuestion
    // (and its useSortable hook) never runs for them — avoids wasted hook execution.
    // In edit mode, hidden questions are visible and draggable, so include them.
    return isEditMode ? questions : questions.filter(q => q.type !== 'hidden')
  }, [questions, activeDragReorder, group, engine, isEditMode])

  const modifiers = useMemo(() => [
    RestrictToElement.configure({
      element: () => containerRef.current,
    }),
  ], [])

  // For root: search entire tree for the active question (supports nested items).
  const activePath = dragState?.activePath
  const activeQuestion = activePath ? findQuestionInTree(questions, qpathId(activePath)) : undefined
  const isDragging = !!activePath

  const list = (
    <div ref={isRoot ? containerRef : undefined} className="min-h-full pointer-events-auto">
      {isEditMode && <InsertionPoint atIndex={0} parentPath={parentPath} disabled={isDragging} cursorSpeedRef={cursorSpeedRef} lastCursorRef={lastCursorRef} />}
      {visibleQuestions.map((q, idx) => {
        const actualIdx = questions.indexOf(q)
        const questionPath = activeDragReorder
          ? (activeDragReorder.itemsMap[group]?.[idx] as QuestionPath | undefined) ?? qpath(q.id, parentPath)
          : qpath(q.id, parentPath)
        return (
          <Fragment key={questionPath}>
            <SortableQuestion
              q={q}
              questionPath={questionPath}
              sortIndex={idx}
              path={`${prefix}/${q.id}`}
              engine={engine}
              renderChildren={renderChildren}
              group={group}
              isActiveDrag={!!activeDragReorder && questionPath === activeDragReorder.activePath}
            />
            {isEditMode && <InsertionPoint atIndex={actualIdx >= 0 ? actualIdx + 1 : idx + 1} parentPath={parentPath} disabled={isDragging} cursorSpeedRef={cursorSpeedRef} lastCursorRef={lastCursorRef} />}
          </Fragment>
        )
      })}
    </div>
  )

  const cursorSpeedCtx = useMemo(() => ({ speedRef: cursorSpeedRef, lastRef: lastCursorRef }), [cursorSpeedRef, lastCursorRef])

  // Non-edit mode or nested FormRenderers: just render items (no DragDropProvider).
  // Only the root FormRenderer creates the DragDropProvider so items can drag across all levels.
  if (!isEditMode || !isRoot) {
    return list
  }

  return (
    <CursorSpeedContext.Provider value={cursorSpeedCtx}>
    <DragReorderContext.Provider value={dragState}>
      <DragDropProvider
        sensors={SENSORS}
        modifiers={modifiers}
        onDragStart={(event) => {
          const sourceId = event.operation.source?.id
          if (sourceId) {
            const path = sourceId as QuestionPath
            setDragState(buildDragState(questions, path))
          }
          document.body.style.cursor = 'grabbing'
          if (ctx) {
            ctx.builder.setDragging(true)
            ctx.builder.select()
          }
        }}
        onDragOver={(event) => {
          setDragState(prev => {
            if (!prev) return prev
            const newMap = move(prev.itemsMap, event)
            if (newMap === prev.itemsMap) return prev
            return { ...prev, itemsMap: newMap }
          })
        }}
        onDragEnd={(event) => {
          // Capture state before clearing — dnd-kit fires this during
          // useInsertionEffect where React 19 forbids setState, so defer cleanup.
          const currentDragState = dragState
          const draggedPath = dragState?.activePath
          const canceled = event.canceled

          queueMicrotask(() => {
            setDragState(null)
            document.body.style.cursor = ''
            if (ctx) ctx.builder.setDragging(false)

            if (canceled || !ctx || !draggedPath || !currentDragState) return

            const mb = ctx.builder.mb
            if (!mb) return

            // Find where the item ended up in the controlled items map
            const finalMap = currentDragState.itemsMap
            let finalGroup: string | undefined
            let finalIndex = -1
            for (const [g, ids] of Object.entries(finalMap)) {
              const idx = ids.indexOf(draggedPath as string)
              if (idx !== -1) {
                finalGroup = g
                finalIndex = idx
                break
              }
            }

            if (finalGroup === undefined || finalIndex === -1) return

            // Determine the initial group from the dragged path
            const draggedStr = draggedPath as string
            const lastSlash = draggedStr.lastIndexOf('/')
            const parentOfDragged = lastSlash === -1 ? null : draggedStr.slice(0, lastSlash)
            const initialGroup = parentOfDragged ? `${parentOfDragged}${CONTAINER_SUFFIX}` : ROOT_GROUP

            const sameGroup = initialGroup === finalGroup

            // Check if position actually changed
            if (sameGroup) {
              const initialMap = buildDragState(questions, draggedPath).itemsMap
              const initialIds = initialMap[initialGroup] ?? []
              const finalIds = finalMap[finalGroup] ?? []
              const initialIdx = initialIds.indexOf(draggedStr)
              if (initialIdx === finalIndex && initialIds.length === finalIds.length) {
                // No movement — just select
                ctx.builder.select({
                  type: 'question',
                  moduleIndex: ctx.moduleIndex,
                  formIndex: ctx.formIndex,
                  questionPath: draggedPath,
                })
                return
              }
            }

            // Use neighboring items in the final map to determine position
            const finalIds = finalMap[finalGroup] ?? []
            const targetParentPath = finalGroup === ROOT_GROUP
              ? undefined
              : stripContainerSuffix(finalGroup) as QuestionPath

            if (sameGroup) {
              // Same-level reorder
              if (finalIndex === 0) {
                if (finalIds.length > 1) {
                  const nextPath = finalIds[1] as QuestionPath
                  mb.moveQuestion(ctx.moduleIndex, ctx.formIndex, draggedPath, { beforePath: nextPath })
                }
              } else {
                const prevPath = finalIds[finalIndex - 1] as QuestionPath
                mb.moveQuestion(ctx.moduleIndex, ctx.formIndex, draggedPath, { afterPath: prevPath })
              }
            } else {
              // Cross-group transfer
              if (finalIds.length <= 1) {
                mb.moveQuestion(ctx.moduleIndex, ctx.formIndex, draggedPath, { targetParentPath })
              } else if (finalIndex === 0) {
                const nextPath = finalIds[1] as QuestionPath
                const nextId = qpathId(nextPath)
                const beforePath = qpath(nextId, targetParentPath)
                mb.moveQuestion(ctx.moduleIndex, ctx.formIndex, draggedPath, { beforePath, targetParentPath })
              } else {
                const prevPath = finalIds[finalIndex - 1] as QuestionPath
                const prevId = qpathId(prevPath)
                const afterPath = qpath(prevId, targetParentPath)
                mb.moveQuestion(ctx.moduleIndex, ctx.formIndex, draggedPath, { afterPath, targetParentPath })
              }
            }

            const newPath = sameGroup ? draggedPath : qpath(qpathId(draggedPath), targetParentPath)
            ctx.builder.notifyBlueprintChanged()

            ctx.builder.select({
              type: 'question',
              moduleIndex: ctx.moduleIndex,
              formIndex: ctx.formIndex,
              questionPath: newPath,
            })
          })
        }}
      >
        {list}
        <DragOverlay>
          {activeQuestion && (
            <div className="rounded-lg bg-nova-surface/80 border border-nova-cyan/40 px-3 py-2 shadow-lg text-sm text-nova-text">
              {activeQuestion.label || activeQuestion.id}
            </div>
          )}
        </DragOverlay>
      </DragDropProvider>
    </DragReorderContext.Provider>
    </CursorSpeedContext.Provider>
  )
}
