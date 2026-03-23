'use client'
import { motion } from 'motion/react'
import { Icon } from '@iconify/react'
import ciMoreGridBig from '@iconify-icons/ci/more-grid-big'
import ciChevronLeft from '@iconify-icons/ci/chevron-left'
import type { AppBlueprint } from '@/lib/schemas/blueprint'
import type { PreviewScreen } from '@/lib/preview/engine/types'
import { Badge } from '@/components/ui/Badge'

interface HomeScreenProps {
  blueprint: AppBlueprint
  onNavigate: (screen: PreviewScreen) => void
  canGoBack?: boolean
  onBack?: () => void
}

export function HomeScreen({ blueprint, onNavigate, canGoBack, onBack }: HomeScreenProps) {
  return (
    <div className="p-6 space-y-4 max-w-3xl mx-auto">
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          disabled={!canGoBack}
          className={`p-1.5 -ml-1.5 rounded-md shrink-0 transition-colors ${canGoBack ? 'text-nova-text-muted hover:text-nova-text hover:bg-pv-elevated cursor-pointer' : 'text-nova-text-muted/30 cursor-default'}`}
        >
          <Icon icon={ciChevronLeft} width="20" height="20" />
        </button>
        <h2 className="text-lg font-display font-semibold text-nova-text">{blueprint.app_name}</h2>
      </div>
      <div className="grid gap-3">
        {blueprint.modules.map((mod, mIdx) => (
          <motion.button
            key={mIdx}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: mIdx * 0.06, duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            onClick={() => onNavigate({ type: 'module', moduleIndex: mIdx })}
            className="w-full flex items-center gap-4 p-4 rounded-xl bg-pv-surface border border-pv-input-border hover:border-pv-input-focus hover:translate-y-[-1px] transition-all duration-200 cursor-pointer text-left group"
          >
            <div className="w-10 h-10 rounded-lg bg-pv-accent/10 flex items-center justify-center shrink-0">
              <Icon icon={ciMoreGridBig} width="20" height="20" className="text-pv-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-nova-text group-hover:text-pv-accent-bright transition-colors">
                {mod.name}
              </div>
              {mod.case_type && (
                <Badge variant="muted" className="mt-1">
                  {mod.case_type}
                </Badge>
              )}
            </div>
            <span className="text-xs text-nova-text-muted shrink-0">
              {mod.forms.length} form{mod.forms.length !== 1 ? 's' : ''}
            </span>
          </motion.button>
        ))}
      </div>
    </div>
  )
}
