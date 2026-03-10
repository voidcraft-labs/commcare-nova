'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from 'ai'
import { motion, AnimatePresence, LayoutGroup } from 'motion/react'
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
import { GenerationProgress } from '@/components/builder/GenerationProgress'

export function BuilderLayout({ buildId }: { buildId: string }) {
  const router = useRouter()
  const { apiKey, loaded } = useApiKey()
  const builder = useBuilder()
  const [chatOpen, setChatOpen] = useState(true)
  const triggeredRef = useRef(new Set<string>())

  const apiKeyRef = useRef(apiKey)
  apiKeyRef.current = apiKey

  const isCentered = builder.phase === BuilderPhase.Idle && !builder.treeData

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

  // React to scaffoldBlueprint tool call as it streams in
  const planningRef = useRef(new Set<string>())
  useEffect(() => {
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue
      for (const part of msg.parts) {
        if (part.type !== 'tool-scaffoldBlueprint') continue

        // input-streaming: Claude is writing the plan → show "Generating plan..."
        if (part.state === 'input-streaming' && !planningRef.current.has(part.toolCallId)) {
          planningRef.current.add(part.toolCallId)
          builder.startPlanning()
        }

        // input-available: plan is complete → fire scaffold API
        if (
          (part.state === 'input-available' || part.state === 'output-available') &&
          !triggeredRef.current.has(part.toolCallId)
        ) {
          const input = part.input as { appName: string; appSpecification: string }
          if (!input?.appName || !input?.appSpecification) continue

          triggeredRef.current.add(part.toolCallId)
          builder.startScaffolding()

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
              if (result.success && result.scaffold) {
                if (result.usage) logUsage('Scaffold', result.usage)
                builder.setScaffold(result.scaffold)
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

  return (
    <div className="h-screen flex flex-col bg-nova-void overflow-hidden">
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-nova-border shrink-0">
        <div className="cursor-pointer" onClick={() => router.push('/')}>
          <Logo size="sm" />
        </div>
        <div />
      </header>

      <LayoutGroup>
        <div className="flex flex-1 overflow-hidden">
          {chatOpen && (
            <motion.div
              layout
              className={
                isCentered
                  ? 'flex-1 flex items-center justify-center'
                  : 'shrink-0'
              }
              transition={{ layout: { duration: 0.45, ease: [0.4, 0, 0.2, 1] } }}
            >
              <ChatSidebar
                mode={isCentered ? 'centered' : 'sidebar'}
                messages={messages}
                status={status}
                onSend={handleSend}
                onClose={() => setChatOpen(false)}
                addToolOutput={addToolOutput}
              />
            </motion.div>
          )}

          <AnimatePresence>
            {!isCentered && (
              <motion.div
                className="flex-1 overflow-auto relative"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, delay: 0.15 }}
              >
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

                {builder.phase === BuilderPhase.Planning ? (
                  <div className="flex items-center justify-center h-full">
                    <div className="flex items-center gap-3 text-sm text-nova-text-muted">
                      <span className="inline-block w-2 h-2 rounded-full bg-nova-violet animate-pulse" />
                      {builder.statusMessage}
                    </div>
                  </div>
                ) : (
                  <AppTree
                    data={builder.treeData}
                    selected={builder.selected}
                    onSelect={(s) => builder.select(s)}
                    phase={builder.phase}
                    actions={
                      <>
                        {builder.phase === BuilderPhase.Scaffolding && (
                          <Button variant="primary" size="sm" onClick={() => builder.fillBlueprint(apiKey)}>
                            Generate
                          </Button>
                        )}
                        {isGenerating && (
                          <Badge variant="violet">
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-nova-violet-bright animate-pulse mr-1.5" />
                            Generating
                          </Badge>
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
                      </>
                    }
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
              </motion.div>
            )}
          </AnimatePresence>

          {builder.selected && builder.blueprint && (
            <DetailPanel
              blueprint={builder.blueprint}
              selected={builder.selected}
              onUpdate={(bp) => builder.updateBlueprint(bp)}
              onClose={() => builder.select(null)}
            />
          )}
        </div>
      </LayoutGroup>
    </div>
  )
}
