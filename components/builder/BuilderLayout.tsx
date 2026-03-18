'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { motion, AnimatePresence, LayoutGroup } from 'motion/react'
import { Icon } from '@iconify/react'
import ciHamburgerMd from '@iconify-icons/ci/hamburger-md'
import ciSettings from '@iconify-icons/ci/settings'
import ciUndo from '@iconify-icons/ci/undo'
import ciRedo from '@iconify-icons/ci/redo'
import ciChevronRight from '@iconify-icons/ci/chevron-right'
import ciFileDocument from '@iconify-icons/ci/file-document'
import ciDownloadPackage from '@iconify-icons/ci/download-package'
import Link from 'next/link'
import { useApiKey } from '@/hooks/useApiKey'
import { useSettings } from '@/hooks/useSettings'
import { useBuilder } from '@/hooks/useBuilder'
import { BuilderPhase, applyDataPart } from '@/lib/services/builder'
import { summarizeBlueprint } from '@/lib/schemas/blueprint'
import { flattenQuestionIds } from '@/lib/services/questionNavigation'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import type { Shortcut } from '@/lib/services/keyboardManager'
import { Logo } from '@/components/ui/Logo'
import { ChatSidebar } from '@/components/chat/ChatSidebar'
import { AppTree } from '@/components/builder/AppTree'
import { DetailPanel } from '@/components/builder/DetailPanel'
import { GenerationProgress } from '@/components/builder/GenerationProgress'
import { ReplayController } from '@/components/builder/ReplayController'
import { PreviewToggle } from '@/components/preview/PreviewToggle'
import { DownloadDropdown } from '@/components/ui/DownloadDropdown'
import { PreviewShell } from '@/components/preview/PreviewShell'
import { usePreviewNav } from '@/hooks/usePreviewNav'
import type { PreviewScreen } from '@/lib/preview/engine/types'
import { generateDummyCases } from '@/lib/preview/engine/dummyData'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
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
  const [viewMode, setViewMode] = useState<'tree' | 'preview' | 'test'>('tree')
  const viewModeRef = useRef(viewMode)
  viewModeRef.current = viewMode
  const [progressHidden, setProgressHidden] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
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

  const nav = usePreviewNav(builder.blueprint)
  const navRef = useRef(nav)
  navRef.current = nav

  const handleViewModeChange = useCallback((mode: 'tree' | 'preview' | 'test') => {
    const wasTree = viewModeRef.current === 'tree'
    viewModeRef.current = mode
    setViewMode(mode)

    // Preview/Live → Tree: sync selection from current nav screen if nothing selected
    if (mode === 'tree' && !builder.selected) {
      const current = navRef.current.current
      if (current.type === 'module') {
        builder.select({ type: 'module', moduleIndex: current.moduleIndex })
      } else if (current.type === 'form' || current.type === 'caseList') {
        builder.select({ type: 'form', moduleIndex: current.moduleIndex, formIndex: current.formIndex })
      }
    }

    // Tree → Preview/Live: sync nav to the current selection
    if (!wasTree || !(mode === 'preview' || mode === 'test')) return
    if (!builder.selected || !builder.blueprint) return

    const sel = builder.selected
    const bp = builder.blueprint
    const stack: PreviewScreen[] = [{ type: 'home' }]
    stack.push({ type: 'module', moduleIndex: sel.moduleIndex })

    if (sel.formIndex !== undefined) {
      const mod = bp.modules[sel.moduleIndex]
      const form = mod?.forms[sel.formIndex]

      // For followup forms in live mode, auto-select the first dummy case
      let caseData: Map<string, string> | undefined
      if (mode === 'test' && form?.type === 'followup' && mod?.case_type) {
        const caseType = bp.case_types?.find(ct => ct.name === mod.case_type)
        if (caseType) {
          const rows = generateDummyCases(caseType, 1)
          if (rows[0]) caseData = rows[0].properties
        }
      }

      stack.push({
        type: 'form',
        moduleIndex: sel.moduleIndex,
        formIndex: sel.formIndex,
        ...(caseData && { caseData }),
      })
    }

    nav.replaceStack(stack)
  }, [builder, nav.replaceStack])

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

  // ── Keyboard shortcuts ──────────────────────────────────────────────
  const isDone = builder.phase === BuilderPhase.Done

  const shortcuts: Shortcut[] = isDone ? [
    // Escape — deselect / exit test mode
    {
      key: 'Escape',
      handler: () => {
        if (viewMode === 'test') { handleViewModeChange('preview'); return }
        if (builder.selected) { builder.select(null); return }
      },
    },
    // Tab / Shift+Tab — navigate questions
    {
      key: 'Tab',
      handler: () => {
        if (!builder.selected || !builder.blueprint) return
        const sel = builder.selected
        if (sel.formIndex === undefined) return
        const form = builder.blueprint.modules[sel.moduleIndex]?.forms[sel.formIndex]
        if (!form) return
        const ids = flattenQuestionIds(form.questions)
        const curIdx = ids.indexOf(sel.questionPath ?? '')
        const nextIdx = (curIdx + 1) % ids.length
        builder.select({ type: 'question', moduleIndex: sel.moduleIndex, formIndex: sel.formIndex, questionPath: ids[nextIdx] })
      },
    },
    {
      key: 'Tab',
      shift: true,
      handler: () => {
        if (!builder.selected || !builder.blueprint) return
        const sel = builder.selected
        if (sel.formIndex === undefined) return
        const form = builder.blueprint.modules[sel.moduleIndex]?.forms[sel.formIndex]
        if (!form) return
        const ids = flattenQuestionIds(form.questions)
        const curIdx = ids.indexOf(sel.questionPath ?? '')
        const prevIdx = curIdx <= 0 ? ids.length - 1 : curIdx - 1
        builder.select({ type: 'question', moduleIndex: sel.moduleIndex, formIndex: sel.formIndex, questionPath: ids[prevIdx] })
      },
    },
    // Delete / Backspace — delete selected question
    {
      key: 'Delete',
      handler: () => {
        if (builder.selected?.type === 'question') setDeleteConfirm(true)
      },
    },
    {
      key: 'Backspace',
      handler: () => {
        if (builder.selected?.type === 'question') setDeleteConfirm(true)
      },
    },
    // Cmd+D — duplicate
    {
      key: 'd',
      meta: true,
      handler: () => {
        const sel = builder.selected
        if (!sel || sel.type !== 'question' || sel.formIndex === undefined || !sel.questionPath) return
        const mb = builder.mb
        if (!mb) return
        const newId = mb.duplicateQuestion(sel.moduleIndex, sel.formIndex, sel.questionPath)
        builder.notifyBlueprintChanged()
        builder.select({ type: 'question', moduleIndex: sel.moduleIndex, formIndex: sel.formIndex, questionPath: newId })
      },
    },
    // ArrowUp/ArrowDown — reorder
    {
      key: 'ArrowUp',
      handler: () => {
        const sel = builder.selected
        if (!sel || sel.type !== 'question' || sel.formIndex === undefined || !sel.questionPath) return
        const mb = builder.mb
        if (!mb) return
        const form = mb.getForm(sel.moduleIndex, sel.formIndex)
        if (!form) return
        const ids = flattenQuestionIds(form.questions)
        const curIdx = ids.indexOf(sel.questionPath)
        if (curIdx <= 0) return
        mb.moveQuestion(sel.moduleIndex, sel.formIndex, sel.questionPath, { beforeId: ids[curIdx - 1] })
        builder.notifyBlueprintChanged()
      },
    },
    {
      key: 'ArrowDown',
      handler: () => {
        const sel = builder.selected
        if (!sel || sel.type !== 'question' || sel.formIndex === undefined || !sel.questionPath) return
        const mb = builder.mb
        if (!mb) return
        const form = mb.getForm(sel.moduleIndex, sel.formIndex)
        if (!form) return
        const ids = flattenQuestionIds(form.questions)
        const curIdx = ids.indexOf(sel.questionPath)
        if (curIdx < 0 || curIdx >= ids.length - 1) return
        mb.moveQuestion(sel.moduleIndex, sel.formIndex, sel.questionPath, { afterId: ids[curIdx + 1] })
        builder.notifyBlueprintChanged()
      },
    },
    // Cmd+Z / Cmd+Shift+Z — undo/redo
    {
      key: 'z',
      meta: true,
      global: true,
      handler: () => builder.undo(),
    },
    {
      key: 'z',
      meta: true,
      shift: true,
      global: true,
      handler: () => builder.redo(),
    },
  ] : []

  useKeyboardShortcuts('builder-layout', shortcuts, [isDone, viewMode, builder.selected, builder.blueprint, builder.mutationCount])

  const handleDeleteConfirm = useCallback(() => {
    const sel = builder.selected
    if (!sel || sel.type !== 'question' || sel.formIndex === undefined || !sel.questionPath) return
    const mb = builder.mb
    if (!mb) return
    const form = mb.getForm(sel.moduleIndex, sel.formIndex)
    if (!form) return

    const ids = flattenQuestionIds(form.questions)
    const curIdx = ids.indexOf(sel.questionPath)
    const nextId = ids[curIdx + 1] ?? ids[curIdx - 1]

    mb.removeQuestion(sel.moduleIndex, sel.formIndex, sel.questionPath)
    builder.notifyBlueprintChanged()

    if (nextId) {
      builder.select({ type: 'question', moduleIndex: sel.moduleIndex, formIndex: sel.formIndex, questionPath: nextId })
    } else {
      builder.select(null)
    }
    setDeleteConfirm(false)
  }, [builder])

  if (!loaded) return null

  const showProgress = (isGenerating || builder.phase === BuilderPhase.Done) && !progressHidden && !inReplayMode
  const isPreviewLike = viewMode === 'preview' || viewMode === 'test'
  const editMode = viewMode === 'test' ? 'test' as const : 'edit' as const

  // Unified breadcrumbs — derived from nav stack (preview/live) or selection (tree)
  const breadcrumbParts: { label: string; onClick: () => void }[] = []
  if (builder.blueprint) {
    const bp = builder.blueprint
    if (isPreviewLike) {
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
              builder.select(null)
            }
          },
        })
      }
    } else {
      const sel = builder.selected
      breadcrumbParts.push({ label: bp.app_name, onClick: () => builder.select(null) })
      if (sel) {
        const mod = bp.modules[sel.moduleIndex]
        if (mod) {
          breadcrumbParts.push({
            label: mod.name,
            onClick: () => builder.select({ type: 'module', moduleIndex: sel.moduleIndex }),
          })
        }
        if (sel.formIndex !== undefined) {
          const form = mod?.forms[sel.formIndex]
          if (form) {
            breadcrumbParts.push({
              label: form.name,
              onClick: () => builder.select({ type: 'form', moduleIndex: sel.moduleIndex, formIndex: sel.formIndex! }),
            })
          }
        }
      }
    }
  }

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
                className="flex-1 flex flex-col overflow-hidden"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, delay: 0.15 }}
              >
                {/* Subheader toolbar — breadcrumbs + toggle (centered) + undo/redo */}
                {builder.treeData && builder.phase === BuilderPhase.Done && builder.blueprint && (
                  <div className="grid grid-cols-[1fr_auto_1fr] items-center px-4 h-16 border-b border-nova-border shrink-0">
                    {/* Left — breadcrumbs (all view modes) */}
                    <div className="flex items-center min-w-0">
                      <nav className="flex items-center gap-1 text-sm min-w-0 truncate">
                        {breadcrumbParts.map((part, i) => {
                          const isLast = i === breadcrumbParts.length - 1
                          return (
                            <span key={i} className="flex items-center gap-1 shrink-0">
                              {i > 0 && (
                                <Icon icon={ciChevronRight} width="14" height="14" className="text-nova-text-muted/50" />
                              )}
                              {isLast ? (
                                <span className="text-nova-text font-medium truncate">{part.label}</span>
                              ) : (
                                <button
                                  onClick={part.onClick}
                                  className="text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer whitespace-nowrap"
                                >
                                  {part.label}
                                </button>
                              )}
                            </span>
                          )
                        })}
                      </nav>
                    </div>

                    {/* Center — toggle */}
                    <PreviewToggle mode={viewMode} onChange={handleViewModeChange} />

                    {/* Right — undo/redo + download */}
                    <div className="flex items-center gap-1.5 justify-end">
                      <button
                        onClick={() => builder.undo()}
                        disabled={!builder.canUndo}
                        className="flex items-center gap-1.5 h-[38px] px-3 rounded-lg text-[13px] font-medium text-nova-text-muted transition-colors cursor-pointer enabled:hover:text-nova-text enabled:hover:bg-nova-surface disabled:opacity-25 disabled:cursor-default"
                        title="Undo (⌘Z)"
                      >
                        <Icon icon={ciUndo} width="16" height="16" />
                        Undo
                      </button>
                      <button
                        onClick={() => builder.redo()}
                        disabled={!builder.canRedo}
                        className="flex items-center gap-1.5 h-[38px] px-3 rounded-lg text-[13px] font-medium text-nova-text-muted transition-colors cursor-pointer enabled:hover:text-nova-text enabled:hover:bg-nova-surface disabled:opacity-25 disabled:cursor-default"
                        title="Redo (⌘⇧Z)"
                      >
                        <Icon icon={ciRedo} width="16" height="16" />
                        Redo
                      </button>
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
                    </div>
                  </div>
                )}

                {/* Content + Detail panel row — below subheader */}
                <div className="flex-1 flex overflow-hidden">
                  <div className="flex-1 relative">
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
                        isPreviewLike && builder.phase === BuilderPhase.Done && builder.blueprint ? (
                          <PreviewShell
                            blueprint={builder.blueprint}
                            builder={builder}
                            mode={editMode}
                            nav={nav}
                            hideHeader
                          />
                        ) : (
                          <AppTree
                            data={builder.treeData}
                            selected={viewMode === 'tree' ? builder.selected : null}
                            onSelect={(s) => builder.select(s)}
                            phase={builder.phase}
                            hideHeader
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
                  </div>

                  {/* DetailPanel — slides from right, beneath subheader */}
                  <AnimatePresence>
                    {(viewMode === 'tree' || viewMode === 'preview') && builder.selected && builder.blueprint && (
                      <DetailPanel builder={builder} />
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

      {/* Delete confirmation from keyboard shortcut */}
      <ConfirmDialog
        open={deleteConfirm}
        title="Delete Question"
        message={`Are you sure you want to delete "${builder.selected?.questionPath}"?`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteConfirm(false)}
      />
    </div>
    </LayoutGroup>
  )
}
