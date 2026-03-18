'use client'
import { useMemo, useState, useEffect, useRef } from 'react'
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
  // Persist live values across engine recreations so edits in preview don't wipe test data
  const liveSnapshotRef = useRef<{ values: Map<string, string>, touched: Set<string> } | undefined>(undefined)
  const prevEngineRef = useRef<FormEngine | undefined>(undefined)

  const engine = useMemo(() => {
    // Snapshot values from previous engine before creating new one
    if (prevEngineRef.current) {
      liveSnapshotRef.current = prevEngineRef.current.getValueSnapshot()
    }

    const newEngine = new FormEngine(form, caseTypes, moduleCaseType, caseData)

    // Restore values if we have a snapshot
    if (liveSnapshotRef.current) {
      newEngine.restoreValues(liveSnapshotRef.current)
    }

    return newEngine
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, caseTypes, moduleCaseType, caseData, mutationCount])

  prevEngineRef.current = engine

  const [, tick] = useState(0)

  useEffect(() => {
    return engine.subscribe(() => tick(n => n + 1))
  }, [engine])

  return engine
}
