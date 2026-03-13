'use client'
import type { UIMessage } from 'ai'
import { QuestionCard } from '@/components/chat/QuestionCard'
import { renderMarkdown } from '@/lib/markdown'

interface ChatMessageProps {
  message: UIMessage
  addToolOutput: (params: {
    tool: string
    toolCallId: string
    output: unknown
  }) => void
}

export function ChatMessage({
  message,
  addToolOutput,
}: ChatMessageProps) {
  const isUser = message.role === 'user'

  return (
    <>
      {message.parts.map((part, i) => {
        if (part.type === 'text') {
          const text = part.text.trim()
          if (!text) return null
          return (
            <div key={i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed ${
                isUser
                  ? 'bg-nova-violet/15 text-nova-text border border-nova-violet/10'
                  : 'bg-nova-surface text-nova-text-secondary border border-nova-border'
              }`}>
                {isUser ? (
                  <div className="whitespace-pre-wrap break-words">{text}</div>
                ) : (
                  <div className="chat-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
                )}
              </div>
            </div>
          )
        }

        if (part.type === 'tool-askQuestions') {
          return (
            <QuestionCard
              key={part.toolCallId}
              toolCallId={part.toolCallId}
              input={part.input as { header: string; questions: { question: string; options: { label: string; description?: string }[] }[] }}
              state={part.state}
              output={part.state === 'output-available' ? (part.output as Record<string, string>) : undefined}
              addToolOutput={addToolOutput}
            />
          )
        }

        // Non-chat parts (tool-generateApp, tool-editApp, data-*, etc.) are handled by BuilderLayout
        return null
      })}
    </>
  )
}
