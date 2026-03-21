'use client'
import { useRef, useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react'
import ciChatConversationCircle from '@iconify-icons/ci/chat-conversation-circle'
import ciSettings from '@iconify-icons/ci/settings'
import Link from 'next/link'
import { useApiKey } from '@/hooks/useApiKey'
import { useSettings } from '@/hooks/useSettings'
import { useBuilder } from '@/hooks/useBuilder'
import { BuilderPhase, applyDataPart, type ViewMode } from '@/lib/services/builder'
import { summarizeBlueprint } from '@/lib/schemas/blueprint'
import { flattenQuestionPaths } from '@/lib/services/questionNavigation'
import { type QuestionPath } from '@/lib/services/questionPath'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { Logo } from '@/components/ui/Logo'
import { ChatSidebar } from '@/components/chat/ChatSidebar'
import { LeftPanel, type LeftTab } from '@/components/builder/LeftPanel'
import { DetailPanel } from '@/components/builder/DetailPanel'
import { GenerationProgress } from '@/components/builder/GenerationProgress'
import { ReplayController } from '@/components/builder/ReplayController'
import { SubheaderToolbar, CollapsibleBreadcrumb } from '@/components/builder/SubheaderToolbar'
import type { BreadcrumbPart } from '@/components/builder/SubheaderToolbar'
import { DownloadDropdown } from '@/components/ui/DownloadDropdown'
import ciFileDocument from '@iconify-icons/ci/file-document'
import ciDownloadPackage from '@iconify-icons/ci/download-package'
import { useBuilderShortcuts } from '@/components/builder/useBuilderShortcuts'
import { PreviewShell } from '@/components/preview/PreviewShell'
import { usePreviewNav } from '@/hooks/usePreviewNav'
import type { PreviewScreen } from '@/lib/preview/engine/types'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
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

// ── Persist chat messages at module level so they survive component remounts ──
// (Builder is a module-level singleton, but useChat's internal Chat instance
// lives in a useRef that resets on remount — this bridges the gap.)
let persistedChatMessages: UIMessage[] = []

export function BuilderLayout({ buildId }: { buildId: string }) {
  const router = useRouter()
  const { apiKey, loaded } = useApiKey()
  const { settings } = useSettings()
  const builder = useBuilder()
  const [leftPanelOpen, setLeftPanelOpen] = useState(true)
  const [leftTab, setLeftTab] = useState<LeftTab>('chat')
  const [detailUserPref, setDetailUserPref] = useState(true)
  const [viewMode, setViewMode] = useState<'design' | 'preview'>('design')
  const viewModeRef = useRef(viewMode)
  viewModeRef.current = viewMode
  const [progressHidden, setProgressHidden] = useState(false)
  const initialReplay = getReplayData()
  const replayStartIndex = initialReplay?.doneIndex ?? 0
  const [replayData, setReplayDataState] = useState(() => {
    if (initialReplay) {
      for (let i = 0; i <= replayStartIndex; i++) {
        initialReplay.stages[i]?.applyToBuilder(builder)
      }
    }
    return initialReplay
  })
  const [replayMessages, setReplayMessages] = useState(
    () => initialReplay?.stages[replayStartIndex]?.messages ?? []
  )

  const apiKeyRef = useRef(apiKey)
  apiKeyRef.current = apiKey
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const runIdRef = useRef<string | undefined>(undefined)

  const handleExitReplay = useCallback(() => {
    setReplayDataState(undefined)
    setReplayMessages([])
    clearReplayData()
    builder.reset()
  }, [builder])

  const nav = usePreviewNav(builder.blueprint)
  const navRef = useRef(nav)
  navRef.current = nav

  const layoutRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
  }, [])

  // Keep builder's viewMode in sync for undo/redo snapshot capture
  builder.setViewMode(viewMode as ViewMode)

  const handleViewModeChange = useCallback((mode: 'design' | 'preview') => {
    viewModeRef.current = mode
    setViewMode(mode)

    // Entering preview: collapse left panel
    if (mode === 'preview') {
      setLeftPanelOpen(false)
    } else {
      setLeftPanelOpen(true)
    }
  }, [])

  const inReplayMode = !!replayData
  const isCentered = builder.phase === BuilderPhase.Idle && !builder.treeData

  // ── Stable ref for builder so onData callback doesn't go stale ──────
  const builderRef = useRef(builder)
  builderRef.current = builder

  // ── Auto-switch to Structure tab when tree data first appears during generation ──
  const prevTreeDataRef = useRef(builder.treeData)
  useEffect(() => {
    if (!prevTreeDataRef.current && builder.treeData) {
      setLeftTab('structure')
      setLeftPanelOpen(true)
    }
    prevTreeDataRef.current = builder.treeData
  }, [builder.treeData])

  // ── Auto-switch to Chat tab + navigate to first form when generation completes ──
  const prevPhaseRef = useRef(builder.phase)
  useEffect(() => {
    const wasGenerating = [BuilderPhase.DataModel, BuilderPhase.Structure, BuilderPhase.Modules, BuilderPhase.Forms, BuilderPhase.Validate, BuilderPhase.Fix].includes(prevPhaseRef.current)
    if (wasGenerating && builder.phase === BuilderPhase.Done) {
      setLeftTab('chat')
      // Navigate to first form if available
      if (builder.blueprint && builder.blueprint.modules.length > 0 && builder.blueprint.modules[0].forms.length > 0) {
        nav.replaceStack([
          { type: 'home' },
          { type: 'module', moduleIndex: 0 },
          { type: 'form', moduleIndex: 0, formIndex: 0 },
        ])
      }
    }
    prevPhaseRef.current = builder.phase
  }, [builder.phase, builder.blueprint, nav.replaceStack])

  // ── Single useChat — handles chat + generation + editing ────────────
  const { messages, sendMessage, addToolOutput, status } = useChat({
    messages: persistedChatMessages,
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

  // Keep module-level message cache in sync so remounts restore chat history
  persistedChatMessages = messages

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

  // ── Undo/Redo with view restoration ─────────────────────────────────
  const restoreView = useCallback((targetMode: ViewMode) => {
    // Switch view mode if needed
    if (targetMode !== viewModeRef.current) {
      viewModeRef.current = targetMode
      setViewMode(targetMode)
    }
    // Sync nav stack to the restored selection
    const sel = builder.selected
    if (!sel || !builder.blueprint) {
      nav.reset()
    } else {
      const stack: PreviewScreen[] = [{ type: 'home' }]
      stack.push({ type: 'module', moduleIndex: sel.moduleIndex })
      if (sel.formIndex !== undefined) {
        stack.push({ type: 'form', moduleIndex: sel.moduleIndex, formIndex: sel.formIndex })
      }
      nav.replaceStack(stack)
    }
  }, [builder, nav.replaceStack, nav.reset])

  const handleUndo = useCallback(() => {
    const viewMode = builder.undo()
    if (viewMode) {
      setDetailUserPref(true)
      restoreView(viewMode)
    }
  }, [builder, restoreView])

  const handleRedo = useCallback(() => {
    const viewMode = builder.redo()
    if (viewMode) {
      setDetailUserPref(true)
      restoreView(viewMode)
    }
  }, [builder, restoreView])

  // ── Keyboard shortcuts (extracted to useBuilderShortcuts) ───────────
  const handleDetailClose = useCallback(() => {
    builder.select()
    setDetailUserPref(false)
  }, [builder])

  // ── Structure tree selection → select + navigate canvas ─────────────
  const handleTreeSelect = useCallback((sel: any) => {
    builder.select(sel)
    if (!sel) {
      nav.reset()
      return
    }
    const stack: PreviewScreen[] = [{ type: 'home' }]
    stack.push({ type: 'module', moduleIndex: sel.moduleIndex })
    if (sel.formIndex !== undefined) {
      stack.push({ type: 'form', moduleIndex: sel.moduleIndex, formIndex: sel.formIndex })
    }
    nav.replaceStack(stack)
  }, [builder, nav.replaceStack, nav.reset])

  const handleDelete = useCallback(() => {
    const sel = builder.selected
    if (!sel || sel.type !== 'question' || sel.formIndex === undefined || !sel.questionPath) return
    const mb = builder.mb
    if (!mb) return
    const form = mb.getForm(sel.moduleIndex, sel.formIndex)
    if (!form) return

    const paths = flattenQuestionPaths(form.questions)
    const curIdx = paths.indexOf(sel.questionPath as QuestionPath)
    const nextPath = paths[curIdx + 1] ?? paths[curIdx - 1]

    mb.removeQuestion(sel.moduleIndex, sel.formIndex, sel.questionPath)
    builder.notifyBlueprintChanged()

    if (nextPath) {
      builder.select({ type: 'question', moduleIndex: sel.moduleIndex, formIndex: sel.formIndex, questionPath: nextPath })
    } else {
      builder.select()
    }
  }, [builder])

  const shortcuts = useBuilderShortcuts(builder, viewMode, handleViewModeChange, handleDelete, handleUndo, handleRedo)

  useKeyboardShortcuts('builder-layout', shortcuts, [builder.phase === BuilderPhase.Done, viewMode, builder.selected, builder.blueprint, builder.mutationCount])

  // Sync detail panel pref with selection changes (suppress during view mode transitions)
  const prevVMRef = useRef(viewMode)
  const prevSelRef = useRef(builder.selected)
  useEffect(() => {
    const vmChanged = viewMode !== prevVMRef.current
    const selChanged = builder.selected !== prevSelRef.current
    if (selChanged && !vmChanged) {
      setDetailUserPref(!!builder.selected)
    }
    prevVMRef.current = viewMode
    prevSelRef.current = builder.selected
  }, [builder.selected, viewMode])

  const shouldRedirect = loaded && !apiKey && !inReplayMode
  useEffect(() => {
    if (shouldRedirect) router.push('/')
  }, [shouldRedirect, router])
  if (!loaded || shouldRedirect) return null

  const showProgress = (isGenerating || builder.phase === BuilderPhase.Done) && !progressHidden && !inReplayMode
  const leftOpen = viewMode === 'preview' ? false : leftPanelOpen
  const showToolbar = !!(builder.treeData && builder.phase === BuilderPhase.Done && builder.blueprint)
  const detailOpen = viewMode === 'preview' ? false : detailUserPref
  const showDetailPanel = showToolbar && !!builder.selected && detailOpen
  const editMode = viewMode === 'preview' ? 'test' as const : 'edit' as const

  // Breadcrumbs — always derived from nav stack now (no overview mode)
  const breadcrumbParts: BreadcrumbPart[] = []
  if (builder.blueprint) {
    for (let i = 0; i < nav.breadcrumb.length; i++) {
      const idx = i
      breadcrumbParts.push({
        label: nav.breadcrumb[idx],
        onClick: () => {
          nav.navigateTo(idx)
          const screen = nav.stack[idx]
          if (screen.type === 'module') {
            builder.select({ type: 'module', moduleIndex: screen.moduleIndex })
          } else if (screen.type === 'form' || screen.type === 'caseList') {
            builder.select({ type: 'form', moduleIndex: screen.moduleIndex, formIndex: screen.formIndex })
          } else {
            builder.select()
          }
        },
      })
    }
  }

  return (
    <div ref={layoutRef} className="h-screen flex flex-col bg-nova-void overflow-hidden">
      {/* Header — collapses to zero height in hero mode, reveals with border on transition */}
      <motion.header
        className="overflow-hidden shrink-0"
        initial={false}
        animate={{
          height: isCentered ? 0 : 'auto',
        }}
        transition={{ duration: 0.45, ease: [0.4, 0, 0.2, 1] }}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-nova-border bg-nova-void">
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
          className="absolute top-3 right-4 z-raised p-1.5 text-nova-text-muted hover:text-nova-text transition-colors rounded-lg hover:bg-nova-surface"
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
            initialIndex={replayStartIndex}
            onExit={handleExitReplay}
            onMessagesChange={setReplayMessages}
          />
        )}

        {/* Project subheader — full-width breadcrumbs + download */}
        <AnimatePresence>
          {!isCentered && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="flex items-center justify-between px-5 h-14 border-b border-nova-border shrink-0 bg-[rgba(139,92,246,0.06)] shadow-[0_1px_12px_-4px_rgba(139,92,246,0.12)]"
            >
              <CollapsibleBreadcrumb parts={breadcrumbParts} />
              {builder.phase === BuilderPhase.Done && builder.blueprint && (
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
                      description: 'For CommCare',
                      icon: <Icon icon={ciDownloadPackage} width="28" height="28" />,
                      onClick: handleCompile,
                    },
                  ]}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Tier 3: Toolbar — full-width view mode + undo/redo */}
        {showToolbar && (
          <SubheaderToolbar
            viewMode={viewMode}
            onViewModeChange={handleViewModeChange}
            canUndo={builder.canUndo}
            canRedo={builder.canRedo}
            onUndo={handleUndo}
            onRedo={handleRedo}
          />
        )}

        {/* Tier 4: Content area — sidebars float over main content */}
        <div className="relative flex-1 overflow-hidden">
          {/* Centered hero mode */}
          {isCentered && leftPanelOpen && (
            <motion.div
              layout
              className="absolute inset-0 flex flex-col items-center justify-center gap-6"
              transition={{ layout: { duration: 0.45, ease: [0.4, 0, 0.2, 1] } }}
            >
              <motion.div
                layoutId="nova-logo"
                transition={{ layout: { duration: 0.45, ease: [0.4, 0, 0.2, 1] } }}
              >
                <Logo size="hero" />
              </motion.div>
              <ErrorBoundary>
                <ChatSidebar
                  mode="centered"
                  messages={inReplayMode ? replayMessages : messages}
                  status={inReplayMode ? 'ready' : status}
                  onSend={handleSend}
                  onClose={() => setLeftPanelOpen(false)}
                  addToolOutput={addToolOutput}
                  readOnly={inReplayMode}
                />
              </ErrorBoundary>
            </motion.div>
          )}

          {/* Main scrollable content — full height, scrollbar on far right */}
          <AnimatePresence>
            {!isCentered && (
              <motion.div
                className="absolute inset-0"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, delay: 0.15 }}
              >
                <div className="h-full overflow-auto">
                  {!leftOpen && viewMode !== 'preview' && (
                    <button
                      onClick={() => setLeftPanelOpen(true)}
                      className="absolute top-3 left-3 z-ground p-2 bg-nova-surface border border-nova-border rounded-lg hover:border-nova-border-bright transition-colors cursor-pointer"
                      title="Open panel"
                    >
                      <Icon icon={ciChatConversationCircle} width="24" height="24" />
                    </button>
                  )}

                  <ErrorBoundary>
                    {builder.phase === BuilderPhase.Done && builder.blueprint ? (
                      <PreviewShell
                        blueprint={builder.blueprint}
                        builder={builder}
                        mode={editMode}
                        nav={nav}
                        hideHeader
                      />
                    ) : null}
                  </ErrorBoundary>
                </div>

                {/* Progress overlay */}
                <AnimatePresence>
                  {showProgress && (
                    <motion.div
                      className={`absolute z-ground pointer-events-none ${
                        progressMode === 'centered'
                          ? 'inset-0 flex items-center justify-center'
                          : 'bottom-4 inset-x-0 flex justify-center'
                      }`}
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

          {/* Left panel (Chat + Structure tabs) — absolute left, floats over content */}
          <AnimatePresence>
            {!isCentered && leftOpen && (
              <motion.div
                initial={{ x: -320, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: -320, opacity: 0 }}
                transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                className="absolute left-0 top-0 bottom-0 z-raised"
              >
                <LeftPanel
                  builder={builder}
                  messages={inReplayMode ? replayMessages : messages}
                  status={inReplayMode ? 'ready' : status}
                  onSend={handleSend}
                  addToolOutput={addToolOutput}
                  readOnly={inReplayMode}
                  onClose={() => setLeftPanelOpen(false)}
                  activeTab={leftTab}
                  onTabChange={setLeftTab}
                  onTreeSelect={handleTreeSelect}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* DetailPanel — absolute right, floats over content */}
          <AnimatePresence>
            {showDetailPanel && (
              <motion.div
                initial={{ x: 320, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 320, opacity: 0 }}
                transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                className="absolute right-0 top-0 bottom-0 z-raised"
              >
                <ErrorBoundary>
                  <DetailPanel builder={builder} onClose={handleDetailClose} />
                </ErrorBoundary>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

    </div>
  )
}
