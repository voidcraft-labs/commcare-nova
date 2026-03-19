'use client'
import { forwardRef } from 'react'

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, className = '', ...props }, ref) => {
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label className="text-sm text-nova-text-secondary font-medium">
            {label}
          </label>
        )}
        <input
          ref={ref}
          autoComplete="off"
          data-1p-ignore
          className={`w-full px-4 py-2.5 bg-nova-deep border border-nova-border rounded-lg text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:border-nova-violet focus:shadow-[var(--nova-glow-violet)] transition-all duration-200 ${className}`}
          {...props}
        />
      </div>
    )
  }
)
Input.displayName = 'Input'
