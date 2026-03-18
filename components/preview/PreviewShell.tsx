'use client'
import { AnimatePresence, motion } from 'motion/react'
import type { AppBlueprint } from '@/lib/schemas/blueprint'
import type { Builder } from '@/lib/services/builder'
import type { EditMode } from '@/hooks/useEditContext'
import { usePreviewNav } from '@/hooks/usePreviewNav'
import { PreviewHeader } from './PreviewHeader'
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
}

export function PreviewShell({ blueprint, actions, builder, mode = 'edit', nav: navProp, hideHeader }: PreviewShellProps) {
  const ownNav = usePreviewNav(blueprint)
  const nav = navProp ?? ownNav

  return (
    <div className="preview-theme h-full flex flex-col">
      {!hideHeader && (
        <PreviewHeader
          breadcrumb={nav.breadcrumb}
          canGoBack={nav.canGoBack}
          onBack={nav.back}
          onBreadcrumbClick={nav.navigateTo}
          actions={actions}
        />
      )}

      <div className="flex-1 overflow-auto bg-pv-bg">
        <AnimatePresence mode="wait">
          <motion.div
            key={JSON.stringify(nav.current)}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="h-full"
          >
            {nav.current.type === 'home' && (
              <HomeScreen blueprint={blueprint} onNavigate={nav.push} />
            )}
            {nav.current.type === 'module' && (
              <ModuleScreen
                blueprint={blueprint}
                moduleIndex={nav.current.moduleIndex}
                onNavigate={nav.push}
              />
            )}
            {nav.current.type === 'caseList' && (
              <CaseListScreen
                blueprint={blueprint}
                moduleIndex={nav.current.moduleIndex}
                formIndex={nav.current.formIndex}
                onNavigate={nav.push}
              />
            )}
            {nav.current.type === 'form' && (
              <FormScreen
                blueprint={blueprint}
                moduleIndex={nav.current.moduleIndex}
                formIndex={nav.current.formIndex}
                caseData={nav.current.caseData}
                onBack={nav.back}
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
