import { Icon } from '@iconify/react/offline'
import ciAddPlus from '@iconify-icons/ci/add-plus'

interface AddPropertyButtonProps {
  label: string
  onClick: () => void
  className?: string
}

/** Small pill button with a "+" icon, used to add optional properties/fields. */
export function AddPropertyButton({ label, onClick, className = '' }: AddPropertyButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs text-nova-text-muted hover:text-nova-text-secondary bg-nova-surface hover:bg-nova-elevated border border-nova-border/40 rounded transition-colors cursor-pointer ${className}`}
    >
      <Icon icon={ciAddPlus} width="10" height="10" />
      {label}
    </button>
  )
}
