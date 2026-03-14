'use client'
import { useState, useRef, useCallback } from 'react'
import { Icon } from '@iconify/react'
import ciArrowRightMd from '@iconify-icons/ci/arrow-right-md'

interface ChatInputProps {
  onSend: (message: string) => void
  disabled?: boolean
  centered?: boolean
}

export function ChatInput({ onSend, disabled, centered }: ChatInputProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSubmit = useCallback(() => {
    if (!value.trim() || disabled) return
    onSend(value.trim())
    setValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [value, disabled, onSend])

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

  return (
    <div className="border-t border-nova-border p-3">
      <div className={`flex items-center bg-nova-surface border border-nova-border rounded-lg transition-shadow ${centered ? 'ring-1 ring-nova-violet/20 focus-within:ring-nova-violet/40' : 'focus-within:border-nova-violet'}`}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => { setValue(e.target.value); handleInput() }}
          onKeyDown={handleKeyDown}
          placeholder={centered ? 'Tell me about the app you want to build...' : 'Ask for changes...'}
          disabled={disabled}
          rows={1}
          className={`flex-1 resize-none bg-transparent border-none text-sm text-nova-text placeholder:text-nova-text-muted focus:outline-none disabled:opacity-50 ${centered ? 'px-4 py-3' : 'px-3 py-2'}`}
        />
        <button
          onClick={handleSubmit}
          disabled={!value.trim() || disabled}
          className="shrink-0 p-2 mr-1 text-nova-violet-bright hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <Icon icon={ciArrowRightMd} width="16" height="16" />
        </button>
      </div>
    </div>
  )
}
