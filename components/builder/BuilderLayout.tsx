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
import ciSettings from '@iconify-icons/ci/settings'
import Link from 'next/link'
import { useApiKey } from '@/hooks/useApiKey'
import { useSettings } from '@/hooks/useSettings'
import { useBuilder } from '@/hooks/useBuilder'
import { BuilderPhase, applyDataPart } from '@/lib/services/builder'
import { summarizeBlueprint } from '@/lib/schemas/blueprint'
import { Logo } from '@/components/ui/Logo'
import { ChatSidebar } from '@/components/chat/ChatSidebar'
import { AppTree } from '@/components/builder/AppTree'
import { DetailPanel } from '@/components/builder/DetailPanel'
import { GenerationProgress } from '@/components/builder/GenerationProgress'
import { ReplayController } from '@/components/builder/ReplayController'
import { DownloadDropdown } from '@/components/ui/DownloadDropdown'
import { PreviewToggle } from '@/components/preview/PreviewToggle'
import { PreviewShell } from '@/components/preview/PreviewShell'
import { getReplayData, clearReplayData } from '@/lib/services/logReplay'

/** Only auto-resend when the assistant's LAST step is askQuestions with all outputs available.
 *  If the SA continued past tool calls to ask a freeform text question, don't auto-resend —
 *  the user needs to reply manually first. */
function shouldAutoResend({ messages }: { messages: UIMessage[] }): boolean {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return false

  // Only look at the last step — earlier answered questions don't matter
  const lastStepIdx = last.parts.reduce((idx: number, p: any, i: number) =>
    p.type === 'step-start' ? i : idx, -1)
  const lastStepParts = last.parts.slice(lastStepIdx + 1)

  const askParts = lastStepParts.filter((p: any) => p.type === 'tool-askQuestions')
  return askParts.length > 0 && askParts.every((p: any) => p.state === 'output-available')
}

export function BuilderLayout({ buildId }: { buildId: string }) {
  const router = useRouter()
  const { apiKey, loaded } = useApiKey()
  const { settings } = useSettings()
  const builder = useBuilder()
  const [chatOpen, setChatOpen] = useState(true)
  const [viewMode, setViewMode] = useState<'tree' | 'preview'>('tree')
  const [progressHidden, setProgressHidden] = useState(false)
  const initialReplay = getReplayData()
  const [replayData, setReplayDataState] = useState(() => {
    if (initialReplay) initialReplay.stages[0]?.applyToBuilder(builder)
    return initialReplay
  })
  const [replayMessages, setReplayMessages] = useState(
    () => initialReplay?.stages[0]?.messages ?? []
  )

  const apiKeyRef = useRef(apiKey)
  apiKeyRef.current = apiKey
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const runIdRef = useRef<string | undefined>(undefined)

  const handleExitReplay = useCallback(() => {
    setReplayDataState(null)
    setReplayMessages([])
    clearReplayData()
    builder.reset()
  }, [builder])

  const inReplayMode = replayData !== null
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
        pipelineConfig: settingsRef.current.pipeline,
        blueprint: builder.blueprint ?? undefined,
        blueprintSummary: builder.blueprint ? summarizeBlueprint(builder.blueprint) : undefined,
        runId: runIdRef.current,
      }),
    }),
    sendAutomaticallyWhen: shouldAutoResend,
    onData: (part: any) => {
      if (part.type === 'data-run-id') { runIdRef.current = part.data.runId; return }
      applyDataPart(builderRef.current, part.type, part.data)
    },
  })

  useEffect(() => {
    if (loaded && !apiKey && !inReplayMode) router.push('/')
  }, [loaded, apiKey, router, inReplayMode])

  const isGenerating = [BuilderPhase.DataModel, BuilderPhase.Structure, BuilderPhase.Modules, BuilderPhase.Forms, BuilderPhase.Validate, BuilderPhase.Fix].includes(builder.phase)

  // Progress is centered when there's no tree data yet, compact once the tree appears
  const progressMode = builder.treeData ? 'compact' as const : 'centered' as const
  if (isGenerating && progressHidden) setProgressHidden(false)

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

  const showProgress = (isGenerating || builder.phase === BuilderPhase.Done) && !progressHidden && !inReplayMode

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
          <Link
            href="/settings"
            className="p-1.5 text-nova-text-muted hover:text-nova-text transition-colors rounded-lg hover:bg-nova-surface"
            title="Settings"
          >
            <Icon icon={ciSettings} width="18" height="18" />
          </Link>
        </div>
      </motion.header>

      {/* Settings cog — visible in centered/hero mode when header is collapsed */}
      {isCentered && (
        <Link
          href="/settings"
          className="absolute top-3 right-4 z-20 p-1.5 text-nova-text-muted hover:text-nova-text transition-colors rounded-lg hover:bg-nova-surface"
          title="Settings"
        >
          <Icon icon={ciSettings} width="18" height="18" />
        </Link>
      )}

        {/* Replay controller — between header and content so it's visible in both centered and sidebar modes */}
        {inReplayMode && replayData && (
          <ReplayController
            stages={replayData.stages}
            appName={replayData.appName}
            onExit={handleExitReplay}
            onMessagesChange={setReplayMessages}
          />
        )}

        <div className="flex flex-1 overflow-hidden">
          {(chatOpen || inReplayMode) && (
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
                messages={inReplayMode ? replayMessages : messages}
                status={inReplayMode ? 'ready' : status}
                onSend={handleSend}
                onClose={inReplayMode ? undefined : () => setChatOpen(false)}
                addToolOutput={addToolOutput}
                readOnly={inReplayMode}
              />
            </motion.div>
          )}

          <AnimatePresence>
            {!isCentered && (
              <motion.div
                className="flex-1 relative"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, delay: 0.15 }}
              >
                <div className="absolute inset-0 overflow-auto">
                  {!chatOpen && (
                    <button
                      onClick={() => setChatOpen(true)}
                      className="absolute top-3 left-3 z-10 p-2 bg-nova-surface border border-nova-border rounded-lg hover:border-nova-border-bright transition-colors"
                      title="Open chat"
                    >
                      <Icon icon={ciHamburgerMd} width="16" height="16" />
                    </button>
                  )}

                  {builder.treeData ? (
                    viewMode === 'preview' && builder.phase === BuilderPhase.Done && builder.blueprint ? (
                      <PreviewShell
                        blueprint={builder.blueprint}
                        actions={
                          <>
                            <PreviewToggle mode={viewMode} onChange={setViewMode} />
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
                        }
                      />
                    ) : (
                      <AppTree
                        data={builder.treeData}
                        selected={viewMode === 'tree' ? builder.selected : null}
                        onSelect={(s) => builder.select(s)}
                        phase={builder.phase}
                        actions={
                          builder.phase === BuilderPhase.Done && builder.blueprint ? (
                            <>
                              <PreviewToggle mode={viewMode} onChange={setViewMode} />
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
                          ) : undefined
                        }
                      />
                    )
                  ) : null}
                </div>

                <AnimatePresence>
                  {showProgress && (
                    <motion.div
                      layout
                      className={`absolute z-10 pointer-events-none ${
                        progressMode === 'centered'
                          ? 'inset-0 flex items-center justify-center'
                          : 'bottom-4 inset-x-0 flex justify-center'
                      }`}
                      transition={{ layout: { duration: 0.5, ease: [0.4, 0, 0.2, 1] } }}
                    >
                      <div className="pointer-events-auto">
                        <GenerationProgress
                          phase={builder.phase}
                          message={builder.statusMessage}
                          completed={builder.progressCompleted}
                          total={builder.progressTotal}
                          mode={progressMode}
                          onDone={() => setProgressHidden(true)}
                        />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>

          {viewMode === 'tree' && builder.selected && builder.blueprint && (
            <DetailPanel builder={builder} />
          )}
        </div>
    </div>
    </LayoutGroup>
  )
}
