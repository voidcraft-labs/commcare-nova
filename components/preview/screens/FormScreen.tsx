'use client'
import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import type { AppBlueprint } from '@/lib/schemas/blueprint'
import type { PreviewScreen } from '@/lib/preview/engine/types'
import type { Builder } from '@/lib/services/builder'
import type { EditMode } from '@/hooks/useEditContext'
import { EditContextProvider } from '@/hooks/useEditContext'
import { useFormEngine } from '@/hooks/useFormEngine'
import { getCaseData, getDummyCases } from '@/lib/preview/engine/dummyData'
import { FormRenderer } from '../form/FormRenderer'
import { Icon } from '@iconify/react'
import { formTypeIcons } from '@/lib/questionTypeIcons'
import ciArrowReload02 from '@iconify-icons/ci/arrow-reload-02'
import { FormSettingsButton } from '@/components/builder/detail/FormSettingsPanel'
import { FormTypeButton } from '@/components/builder/detail/FormDetail'
import { EditableTitle, SavedCheck } from '@/components/builder/EditableTitle'

interface FormScreenProps {
  blueprint: AppBlueprint
  moduleIndex: number
  formIndex: number
  caseId?: string
  onBack: () => void
  onNavigate?: (screen: PreviewScreen) => void
  builder?: Builder
  mode?: EditMode
}

export function FormScreen({ blueprint, moduleIndex, formIndex, caseId, onBack, onNavigate, builder, mode = 'edit' }: FormScreenProps) {
  const [titleSaved, setTitleSaved] = useState(false)
  const handleTitleSaved = useCallback(() => { setTitleSaved(true); setTimeout(() => setTitleSaved(false), 1500) }, [])
  const mod = blueprint.modules[moduleIndex]
  const form = mod?.forms[formIndex]

  const caseData = useMemo(() => {
    if (!mod?.case_type) return undefined
    if (caseId) return getCaseData(mod.case_type, caseId)
    // Followup forms without a caseId: fall back to first dummy case
    if (form?.type === 'followup') {
      const caseType = blueprint.case_types?.find(ct => ct.name === mod.case_type)
      if (caseType) return getDummyCases(caseType)[0]?.properties
    }
    return undefined
  }, [caseId, mod?.case_type, form?.type, blueprint.case_types])

  const engine = useFormEngine(
    form!,
    blueprint.case_types ?? undefined,
    mod?.case_type ?? undefined,
    caseData,
    builder?.mutationCount,
  )

  // Reset validation when leaving test mode so fields start clean on re-entry
  const prevModeRef = useRef(mode)
  useEffect(() => {
    if (prevModeRef.current === 'test' && mode !== 'test') {
      engine.resetValidation()
    }
    prevModeRef.current = mode
  }, [mode, engine])

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

  // Followup form with no case data at all (no case type configured, no dummy data available)
  if (mode === 'test' && form.type === 'followup' && !caseData) {
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
      const dest = form.post_submit ?? 'default'
      switch (dest) {
        case 'module':
        case 'parent_module':
          if (onNavigate) onNavigate({ type: 'module', moduleIndex })
          else onBack()
          break
        case 'root':
        case 'default':
          if (onNavigate) onNavigate({ type: 'home' })
          else onBack()
          break
        case 'previous':
        default:
          onBack()
          break
      }
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
          {mode === 'edit' && builder?.mb ? (
            <FormTypeButton
              form={form}
              moduleIndex={moduleIndex}
              formIndex={formIndex}
              mb={builder.mb}
              notifyBlueprintChanged={builder.notifyBlueprintChanged}
            />
          ) : (
            <Icon icon={formTypeIcons[form.type] ?? formTypeIcons.survey} width="18" height="18" className="text-nova-text-muted shrink-0" />
          )}
          {mode === 'edit' && builder?.mb ? (
            <EditableTitle value={form.name} onSave={(name) => { builder.mb!.updateForm(moduleIndex, formIndex, { name }); builder.notifyBlueprintChanged() }} onSaved={handleTitleSaved} />
          ) : (
            <h2 className="text-lg font-display font-semibold text-nova-text">{form.name}</h2>
          )}
          {mode === 'edit' && builder && (
            <FormSettingsButton
              form={form}
              moduleIndex={moduleIndex}
              formIndex={formIndex}
              mb={builder.mb!}
              notifyBlueprintChanged={builder.notifyBlueprintChanged}
            />
          )}
          <SavedCheck visible={titleSaved} />
          {mode === 'test' && (
            <button
              onClick={() => engine.reset()}
              className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 text-sm text-nova-text-muted hover:text-nova-text hover:bg-white/5 transition-colors cursor-pointer rounded"
            >
              <Icon icon={ciArrowReload02} width="14" height="14" />
              Reset
            </button>
          )}
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

      {/* Bottom bar — hidden in design mode where it's non-functional */}
      {mode === 'test' && (
        <div className="px-6 py-3 border-t border-pv-input-border bg-pv-surface">
          <button
            onClick={handleSubmit}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-pv-accent text-white hover:brightness-110 transition-all cursor-pointer"
          >
            Submit
          </button>
        </div>
      )}
    </>
  )

  return (
    <div className="h-full" onClick={() => builder?.select()}>
      <div className="flex flex-col h-full max-w-3xl mx-auto w-full">
        {builder ? (
          <EditContextProvider builder={builder} moduleIndex={moduleIndex} formIndex={formIndex} mode={mode}>
            {formBody}
          </EditContextProvider>
        ) : (
          formBody
        )}
      </div>
    </div>
  )
}
