'use client'
import type { ConversationMessage } from '@/lib/types'

export function ChatMessage({ message }: { message: ConversationMessage }) {
  const isUser = message.role === 'user'

  // Generation card for "generate" intent
  if (message.type === 'generation') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-xl border border-nova-violet/20 bg-nova-violet/5 overflow-hidden">
          <div className="px-3.5 py-2.5 border-b border-nova-violet/10 flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 1v12M1 7h12" stroke="var(--nova-violet)" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span className="text-sm font-medium text-nova-text">
              {message.appName}
            </span>
          </div>
          {message.content && (
            <div className="px-3.5 py-2.5 text-xs leading-relaxed text-nova-text-secondary whitespace-pre-wrap">
              {message.content}
            </div>
          )}
          <div className="px-3.5 py-2 bg-nova-violet/5 border-t border-nova-violet/10">
            <span className="text-xs text-nova-violet flex items-center gap-1.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-nova-violet animate-pulse" />
              Starting generation...
            </span>
          </div>
        </div>
      </div>
    )
  }

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
