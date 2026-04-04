'use client'
import { useRef, useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { FormEngine } from '@/lib/preview/engine/formEngine'
import type { BlueprintForm, CaseType } from '@/lib/schemas/blueprint'

/**
 * React hook wrapping FormEngine with subscription-based re-rendering.
 * Persists live-mode values across engine recreations (caused by blueprint mutations).
 */
export function useFormEngine(
  form: BlueprintForm,
  caseTypes?: CaseType[],
  moduleCaseType?: string,
  caseData?: Map<string, string>,
  mutationCount?: number,
): FormEngine {
  // Persist live values across engine recreations so edits in preview don't wipe test data.
  // Engine is recreated when any input changes OR when mutationCount bumps (the mutable
  // blueprint was edited in place). Prev-ref comparison handles the cache-busting that
  // useMemo can't express with mutable references.
  const liveSnapshotRef = useRef<{ values: Map<string, string>, touched: Set<string> } | undefined>(undefined)
  const engineRef = useRef<FormEngine | undefined>(undefined)
  const prevMutationCountRef = useRef(mutationCount)
  const prevFormRef = useRef(form)
  const prevCaseTypesRef = useRef(caseTypes)
  const prevModuleCaseTypeRef = useRef(moduleCaseType)
  const prevCaseDataRef = useRef(caseData)

  if (
    !engineRef.current
    || prevMutationCountRef.current !== mutationCount
    || prevFormRef.current !== form
    || prevCaseTypesRef.current !== caseTypes
    || prevModuleCaseTypeRef.current !== moduleCaseType
    || prevCaseDataRef.current !== caseData
  ) {
    // Snapshot values from previous engine before creating new one
    if (engineRef.current) {
      liveSnapshotRef.current = engineRef.current.getValueSnapshot()
    }

    const newEngine = new FormEngine(form, caseTypes, moduleCaseType, caseData)

    // Restore values if we have a snapshot
    if (liveSnapshotRef.current) {
      newEngine.restoreValues(liveSnapshotRef.current)
    }

    engineRef.current = newEngine
    prevMutationCountRef.current = mutationCount
    prevFormRef.current = form
    prevCaseTypesRef.current = caseTypes
    prevModuleCaseTypeRef.current = moduleCaseType
    prevCaseDataRef.current = caseData
  }

  const engine = engineRef.current!

  // Re-render when the engine notifies (value changes, validation, etc.)
  // Wrapped in useCallback because engine identity changes on deps
  const subscribe = useCallback((cb: () => void) => engine.subscribe(cb), [engine])
  const getSnapshot = useCallback(() => engine.getSnapshot(), [engine])
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return engine
}
