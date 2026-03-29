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

  // Screen path structure — stable across name edits, only changes on navigation
  const breadcrumbPath = useMemo(() => {
    if (!blueprint) return [] as PreviewScreen[]

    const screens: PreviewScreen[] = [{ type: 'home' }]

    if (current.type === 'home') return screens

    screens.push({ type: 'module', moduleIndex: current.moduleIndex })
    if (current.type === 'module') return screens

    if (current.type === 'caseList') {
      screens.push(current)
      return screens
    }

    if (current.type === 'form') {
      const mod = blueprint.modules[current.moduleIndex]
      const caseName = current.caseId && mod?.case_type
        ? getCaseData(mod.case_type, current.caseId)?.get('case_name')
        : undefined
      if (caseName) {
        screens.push({ type: 'caseList', moduleIndex: current.moduleIndex, formIndex: current.formIndex })
      }
      screens.push(current)
    }

    return screens
  }, [current, blueprint])

  // Labels derived from the live blueprint — not memoized so in-place name
  // mutations are reflected immediately on re-render
  const breadcrumb = deriveBreadcrumbLabels(breadcrumbPath, blueprint)

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

function deriveBreadcrumbLabels(path: PreviewScreen[], blueprint?: AppBlueprint): string[] {
  if (!blueprint) return []
  return path.map((screen, i) => {
    if (screen.type === 'home') return blueprint.app_name
    if (screen.type === 'module') return blueprint.modules[screen.moduleIndex]?.name ?? 'Module'
    if (screen.type === 'caseList') return blueprint.modules[screen.moduleIndex]?.forms[screen.formIndex]?.name ?? 'Form'
    if (screen.type === 'form') {
      // If preceded by caseList, this level shows the case name
      if (i > 0 && path[i - 1].type === 'caseList') {
        const mod = blueprint.modules[screen.moduleIndex]
        return (screen.caseId && mod?.case_type
          ? getCaseData(mod.case_type, screen.caseId)?.get('case_name')
          : undefined) ?? 'Case'
      }
      return blueprint.modules[screen.moduleIndex]?.forms[screen.formIndex]?.name ?? 'Form'
    }
    return ''
  })
}
