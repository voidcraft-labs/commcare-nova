'use client'
import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react'
import ciArrowRight from '@iconify-icons/ci/arrow-right-md'
import ciCheckAll from '@iconify-icons/ci/check-all'
import { useClaudeCode, getQuestionPreamble } from '@/hooks/useClaudeCode'
import type { StructuredQuestion } from '@/hooks/useClaudeCode'
import { renderMarkdown } from '@/lib/markdown'

interface ClaudeCodeChatProps {
  onBlueprintReady: (blueprint: any, messages: { role: string; content: string }[]) => void
}

export function ClaudeCodeChat({ onBlueprintReady }: ClaudeCodeChatProps) {
  const { messages, status, error, sendMessage, blueprint } = useClaudeCode()
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

  const handleOpenInBuilder = useCallback(() => {
    if (!blueprint) return
    const chatMessages = messages.map(m => ({ role: m.role, content: m.content }))
    onBlueprintReady(blueprint, chatMessages)
  }, [blueprint, messages, onBlueprintReady])

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
                        onAnswer={(answer) => sendMessage(answer)}
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

            {/* Thinking indicator */}
            <AnimatePresence>
              {showThinking && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="flex justify-start"
                >
                  <div className="text-sm text-nova-text-muted animate-pulse px-1 py-1">
                    Thinking...
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

      {/* Blueprint ready banner */}
      <AnimatePresence>
        {blueprint && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="mx-4 mb-3 flex items-center justify-between gap-3 rounded-lg border border-nova-emerald/30 bg-nova-emerald/10 px-4 py-3"
          >
            <div className="flex items-center gap-2 text-sm text-nova-emerald">
              <Icon icon={ciCheckAll} width="16" height="16" />
              <span>Blueprint ready</span>
            </div>
            <button
              onClick={handleOpenInBuilder}
              className="shrink-0 rounded-md bg-nova-emerald px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
            >
              Open in Builder
            </button>
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
