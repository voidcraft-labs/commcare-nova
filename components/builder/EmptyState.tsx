'use client'
import { motion } from 'motion/react'

export function EmptyState({ onOpenChat }: { onOpenChat: () => void }) {
  return (
    <div className="h-full flex items-center justify-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="text-center max-w-md"
      >
        {/* Cosmic icon */}
        <div className="relative inline-flex mb-6">
          <div className="w-16 h-16 rounded-2xl bg-nova-surface border border-nova-border flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-nova-violet-bright">
              <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="absolute -inset-4 bg-nova-violet/5 rounded-3xl blur-xl" />
        </div>

        <h2 className="text-xl font-display font-semibold text-nova-text mb-2">
          Describe your app
        </h2>
        <p className="text-nova-text-secondary text-sm leading-relaxed mb-6">
          Tell Nova what you want to build. Describe the workflows,
          data you need to collect, and who will use it.
        </p>
        <button
          onClick={onOpenChat}
          className="text-sm text-nova-violet-bright hover:text-nova-violet transition-colors"
        >
          Open chat to get started &rarr;
        </button>
      </motion.div>
    </div>
  )
}
