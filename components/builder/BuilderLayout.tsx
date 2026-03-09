'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useApiKey } from '@/hooks/useApiKey'
import { useBuilder } from '@/hooks/useBuilder'
import { useChat } from '@/hooks/useChat'
import { useSSE } from '@/hooks/useSSE'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ChatSidebar } from '@/components/chat/ChatSidebar'
import { AppTree } from '@/components/builder/AppTree'
import { DetailPanel } from '@/components/builder/DetailPanel'
import { EmptyState } from '@/components/builder/EmptyState'
import { GenerationProgress } from '@/components/builder/GenerationProgress'

export function BuilderLayout({ buildId }: { buildId: string }) {
  const router = useRouter()
  const { apiKey, loaded } = useApiKey()
  const { state, handleSSEEvent, startGeneration, select, updateBlueprint } = useBuilder()
  const chat = useChat(apiKey)
  const [chatOpen, setChatOpen] = useState(true)

  // SSE connection for active generation
  useSSE(state.sseUrl, {
    onEvent: handleSSEEvent,
  })

  // Redirect if no API key
  useEffect(() => {
    if (loaded && !apiKey) {
      router.push('/')
    }
  }, [loaded, apiKey, router])

  const handleGenerate = async (appName: string) => {
    if (!apiKey) return
    // Build conversation context from chat messages
    const conversationContext = chat.messages
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n')

    await startGeneration(apiKey, conversationContext, appName)
  }

  const handleCompile = async () => {
    if (!state.blueprint) return
    try {
      const res = await fetch('/api/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blueprint: state.blueprint }),
      })
      const data = await res.json()
      if (data.downloadUrl) {
        window.open(data.downloadUrl, '_blank')
      }
    } catch (err) {
      console.error('Compile failed:', err)
    }
  }

  const handleValidate = async () => {
    if (!state.blueprint) return
    try {
      const res = await fetch('/api/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blueprint: state.blueprint }),
      })
      const data = await res.json()
      if (data.valid) {
        alert('Blueprint is valid!')
      } else {
        alert(`Validation errors:\n${data.errors.join('\n')}`)
      }
    } catch (err) {
      console.error('Validate failed:', err)
    }
  }

  if (!loaded) return null

  const isGenerating = ['scaffolding', 'modules', 'forms', 'validating', 'fixing', 'compiling'].includes(state.phase)

  return (
    <div className="h-screen flex flex-col bg-nova-void overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-nova-border shrink-0">
        <div className="flex items-center gap-4">
          <div className="cursor-pointer" onClick={() => router.push('/')}>
            <Logo size="sm" />
          </div>
          {state.blueprint && (
            <span className="text-sm text-nova-text-secondary font-medium">
              {state.blueprint.app_name}
            </span>
          )}
          {isGenerating && (
            <Badge variant="violet">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-nova-violet-bright animate-pulse mr-1.5" />
              Generating
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {state.blueprint && (
            <>
              <Button variant="ghost" size="sm" onClick={handleValidate}>
                Validate
              </Button>
              <Button variant="secondary" size="sm" onClick={handleCompile}>
                Download .ccz
              </Button>
            </>
          )}
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Chat sidebar */}
        {chatOpen && (
          <ChatSidebar
            messages={chat.messages}
            isStreaming={chat.isStreaming}
            onSend={chat.sendMessage}
            onClose={() => setChatOpen(false)}
            onGenerate={handleGenerate}
            hasBlueprint={!!state.blueprint}
            isGenerating={isGenerating}
          />
        )}

        {/* Main stage - App Tree */}
        <div className="flex-1 overflow-auto relative">
          {!chatOpen && (
            <button
              onClick={() => setChatOpen(true)}
              className="absolute top-3 left-3 z-10 p-2 bg-nova-surface border border-nova-border rounded-lg hover:border-nova-border-bright transition-colors"
              title="Open chat"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M2 4h12M2 8h12M2 12h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          )}

          {state.phase === 'idle' && !state.blueprint ? (
            <EmptyState onOpenChat={() => setChatOpen(true)} />
          ) : (
            <AppTree
              blueprint={state.blueprint}
              selected={state.selected}
              onSelect={select}
              phase={state.phase}
            />
          )}
        </div>

        {/* Detail panel */}
        {state.selected && state.blueprint && (
          <DetailPanel
            blueprint={state.blueprint}
            selected={state.selected}
            onUpdate={updateBlueprint}
            onClose={() => select(null)}
          />
        )}
      </div>

      {/* Progress bar */}
      {isGenerating && (
        <GenerationProgress
          phase={state.phase}
          message={state.statusMessage}
        />
      )}
    </div>
  )
}
