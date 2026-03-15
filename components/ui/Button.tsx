'use client'
import { motion } from 'motion/react'
import { forwardRef } from 'react'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  children: React.ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className = '', children, ...props }, ref) => {
    const base = 'inline-flex items-center justify-center font-medium transition-all duration-200 rounded-lg cursor-pointer border disabled:opacity-40 disabled:cursor-not-allowed'

    const variants = {
      primary: 'bg-nova-violet text-white border-transparent hover:bg-nova-violet-bright shadow-[var(--nova-glow-violet)] hover:shadow-[0_0_60px_rgba(139,92,246,0.25)]',
      secondary: 'bg-nova-surface text-nova-text border-nova-border hover:border-nova-border-bright hover:bg-nova-elevated',
      ghost: 'text-nova-text-secondary border-transparent hover:text-nova-text hover:bg-nova-surface',
    }

    const sizes = {
      sm: 'px-3 py-1.5 text-sm gap-1.5',
      md: 'px-4 py-2.5 text-sm leading-6 gap-2',
      lg: 'px-6 py-3 text-base gap-2',
    }

    return (
      <motion.button
        ref={ref}
        whileTap={{ scale: 0.98 }}
        className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
        {...(props as any)}
      >
        {children}
      </motion.button>
    )
  }
)
Button.displayName = 'Button'
