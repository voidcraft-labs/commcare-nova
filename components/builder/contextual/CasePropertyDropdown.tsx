'use client'
import { useCallback, useId, useMemo } from 'react'
import tablerCircleOff from '@iconify-icons/tabler/circle-off'
import tablerDatabase from '@iconify-icons/tabler/database'
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/DropdownMenu'
import { useFloatingDropdown, DropdownPortal } from '@/hooks/useFloatingDropdown'

interface CasePropertyDropdownProps {
  value: string | undefined
  isCaseName: boolean
  disabled: boolean
  caseTypes: string[]
  onChange: (caseType: string | null) => void
}

/**
 * Dropdown for selecting which case type a question's value is saved to.
 * Options: "None" (no persistence) + one entry per writable case type.
 * Matches the AfterSubmitSection select-style pattern: full-width trigger
 * button with chevron, portal-rendered DropdownMenu with active highlight.
 */
export function CasePropertyDropdown({ value, isCaseName, disabled, caseTypes, onChange }: CasePropertyDropdownProps) {
  const isInteractive = !disabled && !isCaseName

  const triggerId = useId()

  /* All hooks must be called before the early return (rules of hooks). */
  const dd = useFloatingDropdown<HTMLButtonElement>({
    placement: 'bottom-start',
    offset: 4,
    matchTriggerWidth: true,
  })
  const { close } = dd

  const handleSelect = useCallback((caseType: string | null) => {
    onChange(caseType)
    close()
  }, [onChange, close])

  const items: DropdownMenuItem[] = useMemo(() => {
    const result: DropdownMenuItem[] = [
      {
        key: '__none__',
        label: 'None',
        description: 'Don\'t save to a case',
        icon: tablerCircleOff,
        onClick: () => handleSelect(null),
      },
    ]
    for (const ct of caseTypes) {
      result.push({
        key: ct,
        label: ct,
        description: ct === caseTypes[0] ? 'Primary case type' : 'Child case type',
        icon: tablerDatabase,
        onClick: () => handleSelect(ct),
      })
    }
    return result
  }, [caseTypes, handleSelect])

  /* Hide entirely when no case types exist and this isn't a case_name question */
  if (caseTypes.length === 0 && !isCaseName) return null

  const activeKey = value ?? '__none__'
  const displayLabel = value ?? 'None'

  return (
    <div>
      <label htmlFor={triggerId} className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">
        Saves to
      </label>
      <button
        id={triggerId}
        type="button"
        ref={dd.triggerRef}
        onClick={isInteractive ? dd.toggle : undefined}
        aria-label={`Saves to: ${displayLabel}`}
        disabled={!isInteractive}
        className={`w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-md border transition-colors ${
          isInteractive
            ? 'cursor-pointer text-nova-text bg-transparent border-white/[0.06] hover:border-white/[0.12]'
            : `${isCaseName && value ? 'opacity-70' : 'opacity-50'} cursor-not-allowed text-nova-text bg-transparent border-white/[0.06]`
        }`}
      >
        <span className={value ? 'text-nova-cyan-bright' : 'text-nova-text-muted'}>{displayLabel}</span>
        {isInteractive && (
          <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" className={`text-nova-text-muted transition-transform ${dd.open ? 'rotate-180' : ''}`}>
            <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      <DropdownPortal dropdown={dd}>
        <DropdownMenu items={items} activeKey={activeKey} />
      </DropdownPortal>
    </div>
  )
}
