'use client'
import { useState, useRef } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react/offline'
import ciCheck from '@iconify-icons/ci/check'
import { Badge } from '@/components/ui/Badge'

interface QuestionInput {
  header: string
  questions: {
    question: string
    options: { label: string; description?: string }[]
  }[]
}

interface QuestionCardProps {
  toolCallId: string
  input: QuestionInput
  state: string
  output?: Record<string, string>
  addToolOutput: (params: {
    tool: string
    toolCallId: string
    output: unknown
  }) => void
  pendingAnswerRef?: React.MutableRefObject<((text: string) => void) | null>
}

export function QuestionCard({
  toolCallId,
  input,
  state,
  output,
  addToolOutput,
  pendingAnswerRef,
}: QuestionCardProps) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})

  // Refs for stable closure in the pending answer handler
  const stateRef = useRef({ currentIndex, answers })
  stateRef.current = { currentIndex, answers }

  const isWaiting = state === 'input-available'
  const isComplete = state === 'output-available'
  const displayAnswers = isComplete ? (output || {}) : answers
  const questions = input?.questions ?? []
  const isLoading = !isWaiting && !isComplete

  /**
   * Stable ID map for questions within this tool call. Questions arrive from
   * the SA without intrinsic IDs — the `toolCallId` is globally unique, and
   * questions within a tool call are immutable (never reordered/removed).
   * IDs are assigned once on first observation and stored in this ref.
   */
  const questionIds = useRef<string[]>([])
  while (questionIds.current.length < questions.length) {
    const idx = questionIds.current.length
    questionIds.current.push(crypto.randomUUID())
  }

  const applyAnswer = (questionText: string, answerText: string) => {
    const { answers: ans, currentIndex: ci } = stateRef.current
    const newAnswers = { ...ans, [questionText]: answerText }
    setAnswers(newAnswers)
    stateRef.current.answers = newAnswers

    const nextIdx = ci + 1
    if (nextIdx < questions.length) {
      setCurrentIndex(nextIdx)
      stateRef.current.currentIndex = nextIdx
    } else {
      addToolOutput({ tool: 'askQuestions', toolCallId, output: newAnswers })
    }
  }

  // Register handler so ChatSidebar can route typed messages as question answers
  if (pendingAnswerRef) {
    if (isWaiting) {
      pendingAnswerRef.current = (text: string) => {
        const q = questions[stateRef.current.currentIndex]
        if (q) applyAnswer(q.question, `User Responded: ${text}`)
      }
    } else {
      pendingAnswerRef.current = null
    }
  }

  return (
    <div data-question-card={isWaiting ? 'waiting' : isComplete ? 'done' : 'loading'}>
      <div className="rounded-xl border border-nova-violet/20 bg-nova-violet/5 overflow-hidden">
        {/* Header */}
        <div className="px-3.5 py-2.5 border-b border-nova-violet/10">
          {isLoading ? (
            <span className="text-[10px] uppercase tracking-widest text-nova-violet font-medium">
              Questions loading...
            </span>
          ) : isWaiting && (
            <span className="text-[10px] uppercase tracking-widest text-nova-violet font-medium">
              Question {currentIndex + 1} of {questions.length}
            </span>
          )}
          <p className="text-sm font-medium text-nova-text-secondary mt-0.5">
            {input?.header || 'A few questions...'}
          </p>
        </div>

        {/* Questions */}
        <div className="px-3.5 py-3 space-y-3">
          {isLoading && (
            <div className="space-y-2.5 animate-pulse">
              {/* Question text skeleton */}
              <div className="h-4 w-3/4 rounded bg-nova-violet/10" />
              {/* Option skeletons */}
              <div className="space-y-1.5">
                <div className="h-10 w-full rounded-lg border border-nova-border bg-nova-surface/50" />
                <div className="h-10 w-full rounded-lg border border-nova-border bg-nova-surface/50" />
                <div className="h-10 w-full rounded-lg border border-nova-border bg-nova-surface/50" />
              </div>
            </div>
          )}
          {questions.map((q, i) => {
            const answer = displayAnswers[q.question]
            const isCurrent = isWaiting && i === currentIndex
            const isPast = i < currentIndex
            const isFuture = isWaiting && i > currentIndex

            if (isFuture) return null

            return (
              <div key={questionIds.current[i]}>
                {/* Answered question */}
                {(isComplete || isPast) && answer && (
                  <div className="flex items-start gap-2 text-xs">
                    <Icon icon={ciCheck} width="14" height="14" className="mt-0.5 shrink-0" style={{ color: 'var(--nova-emerald)' }} />
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
                      key={questionIds.current[i]}
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
                            onClick={() => applyAnswer(q.question, opt.label)}
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
        {isWaiting && (
          <div className="px-3.5 py-2 border-t border-nova-violet/10">
            <span className="text-xs text-nova-text-muted">
              or type your answer below
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
