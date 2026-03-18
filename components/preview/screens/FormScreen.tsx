'use client'
import { useRef, useMemo } from 'react'
import type { AppBlueprint } from '@/lib/schemas/blueprint'
import type { Builder } from '@/lib/services/builder'
import type { EditMode } from '@/hooks/useEditContext'
import { EditContextProvider } from '@/hooks/useEditContext'
import { useFormEngine } from '@/hooks/useFormEngine'
import { FormRenderer } from '../form/FormRenderer'
import { Badge } from '@/components/ui/Badge'

interface FormScreenProps {
  blueprint: AppBlueprint
  moduleIndex: number
  formIndex: number
  caseData?: Map<string, string>
  onBack: () => void
  builder?: Builder
  mode?: EditMode
}

const formTypeBadge = {
  registration: 'Registration',
  followup: 'Follow-up',
  survey: 'Survey',
} as const

export function FormScreen({ blueprint, moduleIndex, formIndex, caseData, onBack, builder, mode = 'edit' }: FormScreenProps) {
  const mod = blueprint.modules[moduleIndex]
  const form = mod?.forms[formIndex]

  const stableCaseData = useMemo(() => caseData, [caseData])

  const engine = useFormEngine(
    form!,
    blueprint.case_types ?? null,
    mod?.case_type ?? undefined,
    stableCaseData,
    builder?.mutationCount,
  )

  const formBodyRef = useRef<HTMLDivElement>(null)

  if (!form) {
    return (
      <div className="p-6 text-center text-nova-text-muted">
        Form not found.
      </div>
    )
  }

  const questions = engine.getQuestions()

  const handleSubmit = () => {
    const valid = engine.validateAll()
    if (valid) {
      onBack()
    } else {
      const errorEl = formBodyRef.current?.querySelector('[data-invalid="true"]')
      errorEl?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  const formBody = (
    <>
      {/* Form header */}
      <div className="px-6 pt-5 pb-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-display font-semibold text-nova-text">{form.name}</h2>
          <Badge variant="muted">
            {formTypeBadge[form.type as keyof typeof formTypeBadge] ?? form.type}
          </Badge>
        </div>
      </div>

      {/* Form body */}
      <div ref={formBodyRef} className="flex-1 overflow-auto px-6 py-6" style={{ scrollbarGutter: 'stable' }}>
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
    <div className="flex flex-col h-full">
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
