/**
 * Shared hook for saving a single question field. Used by all three contextual
 * editor tabs (UI, Logic, Data) to avoid duplicating the same mutation + notify
 * boilerplate. Converts empty strings to null (removal).
 */

import { useCallback } from 'react'
import type { SelectedElement } from '@/lib/services/builder'
import type { MutableBlueprint } from '@/lib/services/mutableBlueprint'

export function useSaveQuestion(
  selected: SelectedElement,
  mb: MutableBlueprint,
  notifyBlueprintChanged: () => void,
): (field: string, value: string | null) => void {
  return useCallback((field: string, value: string | null) => {
    if (selected.formIndex === undefined || !selected.questionPath) return
    mb.updateQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath, {
      [field]: value === '' ? null : value,
    })
    notifyBlueprintChanged()
  }, [mb, selected.moduleIndex, selected.formIndex, selected.questionPath, notifyBlueprintChanged])
}
