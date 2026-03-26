'use client'
import { useState, useCallback, useRef, useLayoutEffect } from 'react'
import { useFloating, offset, flip, shift, autoUpdate, FloatingPortal } from '@floating-ui/react'
import { ConnectLogomark } from '@/components/icons/ConnectLogomark'
import { Toggle } from '@/components/ui/Toggle'
import { useDismissRef } from '@/hooks/useDismissRef'
import type { Builder } from '@/lib/services/builder'

type ConnectType = 'learn' | 'deliver'

interface AppConnectSettingsProps {
  builder: Builder
}

export function AppConnectSettings({ builder }: AppConnectSettingsProps) {
  const [open, setOpen] = useState(false)
  const mb = builder.mb
  const connectType = mb?.getBlueprint().connect_type
  const animRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const { refs, floatingStyles } = useFloating({
    placement: 'bottom-end',
    middleware: [
      offset(8),
      flip(),
      shift({ padding: 12 }),
    ],
    whileElementsMounted: autoUpdate,
  })

  useLayoutEffect(() => {
    if (buttonRef.current) {
      refs.setReference(buttonRef.current)
    }
  }, [refs])

  useLayoutEffect(() => {
    if (open) {
      animRef.current?.animate(
        [
          { opacity: 0, transform: 'scale(0.97) translateY(-4px)' },
          { opacity: 1, transform: 'scale(1) translateY(0)' },
        ],
        { duration: 150, easing: 'ease-out' },
      )
    }
  }, [open])

  const setConnectType = useCallback((type: ConnectType | null) => {
    if (!mb) return
    const bp = mb.getBlueprint()
    if (type) {
      bp.connect_type = type
    } else {
      delete bp.connect_type
    }
    builder.notifyBlueprintChanged()
  }, [mb, builder])

  if (!mb) return null

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer ${
          connectType
            ? 'text-nova-violet-bright hover:bg-nova-violet/10'
            : 'text-nova-text-muted hover:text-nova-text hover:bg-white/5'
        }`}
        aria-label="Connect settings"
      >
        <ConnectLogomark size={16} />
        {connectType && (
          <span className="text-xs font-medium capitalize">{connectType}</span>
        )}
      </button>

      {open && (
        <FloatingPortal>
          <div
            ref={(el) => { animRef.current = el; refs.setFloating(el) }}
            style={floatingStyles}
            className="z-popover"
          >
            <AppConnectPanel
              connectType={connectType}
              setConnectType={setConnectType}
              onClose={() => setOpen(false)}
            />
          </div>
        </FloatingPortal>
      )}
    </>
  )
}

function AppConnectPanel({
  connectType, setConnectType, onClose,
}: {
  connectType: ConnectType | undefined
  setConnectType: (type: ConnectType | null) => void
  onClose: () => void
}) {
  const enabled = !!connectType
  const dismissRef = useDismissRef(onClose)

  return (
    <div
      ref={dismissRef}
      className="w-64 rounded-xl bg-[rgba(10,10,26,0.85)] backdrop-blur-[12px] [-webkit-backdrop-filter:blur(12px)] border border-white/[0.08] shadow-[0_24px_48px_rgba(0,0,0,0.6)]"
    >
      <div className="px-3.5 py-3 space-y-3">
        {/* Toggle */}
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider">
            CommCare Connect
          </span>
          <Toggle enabled={enabled} onToggle={() => setConnectType(enabled ? null : 'learn')} />
        </div>

        {/* Type pills */}
        {enabled && (
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Connect type">
            {(['learn', 'deliver'] as const).map(type => {
              const isActive = connectType === type
              return (
                <button
                  key={type}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  onClick={() => setConnectType(type)}
                  className={`
                    h-[22px] px-2 text-[11px] font-medium rounded-full border outline-none transition-all duration-200 cursor-pointer
                    ${isActive
                      ? 'bg-nova-cyan/10 border-nova-cyan/30 text-nova-cyan-bright shadow-[0_0_6px_rgba(0,210,255,0.1)]'
                      : 'bg-nova-surface border-nova-border/60 text-nova-text-muted hover:border-nova-cyan/50 hover:text-nova-text-secondary'}
                  `}
                >
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
