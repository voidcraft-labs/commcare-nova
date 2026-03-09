'use client'
import type { ConversationMessage } from '@/lib/types'
import type { ActiveQuestionState } from '@/hooks/useChat'
import { QuestionCard } from '@/components/chat/QuestionCard'
import { GenerationCard } from '@/components/chat/GenerationCard'

interface ChatMessageProps {
  message: ConversationMessage
  activeQuestions: ActiveQuestionState | null
  isGenerating: boolean
  onSelectOption: (questionText: string, optionLabel: string) => void
  onGenerate: () => void
  onCancelGeneration: () => void
}

export function ChatMessage({
  message,
  activeQuestions,
  isGenerating,
  onSelectOption,
  onGenerate,
  onCancelGeneration,
}: ChatMessageProps) {
  // Question card
  if (message.type === 'questions' && message.questions) {
    // activeQuestions is non-null only if this is the current question card
    const isThisCardActive =
      activeQuestions !== null &&
      activeQuestions.questions === message.questions

    return (
      <QuestionCard
        questions={message.questions}
        activeState={isThisCardActive ? activeQuestions : null}
        completedAnswers={!isThisCardActive ? activeQuestions?.answers : undefined}
        onSelectOption={onSelectOption}
      />
    )
  }

  // Generation card
  if (message.type === 'generation') {
    return (
      <GenerationCard
        message={message}
        isGenerating={isGenerating}
        onGenerate={onGenerate}
        onCancel={onCancelGeneration}
      />
    )
  }

  // Regular text bubble
  const isUser = message.role === 'user'
  const displayContent = message.content.trim()

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed ${
        isUser
          ? 'bg-nova-violet/15 text-nova-text border border-nova-violet/10'
          : 'bg-nova-surface text-nova-text-secondary border border-nova-border'
      }`}>
        <div className="whitespace-pre-wrap break-words">
          {displayContent || (
            <span className="inline-flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-nova-text-muted animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-nova-text-muted animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-nova-text-muted animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
