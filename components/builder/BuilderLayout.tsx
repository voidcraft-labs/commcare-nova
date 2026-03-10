'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { motion, AnimatePresence, LayoutGroup } from 'motion/react'
import { Icon } from '@iconify/react'
import ciHamburgerMd from '@iconify-icons/ci/hamburger-md'
import ciFileDocument from '@iconify-icons/ci/file-document'
import ciDownloadPackage from '@iconify-icons/ci/download-package'
import { useApiKey } from '@/hooks/useApiKey'
import { useBuilder } from '@/hooks/useBuilder'
import { BuilderPhase } from '@/lib/services/builder'
import { summarizeBlueprint } from '@/lib/schemas/blueprint'
import { logUsage } from '@/lib/usage'
import { Logo } from '@/components/ui/Logo'
import { Badge } from '@/components/ui/Badge'
import { ChatSidebar } from '@/components/chat/ChatSidebar'
import { AppTree } from '@/components/builder/AppTree'
import { DetailPanel } from '@/components/builder/DetailPanel'
import { GenerationProgress } from '@/components/builder/GenerationProgress'
import { DownloadDropdown } from '@/components/ui/DownloadDropdown'

/** Only auto-resend for askQuestions (client-side tool). Server-side tools complete on their own. */
function shouldAutoResend({ messages }: { messages: UIMessage[] }): boolean {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return false
  const askParts = last.parts.filter((p: any) => p.type === 'tool-askQuestions')
  return askParts.length > 0 && askParts.every((p: any) => p.state === 'output-available')
}

export function BuilderLayout({ buildId }: { buildId: string }) {
  const router = useRouter()
  const { apiKey, loaded } = useApiKey()
  const builder = useBuilder()
  const [chatOpen, setChatOpen] = useState(true)
  const [progressDismissed, setProgressDismissed] = useState(false)

  const apiKeyRef = useRef(apiKey)
  apiKeyRef.current = apiKey

  const isCentered = builder.phase === BuilderPhase.Idle && !builder.treeData

  // ── Stable ref for builder so onData callback doesn't go stale ──────
  const builderRef = useRef(builder)
  builderRef.current = builder

  // ── Single useChat — handles chat + generation + editing ────────────
  const { messages, sendMessage, addToolOutput, status } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
      body: () => ({
        apiKey: apiKeyRef.current,
        blueprint: builder.blueprint ?? undefined,
        blueprintSummary: builder.blueprint ? summarizeBlueprint(builder.blueprint) : undefined,
      }),
    }),
    sendAutomaticallyWhen: shouldAutoResend,
    onData: (part: any) => {
      const b = builderRef.current
      switch (part.type) {
        case 'data-planning': b.startPlanning(); break
        case 'data-editing': b.startEditing(); break
        case 'data-partial-scaffold': b.setPartialScaffold(part.data); break
        case 'data-scaffold': b.setScaffold(part.data); break
        case 'data-phase': b.setPhase(part.data.phase); break
        case 'data-module-done': b.setModuleContent(part.data.moduleIndex, part.data.caseListColumns); break
        case 'data-form-done': b.setFormContent(part.data.moduleIndex, part.data.formIndex, part.data.form); break
        case 'data-form-fixed': b.setFormContent(part.data.moduleIndex, part.data.formIndex, part.data.form); break
        case 'data-fix-attempt': b.setFixAttempt(part.data.attempt, part.data.errorCount); break
        case 'data-done': b.setDone(part.data); break
        case 'data-error': b.setError(part.data.message); break
        case 'data-usage': logUsage(part.data.label, part.data.calls); break
      }
    },
  })

  useEffect(() => {
    if (loaded && !apiKey) router.push('/')
  }, [loaded, apiKey, router])

  const isGenerating = [BuilderPhase.Designing, BuilderPhase.Modules, BuilderPhase.Forms, BuilderPhase.Validating, BuilderPhase.Fixing, BuilderPhase.Editing].includes(builder.phase)
  if (isGenerating && progressDismissed) setProgressDismissed(false)

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

  if (!loaded) return null

  const showProgress = (isGenerating || builder.phase === BuilderPhase.Done) && !progressDismissed

  return (
    <LayoutGroup>
    <div className="h-screen flex flex-col bg-nova-void overflow-hidden">
      {/* Header — collapses to zero height in hero mode, reveals with border on transition */}
      <motion.header
        className="overflow-hidden shrink-0"
        initial={false}
        animate={{
          height: isCentered ? 0 : 'auto',
        }}
        transition={{ duration: 0.45, ease: [0.4, 0, 0.2, 1] }}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-nova-border">
          {!isCentered && (
            <motion.div
              layoutId="nova-logo"
              className="cursor-pointer"
              onClick={() => router.push('/')}
              transition={{ layout: { duration: 0.45, ease: [0.4, 0, 0.2, 1] } }}
            >
              <Logo size="sm" />
            </motion.div>
          )}
          <div />
        </div>
      </motion.header>

        <div className="flex flex-1 overflow-hidden">
          {chatOpen && (
            <motion.div
              layout
              className={
                isCentered
                  ? 'flex-1 flex flex-col items-center justify-center gap-6'
                  : 'shrink-0'
              }
              transition={{ layout: { duration: 0.45, ease: [0.4, 0, 0.2, 1] } }}
            >
              {/* Hero logo — animates to header on transition */}
              {isCentered && (
                <motion.div
                  layoutId="nova-logo"
                  transition={{ layout: { duration: 0.45, ease: [0.4, 0, 0.2, 1] } }}
                >
                  <Logo size="hero" />
                </motion.div>
              )}
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
                    <Icon icon={ciHamburgerMd} width="16" height="16" />
                  </button>
                )}

                {(builder.phase === BuilderPhase.Planning || builder.phase === BuilderPhase.Editing || (builder.phase === BuilderPhase.Designing && !builder.treeData)) ? (
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
                        {isGenerating && (
                          <Badge variant="violet">
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-nova-violet-bright animate-pulse mr-1.5" />
                            Generating
                          </Badge>
                        )}
                        {builder.phase === BuilderPhase.Done && builder.blueprint && (
                          <>
                            <DownloadDropdown
                              options={[
                                {
                                  label: 'JSON',
                                  description: 'For CommCare HQ',
                                  icon: <Icon icon={ciFileDocument} width="28" height="28" />,
                                  onClick: handleDownloadJson,
                                },
                                {
                                  label: 'CCZ',
                                  description: 'For CommCare mobile',
                                  icon: <Icon icon={ciDownloadPackage} width="28" height="28" />,
                                  onClick: handleCompile,
                                },
                              ]}
                            />
                          </>
                        )}
                      </>
                    }
                  />
                )}

                <AnimatePresence>
                  {showProgress && (
                    <div className="fixed bottom-4 inset-x-0 z-10 flex justify-center pointer-events-none">
                      <div className="pointer-events-auto">
                        <GenerationProgress
                          phase={builder.phase}
                          message={builder.statusMessage}
                          completed={builder.progressCompleted}
                          total={builder.progressTotal}
                          onDismiss={() => setProgressDismissed(true)}
                        />
                      </div>
                    </div>
                  )}
                </AnimatePresence>
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
    </div>
    </LayoutGroup>
  )
}
