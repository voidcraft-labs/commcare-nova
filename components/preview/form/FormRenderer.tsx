'use client'
import { useState, useCallback, useMemo, useRef, Fragment } from 'react'
import { DragDropProvider, DragOverlay, PointerSensor } from '@dnd-kit/react'
import { useSortable, isSortable } from '@dnd-kit/react/sortable'
import { PointerActivationConstraints } from '@dnd-kit/dom'
import { RestrictToElement } from '@dnd-kit/dom/modifiers'
import type { Question } from '@/lib/schemas/blueprint'
import type { FormEngine } from '@/lib/preview/engine/formEngine'
import { renderPreviewMarkdown } from '@/lib/markdown'
import { useEditContext } from '@/hooks/useEditContext'
import { QuestionField } from './QuestionField'
import { GroupField } from './fields/GroupField'
import { LabelField } from './fields/LabelField'
import { RepeatField } from './fields/RepeatField'
import { EditableQuestionWrapper } from './EditableQuestionWrapper'
import { InsertionPoint } from './InsertionPoint'
import { LogicBadges } from './LogicBadges'

interface FormRendererProps {
  questions: Question[]
  engine: FormEngine
  prefix?: string
  parentId?: string
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
  sortIndex,
  path,
  engine,
  renderChildren,
}: {
  q: Question
  sortIndex: number
  path: string
  engine: FormEngine
  renderChildren: (children: Question[], childPrefix: string) => React.ReactNode
}) {
  const state = engine.getState(path)
  const ctx = useEditContext()
  const isEditMode = ctx?.mode === 'edit'

  const { ref, isDragging } = useSortable({
    id: q.id,
    index: sortIndex,
    disabled: !isEditMode,
  })

  if (q.type === 'hidden') return null
  if (!state.visible) return null

  // In edit mode: suppress validation display entirely
  const showInvalid = !isEditMode && state.touched && !state.valid

  // Build content based on question type
  let content: React.ReactNode

  if (q.type === 'group') {
    content = (
      <EditableQuestionWrapper questionId={q.id} isDragging={isDragging}>
        <div className="relative">
          <div className="absolute top-1 right-1 z-10"><LogicBadges question={q} /></div>
          <GroupField question={q} path={path} engine={engine} renderChildren={renderChildren} />
        </div>
      </EditableQuestionWrapper>
    )
  } else if (q.type === 'repeat') {
    content = (
      <EditableQuestionWrapper questionId={q.id} isDragging={isDragging}>
        <div className="relative">
          <div className="absolute top-1 right-1 z-10"><LogicBadges question={q} /></div>
          <RepeatField question={q} path={path} engine={engine} renderChildren={renderChildren} />
        </div>
      </EditableQuestionWrapper>
    )
  } else if (q.type === 'label') {
    content = (
      <EditableQuestionWrapper questionId={q.id} isDragging={isDragging}>
        <div className="relative">
          <div className="absolute top-1 right-1 z-10"><LogicBadges question={q} /></div>
          <LabelField question={q} state={state} />
        </div>
      </EditableQuestionWrapper>
    )
  } else {
    content = (
      <EditableQuestionWrapper questionId={q.id} isDragging={isDragging}>
        <div className="relative">
          <div className="absolute top-1 right-8 z-10"><LogicBadges question={q} /></div>
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
        </div>
      </EditableQuestionWrapper>
    )
  }

  return (
    <div
      ref={ref}
      className="relative mb-4"
      data-invalid={showInvalid ? 'true' : undefined}
    >
      {isDragging && (
        <div className="absolute inset-0 rounded-lg border-2 border-dashed border-nova-violet/30 bg-nova-violet/[0.02]" />
      )}
      <div className={isDragging ? 'invisible' : undefined}>
        {content}
      </div>
    </div>
  )
}

export function FormRenderer({ questions, engine, prefix = '/data', parentId }: FormRendererProps) {
  const ctx = useEditContext()
  const isEditMode = ctx?.mode === 'edit'
  const [activeId, setActiveId] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Cursor velocity tracking (EMA-smoothed, all refs — no re-renders)
  const cursorSpeedRef = useRef(0)
  const lastCursorRef = useRef<{ x: number; y: number; t: number } | null>(null)
  const handleContainerMouseMove = useCallback((e: React.MouseEvent) => {
    const now = performance.now()
    const last = lastCursorRef.current
    if (last) {
      const dt = now - last.t
      if (dt > 0) {
        const dx = e.clientX - last.x
        const dy = e.clientY - last.y
        const speed = Math.sqrt(dx * dx + dy * dy) / dt
        // Long gap = mouse was stopped, reset. Otherwise EMA smooth.
        cursorSpeedRef.current = dt > 100 ? speed : 0.1 * speed + 0.9 * cursorSpeedRef.current
      }
    }
    lastCursorRef.current = { x: e.clientX, y: e.clientY, t: now }
  }, [])

  const renderChildren = useCallback((children: Question[], childPrefix: string) => (
    <FormRenderer questions={children} engine={engine} prefix={childPrefix} parentId={childPrefix.split('/').pop()} />
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

  const activeQuestion = activeId ? questions.find(q => q.id === activeId) : null
  const isDragging = !!activeId

  const list = (
    <div ref={containerRef} className="min-h-full pointer-events-auto" onMouseMove={isEditMode ? handleContainerMouseMove : undefined}>
      {isEditMode && <InsertionPoint atIndex={0} parentId={parentId} disabled={isDragging} cursorSpeedRef={cursorSpeedRef} />}
      {visibleQuestions.map((q, idx) => {
        const actualIdx = questions.indexOf(q)
        return (
          <Fragment key={q.id}>
            <SortableQuestion
              q={q}
              sortIndex={idx}
              path={`${prefix}/${q.id}`}
              engine={engine}
              renderChildren={renderChildren}
              />
            {isEditMode && <InsertionPoint atIndex={actualIdx + 1} parentId={parentId} disabled={isDragging} cursorSpeedRef={cursorSpeedRef} />}
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
          if (sourceId) setActiveId(sourceId as string)
          document.body.style.cursor = 'grabbing'
          if (ctx) ctx.builder.select(null)
        }}
        onDragEnd={(event) => {
          const draggedId = activeId
          setActiveId(null)
          document.body.style.cursor = ''

          if (event.canceled || !ctx || !draggedId) return

          const { source } = event.operation
          if (!source || !isSortable(source)) return

          const { initialIndex, index } = source
          if (initialIndex !== index) {
            const mb = ctx.builder.mb
            if (mb) {
              const withoutMoved = visibleQuestions.filter((_, i) => i !== initialIndex)
              if (index === 0) {
                mb.moveQuestion(ctx.moduleIndex, ctx.formIndex, draggedId, { beforeId: withoutMoved[0].id })
              } else {
                mb.moveQuestion(ctx.moduleIndex, ctx.formIndex, draggedId, { afterId: withoutMoved[index - 1].id })
              }
              ctx.builder.notifyBlueprintChanged()
            }
          }

          ctx.builder.select({
            type: 'question',
            moduleIndex: ctx.moduleIndex,
            formIndex: ctx.formIndex,
            questionPath: draggedId,
          })
        }}
      >
        {list}
        <DragOverlay>
          {activeQuestion && (
            <div className="rounded-lg bg-nova-surface/80 border border-nova-violet/40 px-3 py-2 shadow-lg text-sm text-nova-text">
              {activeQuestion.label || activeQuestion.id}
            </div>
          )}
        </DragOverlay>
      </DragDropProvider>
    </>
  )
}
