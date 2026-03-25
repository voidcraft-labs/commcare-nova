'use client'

interface CasePropertyPillsProps {
  value: string | undefined
  isCaseName: boolean
  disabled: boolean
  caseTypes: string[]
  onChange: (caseType: string | null) => void
}

export function CasePropertyPills({ value, isCaseName, disabled, caseTypes, onChange }: CasePropertyPillsProps) {
  const locked = isCaseName
  const isInteractive = !disabled && !locked

  if (caseTypes.length === 0 && !isCaseName) return null

  return (
    <div role="radiogroup" aria-label="Save to case type">
      <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">Saves to</label>
      <div className="flex items-center gap-1.5">
      {caseTypes.map(ct => {
        const isActive = value === ct
        return (
          <button
            key={ct}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-disabled={!isInteractive || undefined}
            onClick={() => {
              if (!isInteractive) return
              onChange(isActive ? null : ct)
            }}
            className={`
              h-[22px] px-2 text-[11px] font-medium rounded-full border outline-none transition-all duration-200
              ${isActive
                ? 'bg-nova-cyan/10 border-nova-cyan/30 text-nova-cyan-bright shadow-[0_0_6px_rgba(0,210,255,0.1)]'
                : 'bg-nova-surface border-nova-border/60 text-nova-text-muted'}
              ${!isInteractive
                ? `${locked && isActive ? 'opacity-70' : 'opacity-50'} cursor-not-allowed`
                : `cursor-pointer ${!isActive ? 'hover:border-nova-cyan/50 hover:text-nova-text-secondary' : ''}`}
            `}
          >
            {ct}
          </button>
        )
      })}
      </div>
    </div>
  )
}
