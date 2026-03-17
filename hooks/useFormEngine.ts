'use client'
import { useMemo, useState, useEffect } from 'react'
import { FormEngine } from '@/lib/preview/engine/formEngine'
import type { BlueprintForm, CaseType } from '@/lib/schemas/blueprint'

/**
 * React hook wrapping FormEngine with subscription-based re-rendering.
 * Same pattern as useBuilder (subscribe + forceUpdate via useState counter).
 */
export function useFormEngine(
  form: BlueprintForm,
  caseTypes: CaseType[] | null,
  moduleCaseType?: string,
  caseData?: Map<string, string>,
): FormEngine {
  const engine = useMemo(
    () => new FormEngine(form, caseTypes, moduleCaseType, caseData),
    [form, caseTypes, moduleCaseType, caseData],
  )

  const [, tick] = useState(0)

  useEffect(() => {
    return engine.subscribe(() => tick(n => n + 1))
  }, [engine])

  return engine
}
