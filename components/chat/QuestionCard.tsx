'use client'
import { motion, AnimatePresence } from 'motion/react'
import type { ClarifyingQuestion } from '@/lib/schemas/chat'
import type { ActiveQuestionState } from '@/hooks/useChat'
import { Badge } from '@/components/ui/Badge'

interface QuestionCardProps {
  questions: ClarifyingQuestion[]
  /** Non-null while the stepper is active for this card */
  activeState: ActiveQuestionState | null
  /** All answers once completed (from message or activeState) */
  completedAnswers?: Record<string, string>
  onSelectOption: (questionText: string, optionLabel: string) => void
}

export function QuestionCard({
  questions,
  activeState,
  completedAnswers,
  onSelectOption,
}: QuestionCardProps) {
  const isActive = activeState !== null
  const answers = completedAnswers || activeState?.answers || {}
  const currentIndex = activeState?.currentIndex ?? questions.length

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] w-full rounded-xl border border-nova-violet/20 bg-nova-violet/5 overflow-hidden">
        {/* Header */}
        <div className="px-3.5 py-2.5 border-b border-nova-violet/10 flex items-center justify-between">
          <span className="text-sm font-medium text-nova-text-secondary">
            {questions[0]?.header || 'A few questions...'}
          </span>
          {isActive && (
            <Badge variant="violet">
              {currentIndex + 1} of {questions.length}
            </Badge>
          )}
        </div>

        {/* Questions */}
        <div className="px-3.5 py-3 space-y-3">
          {questions.map((q, i) => {
            const answer = answers[q.question]
            const isCurrent = isActive && i === currentIndex
            const isPast = i < currentIndex
            const isFuture = isActive && i > currentIndex

            if (isFuture) return null

            return (
              <div key={q.question}>
                {/* Answered question */}
                {isPast && answer && (
                  <div className="flex items-start gap-2 text-xs">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="mt-0.5 shrink-0">
                      <path d="M2.5 7.5l3 3 6-7" stroke="var(--nova-emerald)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <div>
                      <span className="text-nova-text-muted">{q.question}</span>
                      <span className="ml-1.5 text-nova-text">{answer}</span>
                    </div>
                  </div>
                )}

                {/* Completed (non-active) answered question */}
                {!isActive && answer && (
                  <div className="flex items-start gap-2 text-xs">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="mt-0.5 shrink-0">
                      <path d="M2.5 7.5l3 3 6-7" stroke="var(--nova-emerald)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <div>
                      <span className="text-nova-text-muted">{q.question}</span>
                      <span className="ml-1.5 text-nova-text">{answer}</span>
                    </div>
                  </div>
                )}

                {/* Active question with options */}
                {isCurrent && (
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.2 }}
                    >
                      <p className="text-sm text-nova-text mb-2.5">{q.question}</p>
                      <div className="space-y-1.5">
                        {q.options.map((opt) => (
                          <motion.button
                            key={opt.label}
                            whileHover={{ scale: 1.01 }}
                            whileTap={{ scale: 0.99 }}
                            onClick={() => onSelectOption(q.question, opt.label)}
                            className="w-full text-left px-3 py-2 rounded-lg border border-nova-border bg-nova-surface hover:border-nova-violet/40 hover:bg-nova-violet/5 transition-colors cursor-pointer"
                          >
                            <div className="text-sm text-nova-text">{opt.label}</div>
                            {opt.description && (
                              <div className="text-xs text-nova-text-muted mt-0.5">{opt.description}</div>
                            )}
                          </motion.button>
                        ))}
                      </div>
                    </motion.div>
                  </AnimatePresence>
                )}
              </div>
            )
          })}
        </div>

        {/* Footer */}
        {isActive && (
          <div className="px-3.5 py-2 border-t border-nova-violet/10">
            <span className="text-xs text-nova-text-muted">
              or respond with a chat message
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
