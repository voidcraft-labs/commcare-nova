'use client'
import { useState, useCallback, useMemo } from 'react'
import type { PreviewScreen } from '@/lib/preview/engine/types'
import { screensEqual } from '@/lib/preview/engine/types'
import type { AppBlueprint } from '@/lib/schemas/blueprint'
import { getCaseData } from '@/lib/preview/engine/dummyData'

const MAX_HISTORY = 50

interface NavHistoryState {
  entries: PreviewScreen[]
  cursor: number
}

export function usePreviewNav(blueprint?: AppBlueprint) {
  const [state, setState] = useState<NavHistoryState>({
    entries: [{ type: 'home' }],
    cursor: 0,
  })

  const current = state.entries[state.cursor]
  const canGoBack = state.cursor > 0

  // Unconditional push — always adds to history, clears forward entries
  const push = useCallback((screen: PreviewScreen) => {
    setState(prev => {
      const newEntries = [...prev.entries.slice(0, prev.cursor + 1), screen]
      if (newEntries.length > MAX_HISTORY) {
        return { entries: newEntries.slice(newEntries.length - MAX_HISTORY), cursor: MAX_HISTORY - 1 }
      }
      return { entries: newEntries, cursor: prev.cursor + 1 }
    })
  }, [])

  // Idempotent push — skips if already on the target screen
  const pushIfDifferent = useCallback((screen: PreviewScreen) => {
    setState(prev => {
      if (screensEqual(prev.entries[prev.cursor], screen)) return prev
      const newEntries = [...prev.entries.slice(0, prev.cursor + 1), screen]
      if (newEntries.length > MAX_HISTORY) {
        return { entries: newEntries.slice(newEntries.length - MAX_HISTORY), cursor: MAX_HISTORY - 1 }
      }
      return { entries: newEntries, cursor: prev.cursor + 1 }
    })
  }, [])

  // ── Typed navigation methods ────────────────────────────────────────

  const navigateToHome = useCallback(() => {
    pushIfDifferent({ type: 'home' })
  }, [pushIfDifferent])

  const navigateToModule = useCallback((moduleIndex: number) => {
    pushIfDifferent({ type: 'module', moduleIndex })
  }, [pushIfDifferent])

  const navigateToForm = useCallback((moduleIndex: number, formIndex: number, caseId?: string) => {
    pushIfDifferent({ type: 'form', moduleIndex, formIndex, caseId })
  }, [pushIfDifferent])

  const navigateToCaseList = useCallback((moduleIndex: number, formIndex: number) => {
    pushIfDifferent({ type: 'caseList', moduleIndex, formIndex })
  }, [pushIfDifferent])

  // Go back one step in history, returns the new current screen
  const back = useCallback((): PreviewScreen | undefined => {
    let newScreen: PreviewScreen | undefined
    setState(prev => {
      if (prev.cursor <= 0) return prev
      newScreen = prev.entries[prev.cursor - 1]
      return { ...prev, cursor: prev.cursor - 1 }
    })
    return newScreen
  }, [])

  // Derive breadcrumb from current screen (hierarchical path, not history)
  const { breadcrumb, breadcrumbPath } = useMemo(() => {
    if (!blueprint) return { breadcrumb: [] as string[], breadcrumbPath: [] as PreviewScreen[] }

    const labels: string[] = []
    const screens: PreviewScreen[] = []

    // Home is always first
    screens.push({ type: 'home' })
    labels.push(blueprint.app_name)

    if (current.type === 'home') return { breadcrumb: labels, breadcrumbPath: screens }

    // All other types have moduleIndex
    const mod = blueprint.modules[current.moduleIndex]
    screens.push({ type: 'module', moduleIndex: current.moduleIndex })
    labels.push(mod?.name ?? 'Module')

    if (current.type === 'module') return { breadcrumb: labels, breadcrumbPath: screens }

    if (current.type === 'caseList') {
      screens.push(current)
      labels.push(mod?.forms[current.formIndex]?.name ?? 'Form')
      return { breadcrumb: labels, breadcrumbPath: screens }
    }

    if (current.type === 'form') {
      const caseName = current.caseId && mod?.case_type
        ? getCaseData(mod.case_type, current.caseId)?.get('case_name')
        : undefined
      if (caseName) {
        // Followup form with case data — form name at caseList level, case name at form level
        screens.push({ type: 'caseList', moduleIndex: current.moduleIndex, formIndex: current.formIndex })
        labels.push(mod?.forms[current.formIndex]?.name ?? 'Form')
        screens.push(current)
        labels.push(caseName)
      } else {
        screens.push(current)
        labels.push(mod?.forms[current.formIndex]?.name ?? 'Form')
      }
    }

    return { breadcrumb: labels, breadcrumbPath: screens }
  }, [current, blueprint])

  // Navigate to a breadcrumb level (ancestor screen)
  const navigateTo = useCallback((index: number) => {
    if (index < breadcrumbPath.length - 1) {
      push(breadcrumbPath[index])
    }
  }, [breadcrumbPath, push])

  return {
    current,
    canGoBack,
    push,
    back,
    navigateToHome,
    navigateToModule,
    navigateToForm,
    navigateToCaseList,
    navigateTo,
    breadcrumb,
    breadcrumbPath,
  }
}
