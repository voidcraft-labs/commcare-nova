'use client'
import { useState, useCallback, useMemo } from 'react'
import type { PreviewScreen } from '@/lib/preview/engine/types'
import type { AppBlueprint } from '@/lib/schemas/blueprint'

export function usePreviewNav(blueprint: AppBlueprint | null) {
  const [stack, setStack] = useState<PreviewScreen[]>([{ type: 'home' }])

  const current = stack[stack.length - 1]
  const canGoBack = stack.length > 1

  const push = useCallback((screen: PreviewScreen) => {
    setStack(prev => [...prev, screen])
  }, [])

  const back = useCallback(() => {
    setStack(prev => prev.length > 1 ? prev.slice(0, -1) : prev)
  }, [])

  const navigateTo = useCallback((index: number) => {
    setStack(prev => index < prev.length - 1 ? prev.slice(0, index + 1) : prev)
  }, [])

  const reset = useCallback(() => {
    setStack([{ type: 'home' }])
  }, [])

  const breadcrumb = useMemo(() => {
    if (!blueprint) return []
    const parts: string[] = []
    for (const screen of stack) {
      switch (screen.type) {
        case 'home':
          parts.push(blueprint.app_name)
          break
        case 'module':
          parts.push(blueprint.modules[screen.moduleIndex]?.name ?? 'Module')
          break
        case 'caseList': {
          const clMod = blueprint.modules[screen.moduleIndex]
          const formName = clMod?.forms[screen.formIndex]?.name ?? 'Form'
          parts.push(formName)
          break
        }
        case 'form': {
          const mod = blueprint.modules[screen.moduleIndex]
          parts.push(mod?.forms[screen.formIndex]?.name ?? 'Form')
          break
        }
      }
    }
    return parts
  }, [stack, blueprint])

  return { current, push, back, reset, navigateTo, canGoBack, breadcrumb }
}
