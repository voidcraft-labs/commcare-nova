'use client'
import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react'
import ciArrowRight from '@iconify-icons/ci/arrow-right-md'
import ciCheckAll from '@iconify-icons/ci/check-all'
import ciWarning from '@iconify-icons/ci/warning'
import { useClaudeCode, getQuestionPreamble } from '@/hooks/useClaudeCode'
import type { StructuredQuestion } from '@/hooks/useClaudeCode'
import { renderMarkdown } from '@/lib/markdown'
import { validateBlueprint } from '@/lib/services/hqJsonExpander'

interface ClaudeCodeChatProps {
  onBlueprintReady: (blueprint: any, messages: { role: string; content: string }[], sessionId: string | null) => void
}

export function ClaudeCodeChat({ onBlueprintReady }: ClaudeCodeChatProps) {
  const { messages, status, error, sendMessage, blueprint, sessionId, usage, elapsedMs } = useClaudeCode()
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const isStreaming = status === 'streaming'
  const lastMessage = messages[messages.length - 1]
  const showThinking = isStreaming && lastMessage?.role === 'assistant' && lastMessage.content === ''

  // Auto-scroll when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleSubmit = useCallback(() => {
    if (!input.trim() || isStreaming) return
    sendMessage(input.trim())
    setInput('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [input, isStreaming, sendMessage])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleInput = () => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 120) + 'px'
    }
  }

  // Validation state: null = not started, 'validating' = running, string[] = errors, 'passed' = clean
  const [validationState, setValidationState] = useState<null | 'validating' | 'passed' | string[]>(null)

  const handleValidate = useCallback(() => {
    if (!blueprint) return
    setValidationState('validating')

    // Run validation (sync function, but use setTimeout to let UI update)
    setTimeout(() => {
      const errors = validateBlueprint(blueprint)
      if (errors.length === 0) {
        setValidationState('passed')
      } else {
        setValidationState(errors)
        // Send errors back to Claude Code to fix
        const errorList = errors.map((e, i) => `${i + 1}. ${e}`).join('\n')
        sendMessage(
          `The blueprint has ${errors.length} validation error${errors.length !== 1 ? 's' : ''}. Please fix them and output the corrected blueprint:\n\n${errorList}`
        )
      }
    }, 100)
  }, [blueprint, sendMessage])

  // Auto-validate when a new blueprint arrives after a fix attempt
  const prevBlueprintRef = useRef<any>(null)
  useEffect(() => {
    if (blueprint && validationState && Array.isArray(validationState) && blueprint !== prevBlueprintRef.current) {
      // New blueprint arrived after we sent fix errors — auto-validate
      prevBlueprintRef.current = blueprint
      handleValidate()
    }
    if (blueprint && !prevBlueprintRef.current) {
      prevBlueprintRef.current = blueprint
    }
  }, [blueprint, validationState, handleValidate])

  const handleOpenInBuilder = useCallback(() => {
    if (!blueprint || validationState !== 'passed') return
    const chatMessages = messages.map(m => ({ role: m.role, content: m.content }))
    onBlueprintReady(blueprint, chatMessages, sessionId)
  }, [blueprint, validationState, messages, sessionId, onBlueprintReady])

  const handleOptionClick = useCallback((answer: string) => {
    if (isStreaming) return
    sendMessage(answer)
  }, [isStreaming, sendMessage])

  return (
    <div className="flex flex-col h-full max-w-2xl mx-auto w-full">
      {/* Messages area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-6 space-y-4"
      >
        {messages.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col items-center justify-center h-full gap-3 text-center pt-16"
          >
            <p className="text-nova-text text-lg font-medium">
              Describe the CommCare app you want to build.
            </p>
            <p className="text-nova-text-muted text-sm">
              Powered by your local Claude Code — no API key needed.
            </p>
          </motion.div>
        ) : (
          <>
            {messages.map((message) => {
              const isUser = message.role === 'user'

              // Hide user messages sent from card clicks (answer already shown in card checkmark)
              if (isUser && message.fromCard) return null

              // Status update (building phase transition)
              if (!isUser && message.statusUpdate) {
                return (
                  <div key={message.id} className="flex justify-center my-4">
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="flex items-center gap-3 px-5 py-3 rounded-full bg-nova-violet/10 border border-nova-violet/20"
                    >
                      <div className="w-2 h-2 rounded-full bg-nova-violet animate-pulse" />
                      <span className="text-sm font-medium text-nova-violet">{message.statusUpdate.message}</span>
                    </motion.div>
                  </div>
                )
              }

              // Structured question card for assistant messages
              if (!isUser && message.structuredQuestion) {
                const preamble = getQuestionPreamble(message.content)
                return (
                  <div key={message.id} className="flex justify-start">
                    <div className="max-w-[85%] w-full space-y-2">
                      {preamble && (
                        <div className="text-sm text-nova-text-muted leading-relaxed">
                          <div
                            className="chat-markdown"
                            dangerouslySetInnerHTML={{ __html: renderMarkdown(preamble) }}
                          />
                        </div>
                      )}
                      <QuestionCardInline
                        question={message.structuredQuestion}
                        onAnswer={(answer) => sendMessage(answer, { fromCard: true })}
                        disabled={isStreaming}
                      />
                    </div>
                  </div>
                )
              }

              return (
                <div
                  key={message.id}
                  className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed ${
                      isUser
                        ? 'bg-nova-violet/20 text-nova-text border border-nova-violet/15'
                        : 'text-nova-text-muted'
                    }`}
                  >
                    {isUser ? (
                      <div className="whitespace-pre-wrap break-words">{message.content}</div>
                    ) : message.content ? (
                      <div
                        className="chat-markdown"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                      />
                    ) : null}
                  </div>
                </div>
              )
            })}

            {/* Streaming indicator with elapsed time */}
            <AnimatePresence>
              {isStreaming && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="flex justify-start"
                >
                  <div className="flex items-center gap-2 text-xs text-nova-text-muted px-1 py-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-nova-violet animate-pulse" />
                    <span>{showThinking ? 'Thinking' : 'Generating'}</span>
                    {elapsedMs > 1000 && (
                      <span className="text-nova-text-muted/50">{Math.floor(elapsedMs / 1000)}s</span>
                    )}
                    {usage.outputTokens > 0 && (
                      <span className="text-nova-text-muted/50">{usage.outputTokens.toLocaleString()} tokens</span>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}

        {/* Error display */}
        {error && (
          <div className="text-center text-sm text-red-400 py-2">
            {error}
          </div>
        )}
      </div>

      {/* Blueprint action banner */}
      <AnimatePresence>
        {blueprint && !isStreaming && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className={`mx-4 mb-3 rounded-lg border px-4 py-3 ${
              validationState === 'passed'
                ? 'border-nova-emerald/30 bg-nova-emerald/10'
                : Array.isArray(validationState)
                  ? 'border-nova-amber/30 bg-nova-amber/10'
                  : 'border-nova-violet/30 bg-nova-violet/10'
            }`}
          >
            {/* State: blueprint detected, not yet validated */}
            {!validationState && (
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm text-nova-violet">
                  <Icon icon={ciCheckAll} width="16" height="16" />
                  <span>Blueprint generated — <strong>{blueprint.app_name}</strong></span>
                </div>
                <button
                  onClick={handleValidate}
                  className="shrink-0 rounded-md bg-nova-violet px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 cursor-pointer"
                >
                  Validate
                </button>
              </div>
            )}

            {/* State: validating */}
            {validationState === 'validating' && (
              <div className="flex items-center gap-2 text-sm text-nova-violet">
                <div className="animate-pulse">Validating blueprint...</div>
              </div>
            )}

            {/* State: validation errors (sent to Claude Code to fix) */}
            {Array.isArray(validationState) && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-nova-amber">
                  <Icon icon={ciWarning} width="16" height="16" />
                  <span>{validationState.length} validation error{validationState.length !== 1 ? 's' : ''} — fixing...</span>
                </div>
                <ul className="text-xs text-nova-text-muted space-y-0.5 list-disc pl-5">
                  {validationState.slice(0, 3).map((e, i) => <li key={i}>{e}</li>)}
                  {validationState.length > 3 && <li>...and {validationState.length - 3} more</li>}
                </ul>
              </div>
            )}

            {/* State: validation passed */}
            {validationState === 'passed' && (
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm text-nova-emerald">
                  <Icon icon={ciCheckAll} width="16" height="16" />
                  <span>Validation passed — <strong>{blueprint.app_name}</strong></span>
                </div>
                <button
                  onClick={handleOpenInBuilder}
                  className="shrink-0 rounded-md bg-nova-emerald px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 cursor-pointer"
                >
                  Open in Builder
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input */}
      <div className="border-t border-nova-border px-4 py-3">
        <div className="flex items-center bg-nova-deep border border-nova-border rounded-lg focus-within:border-nova-violet transition-colors">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => { setInput(e.target.value); handleInput() }}
            onKeyDown={handleKeyDown}
            placeholder="Describe the app you want to build..."
            disabled={isStreaming}
            rows={1}
            autoComplete="off"
            data-1p-ignore
            className="flex-1 resize-none bg-transparent border-none px-4 py-3 text-sm text-nova-text placeholder:text-nova-text-muted focus:outline-none disabled:opacity-50"
          />
          <button
            onClick={handleSubmit}
            disabled={!input.trim() || isStreaming}
            className="shrink-0 mr-2 rounded-md bg-nova-violet p-2 text-white transition-colors hover:bg-nova-violet-bright disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Icon icon={ciArrowRight} width="18" height="18" />
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Inline question card ─────────────────────────────────────────────

function QuestionCardInline({
  question,
  onAnswer,
  disabled,
}: {
  question: StructuredQuestion
  onAnswer: (answer: string) => void
  disabled: boolean
}) {
  const [answered, setAnswered] = useState<string | null>(null)

  const handleClick = (label: string) => {
    if (disabled || answered) return
    setAnswered(label)
    onAnswer(label)
  }

  return (
    <div className="rounded-xl border border-nova-violet/20 bg-nova-violet/5 overflow-hidden">
      {/* Header */}
      <div className="px-3.5 py-2.5 border-b border-nova-violet/10">
        {question.header && (
          <span className="text-[10px] uppercase tracking-widest text-nova-violet font-medium">
            {question.header}
          </span>
        )}
        <p className="text-sm text-nova-text mt-0.5">{question.question}</p>
      </div>

      {/* Options */}
      <div className="px-3.5 py-3 space-y-1.5">
        {answered ? (
          <div className="flex items-center gap-2 text-xs text-nova-text">
            <Icon icon={ciCheckAll} width="14" height="14" className="text-nova-emerald shrink-0" />
            <span>{answered}</span>
          </div>
        ) : (
          question.options.map((opt) => (
            <motion.button
              key={opt.label}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
              onClick={() => handleClick(opt.label)}
              disabled={disabled}
              className="w-full text-left px-3 py-2 rounded-lg border border-nova-border bg-nova-surface hover:border-nova-violet/40 hover:bg-nova-violet/5 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="text-sm text-nova-text">{opt.label}</div>
              {opt.description && (
                <div className="text-xs text-nova-text-muted mt-0.5">{opt.description}</div>
              )}
            </motion.button>
          ))
        )}
      </div>

      {/* Footer hint */}
      {!answered && !disabled && (
        <div className="px-3.5 py-2 border-t border-nova-violet/10">
          <span className="text-xs text-nova-text-muted">or type your answer below</span>
        </div>
      )}
    </div>
  )
}
