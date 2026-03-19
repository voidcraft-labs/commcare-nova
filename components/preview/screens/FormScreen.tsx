'use client'
import { useRef, useMemo, useCallback } from 'react'
import type { AppBlueprint } from '@/lib/schemas/blueprint'
import type { Builder } from '@/lib/services/builder'
import type { EditMode } from '@/hooks/useEditContext'
import { EditContextProvider } from '@/hooks/useEditContext'
import { useFormEngine } from '@/hooks/useFormEngine'
import { FormRenderer } from '../form/FormRenderer'
import { Icon } from '@iconify/react'
import { formTypeIcons } from '@/lib/questionTypeIcons'

interface FormScreenProps {
  blueprint: AppBlueprint
  moduleIndex: number
  formIndex: number
  caseData?: Map<string, string>
  onBack: () => void
  builder?: Builder
  mode?: EditMode
}

export function FormScreen({ blueprint, moduleIndex, formIndex, caseData, onBack, builder, mode = 'edit' }: FormScreenProps) {
  const mod = blueprint.modules[moduleIndex]
  const form = mod?.forms[formIndex]

  const stableCaseData = useMemo(() => caseData, [caseData])

  const engine = useFormEngine(
    form!,
    blueprint.case_types ?? undefined,
    mod?.case_type ?? undefined,
    stableCaseData,
    builder?.mutationCount,
  )

  const formBodyElRef = useRef<HTMLDivElement>(null)

  // In live/test mode, focus the selected question's input when the form mounts
  // or when the selection changes. rAF ensures the DOM is painted first.
  const formBodyRef = useCallback((el: HTMLDivElement | null) => {
    formBodyElRef.current = el
    if (!el || mode !== 'test') return
    const qId = builder?.selected?.questionPath
    if (!qId) return
    const raf = requestAnimationFrame(() => {
      const qEl = el.querySelector(`[data-question-id="${qId}"]`)
      const input = qEl?.querySelector('input, select, textarea') as HTMLElement | null
      input?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [mode, builder?.selected?.questionPath])

  if (!form) {
    return (
      <div className="p-6 text-center text-nova-text-muted">
        Form not found.
      </div>
    )
  }

  // Follow-up forms in live mode require case data to function
  if (mode === 'test' && form.type === 'followup' && (!caseData || caseData.size === 0)) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 px-6">
        <div className="text-center space-y-2">
          <h3 className="text-sm font-medium text-nova-text">No cases available</h3>
          <p className="text-sm text-nova-text-muted max-w-xs">
            This follow-up form requires an existing case. Submit the registration form first to create one.
          </p>
        </div>
      </div>
    )
  }

  const questions = engine.getQuestions()

  const handleSubmit = () => {
    const valid = engine.validateAll()
    if (valid) {
      onBack()
    } else {
      const errorEl = formBodyElRef.current?.querySelector('[data-invalid="true"]')
      errorEl?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  const formBody = (
    <>
      {/* Form header */}
      <div className="px-6 pt-5 pb-4 border-b border-pv-input-border">
        <div className="flex items-center gap-2">
          <Icon icon={formTypeIcons[form.type] ?? formTypeIcons.survey} width="18" height="18" className="text-nova-text-muted shrink-0" />
          <h2 className="text-lg font-display font-semibold text-nova-text">{form.name}</h2>
        </div>
      </div>

      {/* Form body */}
      <div ref={formBodyRef} className="flex-1 px-6 py-6">
        {questions.length === 0 ? (
          <div className="text-center text-nova-text-muted py-8">
            This form has no questions.
          </div>
        ) : (
          <FormRenderer
            questions={questions}
            engine={engine}
          />
        )}
      </div>

      {/* Bottom bar */}
      <div className="px-6 py-3 border-t border-pv-input-border bg-pv-surface">
        <button
          onClick={handleSubmit}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-pv-accent text-white hover:brightness-110 transition-all cursor-pointer"
        >
          Submit
        </button>
      </div>
    </>
  )

  return (
    <div className="flex flex-col h-full max-w-3xl mx-auto w-full" onClick={() => builder?.select()}>
      {builder ? (
        <EditContextProvider builder={builder} moduleIndex={moduleIndex} formIndex={formIndex} mode={mode}>
          {formBody}
        </EditContextProvider>
      ) : (
        formBody
      )}
    </div>
  )
}
