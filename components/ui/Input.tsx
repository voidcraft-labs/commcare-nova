'use client'
import { forwardRef } from 'react'

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

/**
 * Styled text input with optional label. Always wraps in `<label>` so the
 * input is implicitly associated — no `htmlFor`/`id` wiring needed, and
 * clicking anywhere in the label area focuses the input.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, className = '', ...props }, ref) => (
    <label className="flex flex-col gap-1.5">
      {label && (
        <span className="text-sm text-nova-text-secondary font-medium">
          {label}
        </span>
      )}
      <input
        ref={ref}
        autoComplete="off"
        data-1p-ignore
        className={`w-full px-4 py-2.5 bg-nova-deep border border-nova-border rounded-lg text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:border-nova-violet focus:shadow-[var(--nova-glow-violet)] transition-all duration-200 ${className}`}
        {...props}
      />
    </label>
  )
)
Input.displayName = 'Input'
