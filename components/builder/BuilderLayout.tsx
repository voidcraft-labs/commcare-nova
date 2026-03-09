'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from 'ai'
import { useApiKey } from '@/hooks/useApiKey'
import { useBuilder } from '@/hooks/useBuilder'
import { BuilderPhase } from '@/lib/services/builder'
import { logUsage } from '@/lib/usage'
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
  const builder = useBuilder()
  const [chatOpen, setChatOpen] = useState(true)
  const triggeredRef = useRef(new Set<string>())

  const apiKeyRef = useRef(apiKey)
  apiKeyRef.current = apiKey

  const { messages, sendMessage, addToolOutput, status } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
      body: () => ({ apiKey: apiKeyRef.current }),
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  })

  useEffect(() => {
    if (loaded && !apiKey) router.push('/')
  }, [loaded, apiKey, router])

  // When scaffoldBlueprint tool is called, run scaffold and show it
  useEffect(() => {
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue
      for (const part of msg.parts) {
        if (
          part.type === 'tool-scaffoldBlueprint' &&
          (part.state === 'input-available' || part.state === 'output-available') &&
          !triggeredRef.current.has(part.toolCallId)
        ) {
          const input = part.input as { appName: string; appSpecification: string }
          if (!input?.appName || !input?.appSpecification) continue

          triggeredRef.current.add(part.toolCallId)

          // Run scaffold and set it on the builder
          ;(async () => {
            try {
              const res = await fetch('/api/blueprint/scaffold', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  apiKey,
                  appName: input.appName,
                  appSpecification: input.appSpecification,
                }),
              })
              const result = await res.json()
              if (result.success && result.blueprint) {
                if (result.usage) logUsage('Scaffold', result.usage)
                builder.setScaffold(result.blueprint, input.appSpecification, input.appName)
              }
            } catch (err) {
              console.error('Scaffold failed:', err)
            }
          })()
        }
      }
    }
  }, [messages, apiKey, builder])

  // Log chat token usage when assistant messages finish
  const loggedChatRef = useRef(new Set<string>())
  useEffect(() => {
    if (status !== 'ready') return
    for (const msg of messages) {
      if (msg.role !== 'assistant' || loggedChatRef.current.has(msg.id)) continue
      const meta = (msg as any).metadata
      if (meta?.usage) {
        loggedChatRef.current.add(msg.id)
        // Extract output text + tool calls from message parts
        const output = msg.parts.map((p: any) => {
          if (p.type === 'text') return p.text
          if (p.type?.startsWith('tool-')) return { tool: p.type, input: p.input }
          return null
        }).filter(Boolean)

        logUsage('Chat', [{
          model: meta.usage.model,
          input_tokens: meta.usage.inputTokens,
          output_tokens: meta.usage.outputTokens,
          stop_reason: null,
          input: meta.input ?? undefined,
          output,
        }])
      }
    }
  }, [messages, status])

  const handleSend = useCallback((text: string) => {
    if (!text.trim() || !apiKey) return
    sendMessage({ text })
  }, [apiKey, sendMessage])

  const handleCompile = async () => {
    if (!builder.blueprint) return
    try {
      const res = await fetch('/api/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blueprint: builder.blueprint }),
      })
      const data = await res.json()
      if (data.downloadUrl) window.open(data.downloadUrl, '_blank')
    } catch (err) {
      console.error('Compile failed:', err)
    }
  }

  const handleDownloadJson = async () => {
    if (!builder.blueprint) return
    try {
      const res = await fetch('/api/compile/json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blueprint: builder.blueprint }),
      })
      if (!res.ok) {
        console.error('JSON export failed:', await res.text())
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${builder.blueprint.app_name || 'app'}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('JSON export failed:', err)
    }
  }

  const handleValidate = async () => {
    if (!builder.blueprint) return
    try {
      const res = await fetch('/api/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blueprint: builder.blueprint }),
      })
      const data = await res.json()
      if (data.valid) alert('Blueprint is valid!')
      else alert(`Validation errors:\n${data.errors.join('\n')}`)
    } catch (err) {
      console.error('Validate failed:', err)
    }
  }

  if (!loaded) return null

  const isGenerating = [BuilderPhase.Modules, BuilderPhase.Forms, BuilderPhase.Validating, BuilderPhase.Fixing].includes(builder.phase)

  // Scaffold tool has been called but hasn't returned yet
  const scaffoldInFlight = builder.phase === BuilderPhase.Idle && messages.some(msg =>
    msg.role === 'assistant' && msg.parts.some(part =>
      part.type === 'tool-scaffoldBlueprint' && part.state !== 'output-available'
    )
  )

  return (
    <div className="h-screen flex flex-col bg-nova-void overflow-hidden">
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-nova-border shrink-0">
        <div className="flex items-center gap-4">
          <div className="cursor-pointer" onClick={() => router.push('/')}>
            <Logo size="sm" />
          </div>
          {builder.blueprint && (
            <span className="text-sm text-nova-text-secondary font-medium">
              {builder.blueprint.app_name}
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
          {builder.phase === BuilderPhase.Scaffolding && (
            <Button variant="primary" size="sm" onClick={() => builder.fillBlueprint(apiKey)}>
              Generate
            </Button>
          )}
          {builder.phase === BuilderPhase.Done && builder.blueprint && (
            <>
              <Button variant="ghost" size="sm" onClick={handleValidate}>
                Validate
              </Button>
              <Button variant="secondary" size="sm" onClick={handleDownloadJson}>
                Download JSON
              </Button>
              <Button variant="secondary" size="sm" onClick={handleCompile}>
                Download .ccz
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {chatOpen && (
          <ChatSidebar
            messages={messages}
            status={status}
            onSend={handleSend}
            onClose={() => setChatOpen(false)}
            addToolOutput={addToolOutput}
          />
        )}

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

          {scaffoldInFlight ? (
            <div className="flex items-center justify-center h-full">
              <div className="flex items-center gap-3 text-sm text-nova-text-muted">
                <span className="inline-block w-2 h-2 rounded-full bg-nova-violet animate-pulse" />
                Generating blueprint...
              </div>
            </div>
          ) : builder.phase === BuilderPhase.Idle && !builder.blueprint ? (
            <EmptyState onOpenChat={() => setChatOpen(true)} />
          ) : (
            <AppTree
              blueprint={builder.blueprint}
              selected={builder.selected}
              onSelect={(s) => builder.select(s)}
              phase={builder.phase}
            />
          )}

          {isGenerating && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
              <GenerationProgress
                phase={builder.phase}
                message={builder.statusMessage}
              />
            </div>
          )}
        </div>

        {builder.selected && builder.blueprint && (
          <DetailPanel
            blueprint={builder.blueprint}
            selected={builder.selected}
            onUpdate={(bp) => builder.updateBlueprint(bp)}
            onClose={() => builder.select(null)}
          />
        )}
      </div>
    </div>
  )
}
