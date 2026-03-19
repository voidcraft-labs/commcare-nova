'use client'
import { useState, useCallback, useEffect, useMemo, useRef, Fragment } from 'react'
import { DragDropProvider, DragOverlay, PointerSensor } from '@dnd-kit/react'
import { useSortable, isSortable } from '@dnd-kit/react/sortable'
import { PointerActivationConstraints } from '@dnd-kit/dom'
import { RestrictToElement } from '@dnd-kit/dom/modifiers'
import type { Question } from '@/lib/schemas/blueprint'
import { type QuestionPath, qpath, qpathId } from '@/lib/services/questionPath'
import type { FormEngine } from '@/lib/preview/engine/formEngine'
import { renderPreviewMarkdown } from '@/lib/markdown'
import { useEditContext } from '@/hooks/useEditContext'
import { QuestionField } from './QuestionField'
import { GroupField } from './fields/GroupField'
import { LabelField } from './fields/LabelField'
import { RepeatField } from './fields/RepeatField'
import { EditableQuestionWrapper } from './EditableQuestionWrapper'
import { InsertionPoint } from './InsertionPoint'

/** EMA smoothing factor for cursor velocity. Lower = smoother, slower response. */
const EMA_ALPHA = 0.01
/** Time (ms) without mouse events before EMA resets to raw speed instead of smoothing. Prevents stale EMA from lingering after long pauses. */
const GAP_RESET = 5000

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

function SortableQuestion({
  q,
  questionPath,
  sortIndex,
  path,
  engine,
  renderChildren,
}: {
  q: Question
  questionPath: QuestionPath
  sortIndex: number
  path: string
  engine: FormEngine
  renderChildren: (children: Question[], childPrefix: string, parentPath: QuestionPath) => React.ReactNode
}) {
  const state = engine.getState(path)
  const ctx = useEditContext()
  const isEditMode = ctx?.mode === 'edit'

  const { ref, isDragging } = useSortable({
    id: questionPath,
    index: sortIndex,
    disabled: !isEditMode,
  })

  if (q.type === 'hidden') return null
  if (!state.visible) return null

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
      <EditableQuestionWrapper questionPath={questionPath} isDragging={isDragging}>
        <GroupField question={q} path={path} questionPath={questionPath} engine={engine} renderChildren={renderChildren} />
      </EditableQuestionWrapper>
    )
  } else if (q.type === 'repeat') {
    content = (
      <EditableQuestionWrapper questionPath={questionPath} isDragging={isDragging}>
        <RepeatField question={q} path={path} questionPath={questionPath} engine={engine} renderChildren={renderChildren} />
      </EditableQuestionWrapper>
    )
  } else if (q.type === 'label') {
    content = (
      <EditableQuestionWrapper questionPath={questionPath} isDragging={isDragging}>
        <LabelField question={q} state={displayState} />
      </EditableQuestionWrapper>
    )
  } else {
    content = (
      <EditableQuestionWrapper questionPath={questionPath} isDragging={isDragging}>
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
      {isDragging && (
        <div className="absolute inset-0 rounded-lg border-2 border-dashed border-nova-cyan/30 bg-nova-cyan/[0.02]" />
      )}
      <div className={isDragging ? 'invisible' : undefined}>
        {content}
      </div>
    </div>
  )
}

export function FormRenderer({ questions, engine, prefix = '/data', parentPath }: FormRendererProps) {
  const ctx = useEditContext()
  const isEditMode = ctx?.mode === 'edit'
  const [activePath, setActivePath] = useState<QuestionPath | undefined>()
  const containerRef = useRef<HTMLDivElement>(null)

  // Cursor velocity tracking (EMA-smoothed, document-level so EMA is warm before cursor reaches insertion points)
  const cursorSpeedRef = useRef(0)
  const lastCursorRef = useRef<{ x: number; y: number; t: number } | undefined>(undefined)
  useEffect(() => {
    if (!isEditMode) return
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
  }, [isEditMode])

  const renderChildren = useCallback((children: Question[], childPrefix: string, parentPath: QuestionPath) => (
    <FormRenderer questions={children} engine={engine} prefix={childPrefix} parentPath={parentPath} />
  ), [engine])

  const visibleQuestions = useMemo(
    () => questions.filter(q => q.type !== 'hidden'),
    [questions]
  )

  const modifiers = useMemo(() => [
    RestrictToElement.configure({
      element: () => containerRef.current,
    }),
  ], [])

  const activeQuestion = activePath ? questions.find(q => q.id === qpathId(activePath)) : undefined
  const isDragging = !!activePath

  const list = (
    <div ref={containerRef} className="min-h-full pointer-events-auto">
      {isEditMode && <InsertionPoint atIndex={0} parentPath={parentPath} disabled={isDragging} cursorSpeedRef={cursorSpeedRef} lastCursorRef={lastCursorRef} />}
      {visibleQuestions.map((q, idx) => {
        const actualIdx = questions.indexOf(q)
        const questionPath = qpath(q.id, parentPath)
        return (
          <Fragment key={`${idx}_${q.id}`}>
            <SortableQuestion
              q={q}
              questionPath={questionPath}
              sortIndex={idx}
              path={`${prefix}/${q.id}`}
              engine={engine}
              renderChildren={renderChildren}
              />
            {isEditMode && <InsertionPoint atIndex={actualIdx + 1} parentPath={parentPath} disabled={isDragging} cursorSpeedRef={cursorSpeedRef} lastCursorRef={lastCursorRef} />}
          </Fragment>
        )
      })}
    </div>
  )

  if (!isEditMode) {
    return list
  }

  return (
    <>
      <DragDropProvider
        sensors={SENSORS}
        modifiers={modifiers}
        onDragStart={(event) => {
          const sourceId = event.operation.source?.id
          if (sourceId) setActivePath(sourceId as QuestionPath)
          document.body.style.cursor = 'grabbing'
          if (ctx) {
            ctx.builder.setDragging(true)
            ctx.builder.select()
          }
        }}
        onDragEnd={(event) => {
          const draggedPath = activePath
          setActivePath(undefined)
          document.body.style.cursor = ''
          if (ctx) ctx.builder.setDragging(false)

          if (event.canceled || !ctx || !draggedPath) return

          const { source } = event.operation
          if (!source || !isSortable(source)) return

          const { initialIndex, index } = source
          if (initialIndex !== index) {
            const mb = ctx.builder.mb
            if (mb) {
              const withoutMoved = visibleQuestions.filter((_, i) => i !== initialIndex)
              if (index === 0) {
                const beforePath = qpath(withoutMoved[0].id, parentPath)
                mb.moveQuestion(ctx.moduleIndex, ctx.formIndex, draggedPath, { beforePath })
              } else {
                const afterPath = qpath(withoutMoved[index - 1].id, parentPath)
                mb.moveQuestion(ctx.moduleIndex, ctx.formIndex, draggedPath, { afterPath })
              }
              ctx.builder.notifyBlueprintChanged()
            }
          }

          ctx.builder.select({
            type: 'question',
            moduleIndex: ctx.moduleIndex,
            formIndex: ctx.formIndex,
            questionPath: draggedPath,
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
    </>
  )
}
