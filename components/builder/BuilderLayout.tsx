'use client'
import { useRef, useState, useCallback, useEffect, useLayoutEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react/offline'
import ciMessage from '@iconify-icons/ci/message'
import ciSettings from '@iconify-icons/ci/settings'
import tablerListTree from '@iconify-icons/tabler/list-tree'
import Link from 'next/link'
import { useApiKey } from '@/hooks/useApiKey'
import { useAuth } from '@/hooks/useAuth'
import { useSettings } from '@/hooks/useSettings'
import { useBuilder } from '@/hooks/useBuilder'
import { BuilderPhase, applyDataPart, type CursorMode } from '@/lib/services/builder'
import { showToast } from '@/lib/services/toastStore'
import { ToastContainer } from '@/components/ui/ToastContainer'
import type { AppBlueprint } from '@/lib/schemas/blueprint'
import { flattenQuestionPaths } from '@/lib/services/questionNavigation'
import { type QuestionPath } from '@/lib/services/questionPath'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { Logo } from '@/components/ui/Logo'
import { ChatSidebar, CHAT_SIDEBAR_WIDTH } from '@/components/chat/ChatSidebar'
import { StructureSidebar } from '@/components/builder/StructureSidebar'
import { GenerationProgress } from '@/components/builder/GenerationProgress'
import { ReplayController } from '@/components/builder/ReplayController'
import { CollapsibleBreadcrumb } from '@/components/builder/SubheaderToolbar'
import type { BreadcrumbPart } from '@/components/builder/SubheaderToolbar'
import { ScreenNavButtons } from '@/components/preview/ScreenNavButtons'
import { ExportDropdown } from '@/components/ui/ExportDropdown'
import { AppConnectSettings } from '@/components/builder/detail/AppConnectSettings'
import ciFileDocument from '@iconify-icons/ci/file-document'
import tablerPackageExport from '@iconify-icons/tabler/package-export'
import ciUndo from '@iconify-icons/ci/undo'
import ciRedo from '@iconify-icons/ci/redo'
import { CursorModeSelector } from '@/components/builder/CursorModeSelector'
import { useBuilderShortcuts } from '@/components/builder/useBuilderShortcuts'
import { PreviewShell } from '@/components/preview/PreviewShell'
import { usePreviewNav } from '@/hooks/usePreviewNav'
import { getParentScreen, type PreviewScreen } from '@/lib/preview/engine/types'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { getReplayData, clearReplayData } from '@/lib/services/logReplay'
import { ReferenceProviderWrapper } from '@/lib/references/ReferenceContext'


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

/** Shared sidebar open/close animation config. */
const SIDEBAR_TRANSITION = { duration: 0.2, ease: [0.4, 0, 0.2, 1] } as const

/** Width of the structure sidebar in pixels (w-80). */
const STRUCTURE_SIDEBAR_WIDTH = 320

export function BuilderLayout({ buildId }: { buildId: string }) {
  const router = useRouter()
  const { apiKey } = useApiKey()
  const { isAuthenticated, isPending: authPending } = useAuth()
  const { settings } = useSettings()
  const builder = useBuilder()
  const initialReplay = getReplayData()
  const [chatOpen, setChatOpen] = useState(true)
  const [structureOpen, setStructureOpen] = useState(true)
  const [cursorMode, setCursorMode] = useState<CursorMode>('inspect')
  const cursorModeRef = useRef(cursorMode)
  const scrollAnchorRef = useRef<{ questionPath: string; offsetTop: number; allPaths: string[] } | null>(null)
  cursorModeRef.current = cursorMode
  const [progressHidden, setProgressHidden] = useState(false)
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

  // Keep builder's cursorMode in sync for undo/redo snapshot capture
  builder.setCursorMode(cursorMode)

  const handleCursorModeChange = useCallback((mode: CursorMode) => {
    // Capture scroll anchor before mode switch for flipbook-style alignment
    // (switching to/from pointer triggers different rendering which may shift scroll)
    const scrollContainer = document.querySelector('[data-preview-scroll-container]') as HTMLElement | null
    if (scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect()
      const questionEls = Array.from(scrollContainer.querySelectorAll('[data-question-id]'))
      for (let i = 0; i < questionEls.length; i++) {
        const rect = questionEls[i].getBoundingClientRect()
        if (rect.bottom > containerRect.top) {
          scrollAnchorRef.current = {
            questionPath: questionEls[i].getAttribute('data-question-id')!,
            offsetTop: rect.top - containerRect.top,
            allPaths: questionEls.map(el => el.getAttribute('data-question-id')!),
          }
          break
        }
      }
    }

    cursorModeRef.current = mode
    setCursorMode(mode)
  }, [])

  // Restore scroll position after mode switch for flipbook-style alignment
  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current
    if (!anchor) return
    scrollAnchorRef.current = null

    const scrollContainer = document.querySelector('[data-preview-scroll-container]') as HTMLElement | null
    if (!scrollContainer) return

    let targetEl = scrollContainer.querySelector(`[data-question-id="${anchor.questionPath}"]`) as HTMLElement | null

    if (!targetEl) {
      // Anchor hidden in new mode — find nearest visible question above it
      const anchorIdx = anchor.allPaths.indexOf(anchor.questionPath)
      for (let i = anchorIdx - 1; i >= 0; i--) {
        targetEl = scrollContainer.querySelector(`[data-question-id="${anchor.allPaths[i]}"]`) as HTMLElement | null
        if (targetEl) break
      }
    }

    if (targetEl) {
      const containerRect = scrollContainer.getBoundingClientRect()
      const currentOffset = targetEl.getBoundingClientRect().top - containerRect.top
      scrollContainer.scrollTop += currentOffset - anchor.offsetTop
    }
  }, [cursorMode])

  const inReplayMode = !!replayData
  const hasAccess = isAuthenticated || !!apiKey || inReplayMode
  const isCentered = builder.phase === BuilderPhase.Idle && !builder.treeData

  // ── Stable ref for builder so onData callback doesn't go stale ──────
  const builderRef = useRef(builder)
  builderRef.current = builder

  // ── Navigate to first form when generation completes ──
  const prevPhaseRef = useRef(builder.phase)
  useEffect(() => {
    const wasGenerating = [BuilderPhase.DataModel, BuilderPhase.Structure, BuilderPhase.Modules, BuilderPhase.Forms, BuilderPhase.Validate, BuilderPhase.Fix].includes(prevPhaseRef.current)
    if (wasGenerating && builder.phase === BuilderPhase.Done) {
      // Navigate to first form if available
      if (builder.blueprint && builder.blueprint.modules.length > 0 && builder.blueprint.modules[0].forms.length > 0) {
        nav.navigateToForm(0, 0)
      }
    }
    prevPhaseRef.current = builder.phase
  }, [builder.phase, builder.blueprint, nav.navigateToForm])

  // ── Single useChat — handles chat + generation + editing ────────────
  const { messages, sendMessage, addToolOutput, status, error: chatError } = useChat({
    messages: persistedChatMessages,
    transport: new DefaultChatTransport({
      api: '/api/chat',
      body: () => ({
        /* Only send apiKey for BYOK users — authenticated users use the server key */
        ...(apiKeyRef.current ? { apiKey: apiKeyRef.current } : {}),
        pipelineConfig: settingsRef.current.pipeline,
        blueprint: builder.blueprint ?? undefined,
        runId: runIdRef.current,
      }),
    }),
    sendAutomaticallyWhen: shouldAutoResend,
    onData: (part: any) => {
      if (part.type === 'data-run-id') { runIdRef.current = part.data.runId; return }
      applyDataPart(builderRef.current, part.type, part.data)
      if (part.type === 'data-error') {
        showToast(part.data.fatal ? 'error' : 'warning', 'Generation error', part.data.message)
      }
    },
  })

  // Keep module-level message cache in sync so remounts restore chat history
  persistedChatMessages = messages

  // Sync chat transport status → builder agent state (drives builder.isThinking)
  useEffect(() => {
    builder.setAgentActive(status === 'submitted' || status === 'streaming')
  }, [status, builder])

  // Surface stream-level errors from useChat (network, API key, server crash)
  useEffect(() => {
    if (chatError && builder.phase !== BuilderPhase.Error) {
      builder.setError(chatError.message)
      showToast('error', 'Generation failed', chatError.message)
    }
  }, [chatError, builder])

  const isGenerating = builder.isGenerating

  const progressMode = 'centered' as const
  if (isGenerating && progressHidden) setProgressHidden(false)

  const handleSend = useCallback((text: string) => {
    if (!text.trim() || !hasAccess) return
    sendMessage({ text })
  }, [hasAccess, sendMessage])

  const handleExportCcz = useCallback(async () => {
    if (!builder.blueprint) return
    try {
      const res = await fetch('/api/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blueprint: builder.blueprint }),
      })
      const data = await res.json()
      if (data.downloadUrl) {
        const cczRes = await fetch(data.downloadUrl)
        const blob = await cczRes.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${data.appName || 'app'}.ccz`
        a.click()
        URL.revokeObjectURL(url)
      }
    } catch {
      showToast('error', 'Export failed', 'Could not generate the .ccz file.')
    }
  }, [builder])

  const handleExportJson = useCallback(async () => {
    if (!builder.blueprint) return
    try {
      const res = await fetch('/api/compile/json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blueprint: builder.blueprint }),
      })
      if (!res.ok) {
        showToast('error', 'Export failed', 'Could not generate the JSON file.')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${builder.blueprint.app_name || 'app'}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      showToast('error', 'Export failed', 'Could not generate the JSON file.')
    }
  }, [builder])

  const exportOptions = useMemo(() => [
    { label: 'JSON', description: 'CommCare Web Apps', icon: ciFileDocument, onClick: handleExportJson },
    { label: 'CCZ', description: 'CommCare Mobile', icon: tablerPackageExport, onClick: handleExportCcz },
  ], [handleExportJson, handleExportCcz])

  // ── Undo/Redo with view restoration ─────────────────────────────────
  const restoreView = useCallback((targetMode: CursorMode) => {
    // Switch cursor mode if needed
    if (targetMode !== cursorModeRef.current) {
      cursorModeRef.current = targetMode
      setCursorMode(targetMode)
    }
    // Sync nav to the restored selection
    const sel = builder.selected
    if (!sel || !builder.blueprint) {
      nav.navigateToHome()
    } else if (sel.formIndex !== undefined) {
      const currentCaseId = nav.current.type === 'form' ? nav.current.caseId : undefined
      nav.navigateToForm(sel.moduleIndex, sel.formIndex, currentCaseId)
    } else {
      nav.navigateToModule(sel.moduleIndex)
    }
  }, [builder, nav.current, nav.navigateToHome, nav.navigateToForm, nav.navigateToModule])

  const handleUndo = useCallback(() => {
    const mode = builder.undo()
    if (mode) restoreView(mode)
  }, [builder, restoreView])

  const handleRedo = useCallback(() => {
    const mode = builder.redo()
    if (mode) restoreView(mode)
  }, [builder, restoreView])

  // ── Structure tree selection → select + navigate canvas ─────────────
  const handleTreeSelect = useCallback((sel: any) => {
    builder.select(sel)
    if (!sel) {
      nav.navigateToHome()
      return
    }
    if (!builder.blueprint) return
    if (sel.formIndex !== undefined) {
      const currentCaseId = nav.current.type === 'form' ? nav.current.caseId : undefined
      nav.navigateToForm(sel.moduleIndex, sel.formIndex, currentCaseId)
    } else {
      nav.navigateToModule(sel.moduleIndex)
    }
    // Scroll the design canvas to the selected question (only if not already visible).
    if (sel.questionPath) {
      setTimeout(() => {
        const el = document.querySelector(`[data-question-id="${sel.questionPath}"]`) as HTMLElement | null
        const scrollContainer = el?.closest('[data-preview-scroll-container]') as HTMLElement | null
        if (el && scrollContainer) {
          const containerRect = scrollContainer.getBoundingClientRect()
          const elRect = el.getBoundingClientRect()
          /* Only scroll if the top of the element is outside the visible viewport.
             For tall elements (groups/repeats), we only care about the top being visible —
             requiring the full element to fit would always trigger a scroll. */
          const SCROLL_MARGIN = 20
          const isTopVisible = elRect.top >= containerRect.top + SCROLL_MARGIN
            && elRect.top <= containerRect.bottom - SCROLL_MARGIN
          if (!isTopVisible) {
            const targetScrollTop = scrollContainer.scrollTop + elRect.top - containerRect.top - SCROLL_MARGIN
            scrollContainer.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' })
          }
        }
      }, 250)
    }
  }, [builder, nav.navigateToHome, nav.navigateToForm, nav.navigateToModule])

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

  const shortcuts = useBuilderShortcuts(builder, cursorMode, handleCursorModeChange, handleDelete, handleUndo, handleRedo)

  useKeyboardShortcuts('builder-layout', shortcuts, [builder.phase === BuilderPhase.Done, cursorMode, builder.selected, builder.blueprint, builder.mutationCount])

  /** Sync builder selection to match the given preview screen. */
  const syncSelection = useCallback((screen: PreviewScreen | undefined) => {
    if (!screen || screen.type === 'home') {
      builder.select()
    } else if (screen.type === 'module') {
      builder.select({ type: 'module', moduleIndex: screen.moduleIndex })
    } else if (screen.type === 'form' || screen.type === 'caseList') {
      builder.select({ type: 'form', moduleIndex: screen.moduleIndex, formIndex: screen.formIndex })
    }
  }, [builder])

  const handlePreviewBack = useCallback(() => {
    syncSelection(nav.back())
  }, [nav, syncSelection])

  const handlePreviewUp = useCallback(() => {
    nav.navigateUp()
    syncSelection(getParentScreen(nav.current))
  }, [nav, syncSelection])

  // Breadcrumb click handlers — memoized on navigation structure so they're
  // stable across unrelated renders (chat messages, selection changes, etc.).
  // This lets CollapsibleBreadcrumb's memo() skip re-renders when nothing changed.
  const breadcrumbHandlers = useMemo(() =>
    nav.breadcrumbPath.map((screen, idx) => () => {
      nav.navigateTo(idx)
      syncSelection(screen)
    }),
    [nav.breadcrumbPath, nav.navigateTo, syncSelection],
  )

  const noop = useCallback(() => {}, [])

  /**
   * Context getter for the ReferenceProvider. Reads from the builder's current
   * selection (contextual editor) or the nav's current form screen (preview canvas).
   * Returns undefined when no form is active (home/module screens).
   */
  const getRefContext = useCallback(() => {
    const mb = builder.mb
    if (!mb) return undefined
    const blueprint = mb.getBlueprint()

    /* Prefer the selected question's form (contextual editor context). */
    const sel = builder.selected
    if (sel?.type === 'question' && sel.formIndex !== undefined) {
      const form = mb.getForm(sel.moduleIndex, sel.formIndex)
      const mod = mb.getModule(sel.moduleIndex)
      if (form) return { blueprint, form, moduleCaseType: mod?.case_type ?? undefined }
    }

    /* Fall back to the nav's current form screen (preview canvas context). */
    const screen = navRef.current.current
    if (screen.type === 'form') {
      const form = mb.getForm(screen.moduleIndex, screen.formIndex)
      const mod = mb.getModule(screen.moduleIndex)
      if (form) return { blueprint, form, moduleCaseType: mod?.case_type ?? undefined }
    }

    return undefined
  }, [builder])

  // ── Redirect guard — all hooks must be above this line ─────────────
  // Don't redirect while the auth check is still in flight.
  const shouldRedirect = !authPending && !hasAccess
  useEffect(() => {
    if (shouldRedirect) router.push('/')
  }, [shouldRedirect, router])
  if (shouldRedirect || authPending) return null

  const showProgress = (isGenerating || builder.phase === BuilderPhase.Done || builder.phase === BuilderPhase.Error) && !progressHidden && !inReplayMode
  const showToolbar = !!(builder.treeData && builder.phase === BuilderPhase.Done && builder.blueprint)
  const editMode = cursorMode === 'pointer' ? 'test' as const : 'edit' as const

  // Breadcrumb parts — labels are derived unmemoized (for live inline title edits),
  // handlers are stable memoized references. During generation (no blueprint),
  // show app name as a static non-clickable breadcrumb.
  const breadcrumbParts: BreadcrumbPart[] = builder.blueprint
    ? nav.breadcrumb.map((label, i) => ({
        label,
        onClick: breadcrumbHandlers[i] ?? noop,
      }))
    : builder.treeData?.app_name
      ? [{ label: builder.treeData.app_name, onClick: noop }]
      : []

  return (
    <ReferenceProviderWrapper getContext={getRefContext} subscribeMutation={builder.subscribeMutation}>
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

        {/* Tier 2: Nav + breadcrumbs (left) + action buttons (right) */}
        <AnimatePresence>
          {!isCentered && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="flex items-center justify-between px-5 h-12 border-b border-nova-border shrink-0 bg-nova-deep"
            >
              <div className="flex items-center gap-2 min-w-0">
                {builder.blueprint && (
                  <ScreenNavButtons
                    canGoBack={nav.canGoBack}
                    canGoUp={nav.canGoUp}
                    onBack={handlePreviewBack}
                    onUp={handlePreviewUp}
                  />
                )}
                <CollapsibleBreadcrumb parts={breadcrumbParts} />
              </div>
              {showToolbar && (
                <div className="flex items-center gap-1 shrink-0">
                  <AppConnectSettings builder={builder} />
                  <button
                    onClick={handleUndo}
                    disabled={!builder.canUndo}
                    className="flex items-center justify-center w-8 h-8 rounded-lg text-nova-text-muted transition-colors cursor-pointer enabled:hover:text-nova-text enabled:hover:bg-white/5 disabled:opacity-25 disabled:cursor-default"
                    title="Undo (⌘Z)"
                  >
                    <Icon icon={ciUndo} width="18" height="18" />
                  </button>
                  <button
                    onClick={handleRedo}
                    disabled={!builder.canRedo}
                    className="flex items-center justify-center w-8 h-8 rounded-lg text-nova-text-muted transition-colors cursor-pointer enabled:hover:text-nova-text enabled:hover:bg-white/5 disabled:opacity-25 disabled:cursor-default"
                    title="Redo (⌘⇧Z)"
                  >
                    <Icon icon={ciRedo} width="18" height="18" />
                  </button>
                  <ExportDropdown options={exportOptions} compact />
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Tier 4: Content area — flex row of sidebars and main content.
         *  Both sidebars animate width on open/close. ChatSidebar stays mounted
         *  (width: 0) when collapsed to preserve its singleton controller. */}
        <div className="relative flex-1 overflow-hidden flex">
          {/* Structure sidebar (left) — width-animated mount/unmount */}
          <AnimatePresence initial={false}>
            {!isCentered && builder.treeData && structureOpen && (
              <motion.div
                key="structure"
                initial={{ width: 0 }}
                animate={{ width: STRUCTURE_SIDEBAR_WIDTH }}
                exit={{ width: 0 }}
                transition={SIDEBAR_TRANSITION}
                className="shrink-0 overflow-hidden"
              >
                <StructureSidebar
                  builder={builder}
                  onClose={() => setStructureOpen(false)}
                  onTreeSelect={handleTreeSelect}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Main scrollable content */}
          <AnimatePresence>
            {!isCentered && (
              <motion.div
                className="flex-1 overflow-hidden relative"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, delay: 0.15 }}
              >
                <div className="h-full overflow-auto">
                  {/* Floating reopen buttons — same position as original design */}
                  {!structureOpen && builder.treeData && (
                    <button
                      onClick={() => setStructureOpen(true)}
                      className="absolute top-3 left-3 z-ground p-2 bg-nova-surface border border-nova-border rounded-lg hover:border-nova-border-bright transition-colors cursor-pointer"
                      title="Open structure"
                    >
                      <Icon icon={tablerListTree} width="20" height="20" />
                    </button>
                  )}
                  {!chatOpen && (
                    <button
                      onClick={() => setChatOpen(true)}
                      className="absolute top-3 right-3 z-ground p-2 bg-nova-surface border border-nova-border rounded-lg hover:border-nova-border-bright transition-colors cursor-pointer"
                      title="Open chat"
                    >
                      <Icon icon={ciMessage} width="20" height="20" />
                    </button>
                  )}

                  <ErrorBoundary>
                    {builder.phase === BuilderPhase.Done && builder.blueprint ? (
                      <PreviewShell
                        blueprint={builder.blueprint}
                        builder={builder}
                        mode={editMode}
                        cursorMode={cursorMode}
                        nav={nav}
                        hideHeader
                        onBack={handlePreviewBack}
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
                          statusMessage={builder.statusMessage}
                          completed={builder.progressCompleted}
                          total={builder.progressTotal}
                          mode={progressMode}
                          onDone={() => setProgressHidden(true)}
                        />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Cursor mode bar — anchored to the right edge of the centered
                 *  form content (max-w-3xl) so it stays at a fixed distance from
                 *  the form regardless of which sidebars are open or closed. */}
                {showToolbar && (
                  <div className="absolute inset-0 pointer-events-none z-raised">
                    <div className="max-w-3xl mx-auto h-full relative">
                      <div className="absolute top-1/2 -translate-y-1/2 -right-7 pointer-events-auto">
                        <CursorModeSelector mode={cursorMode} onChange={handleCursorModeChange} variant="vertical" />
                      </div>
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Chat sidebar — always mounted, width-animated for open/close.
           *  In centered mode the wrapper is invisible to layout (auto width,
           *  no overflow clip) so ChatSidebar's absolute positioning works. */}
          <motion.div
            initial={false}
            animate={{ width: isCentered ? 'auto' : (chatOpen ? CHAT_SIDEBAR_WIDTH : 0) }}
            transition={isCentered ? { duration: 0 } : SIDEBAR_TRANSITION}
            className={isCentered ? '' : 'shrink-0 overflow-hidden'}
          >
            <ErrorBoundary>
              <ChatSidebar
                key="chat"
                centered={isCentered}
                heroLogo={isCentered
                  ? <motion.div
                      layoutId="nova-logo"
                      transition={{ layout: { duration: 0.45, ease: [0.4, 0, 0.2, 1] } }}
                    >
                      <Logo size="hero" />
                    </motion.div>
                  : undefined
                }
                messages={inReplayMode ? replayMessages : messages}
                status={inReplayMode ? 'ready' : status}
                onSend={handleSend}
                onClose={() => setChatOpen(false)}
                addToolOutput={addToolOutput}
                readOnly={inReplayMode}
              />
            </ErrorBoundary>
          </motion.div>
        </div>

      <ToastContainer />
    </div>
    </ReferenceProviderWrapper>
  )
}
