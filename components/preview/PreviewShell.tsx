'use client'
import { AnimatePresence, motion } from 'motion/react'
import type { AppBlueprint } from '@/lib/schemas/blueprint'
import type { Builder } from '@/lib/services/builder'
import type { EditMode } from '@/hooks/useEditContext'
import { usePreviewNav } from '@/hooks/usePreviewNav'
import { PreviewHeader } from './PreviewHeader'
import { SCREEN_TRANSITION } from './screenTransition'
import { HomeScreen } from './screens/HomeScreen'
import { ModuleScreen } from './screens/ModuleScreen'
import { CaseListScreen } from './screens/CaseListScreen'
import { FormScreen } from './screens/FormScreen'

interface PreviewShellProps {
  blueprint: AppBlueprint
  actions?: React.ReactNode
  builder?: Builder
  mode?: EditMode
  nav?: ReturnType<typeof usePreviewNav>
  hideHeader?: boolean
  onBack?: () => void
  onUp?: () => void
}

export function PreviewShell({ blueprint, actions, builder, mode = 'edit', nav: navProp, hideHeader, onBack, onUp }: PreviewShellProps) {
  const ownNav = usePreviewNav(blueprint)
  const nav = navProp ?? ownNav
  const handleBack = onBack ?? nav.back
  const handleUp = onUp ?? nav.navigateUp

  return (
    <div className={`preview-theme ${mode === 'edit' ? 'design-theme' : ''} h-full flex flex-col`}>
      {!hideHeader && (
        <PreviewHeader
          breadcrumb={nav.breadcrumb}
          canGoBack={nav.canGoBack}
          canGoUp={nav.canGoUp}
          onBack={nav.back}
          onUp={nav.navigateUp}
          onBreadcrumbClick={nav.navigateTo}
          actions={actions}
        />
      )}

      <div data-preview-scroll-container className="flex-1 overflow-y-auto overflow-x-hidden bg-pv-bg">
        <AnimatePresence mode="wait">
          <motion.div
            key={JSON.stringify(nav.current)}
            initial={SCREEN_TRANSITION.initial}
            animate={SCREEN_TRANSITION.animate}
            exit={SCREEN_TRANSITION.exit}
            transition={SCREEN_TRANSITION.transition}
            className="h-full"
          >
            {nav.current.type === 'home' && (
              <HomeScreen blueprint={blueprint} onNavigate={nav.push} canGoBack={nav.canGoBack} canGoUp={nav.canGoUp} onBack={handleBack} onUp={handleUp} builder={builder} mode={mode} />
            )}
            {nav.current.type === 'module' && (
              <ModuleScreen
                blueprint={blueprint}
                moduleIndex={nav.current.moduleIndex}
                onNavigate={nav.push}
                canGoBack={nav.canGoBack}
                canGoUp={nav.canGoUp}
                onBack={handleBack}
                onUp={handleUp}
                builder={builder}
                mode={mode}
              />
            )}
            {nav.current.type === 'caseList' && (
              <CaseListScreen
                blueprint={blueprint}
                moduleIndex={nav.current.moduleIndex}
                formIndex={nav.current.formIndex}
                onNavigate={nav.push}
                canGoBack={nav.canGoBack}
                canGoUp={nav.canGoUp}
                onBack={handleBack}
                onUp={handleUp}
              />
            )}
            {nav.current.type === 'form' && (
              <FormScreen
                blueprint={blueprint}
                moduleIndex={nav.current.moduleIndex}
                formIndex={nav.current.formIndex}
                caseId={nav.current.caseId}
                onBack={handleBack}
                onUp={handleUp}
                onNavigate={nav.push}
                canGoBack={nav.canGoBack}
                canGoUp={nav.canGoUp}
                builder={builder}
                mode={mode}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}
