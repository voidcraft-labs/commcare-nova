'use client'
import type { ConversationMessage } from '@/lib/types'

export function ChatMessage({ message }: { message: ConversationMessage }) {
  const isUser = message.role === 'user'

  // Strip <app-spec> tags for display (just show the content)
  const displayContent = message.content
    .replace(/<app-spec>/g, '')
    .replace(/<\/app-spec>/g, '')
    .trim()

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
