'use client'

interface ToggleProps {
  enabled: boolean
  onToggle: () => void
  variant?: 'default' | 'sub'
}

export function Toggle({ enabled, onToggle, variant = 'default' }: ToggleProps) {
  const isSub = variant === 'sub'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={onToggle}
      className={`relative inline-flex shrink-0 items-center rounded-full transition-colors cursor-pointer ${
        isSub
          ? `h-4 w-7 ${enabled ? 'bg-nova-cyan' : 'bg-nova-border'}`
          : `h-5 w-9 ${enabled ? 'bg-nova-violet' : 'bg-nova-border'}`
      }`}
    >
      <span
        className={`inline-block rounded-full bg-white transition-transform ${
          isSub
            ? `h-2.5 w-2.5 ${enabled ? 'translate-x-[14px]' : 'translate-x-[3px]'}`
            : `h-3.5 w-3.5 ${enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'}`
        }`}
      />
    </button>
  )
}
