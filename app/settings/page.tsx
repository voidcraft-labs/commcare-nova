'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import { Icon } from '@iconify/react'
import ciArrowLeft from '@iconify-icons/ci/arrow-left-md'
import ciUndo from '@iconify-icons/ci/undo'
import ciFileUpload from '@iconify-icons/ci/file-upload'
import ciFileDocument from '@iconify-icons/ci/file-document'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'
import { ApiKeyInput } from '@/components/ui/ApiKeyInput'
import { useSettings } from '@/hooks/useSettings'
import { extractReplayStages, setReplayData } from '@/lib/services/logReplay'
import { modelSupportsReasoning } from '@/lib/models'
import type { PipelineConfig, ReasoningEffort } from '@/lib/types/settings'
import type { RunLog } from '@/lib/services/runLogger'

interface ModelInfo {
  id: string
  display_name: string
  created_at: string
}

interface ParsedLog {
  log: RunLog
  fileName: string
}

const STAGES: { key: keyof PipelineConfig; label: string; description: string }[] = [
  { key: 'requirementsAnalyst', label: 'Requirements Analyst', description: 'Conversational agent that gathers requirements' },
  { key: 'scaffold', label: 'Scaffold', description: 'Designs app structure and data model' },
  { key: 'appContent', label: 'App Content', description: 'Generates form questions and case list columns' },
  { key: 'editArchitect', label: 'Edit Architect', description: 'Applies surgical edits to generated apps' },
  { key: 'singleFormRegen', label: 'Form Regeneration', description: 'Rebuilds individual forms from scratch' },
]

/** Max output token limits per model (with extended thinking). Hardcoded for now. */
const MODEL_MAX_TOKENS: Record<string, number> = {
  'claude-opus-4-6': 128000,
  'claude-sonnet-4-6': 64000,
  'claude-haiku-4-5-20251001': 64000,
}
const DEFAULT_MAX_TOKENS = 64000

const ALL_TOKEN_OPTIONS = [
  { value: 0, label: 'No limit' },
  { value: 4096, label: '4,096' },
  { value: 8192, label: '8,192' },
  { value: 16384, label: '16,384' },
  { value: 32768, label: '32,768' },
  { value: 64000, label: '64,000' },
  { value: 128000, label: '128,000' },
]

function getTokenOptions(model: string) {
  const cap = MODEL_MAX_TOKENS[model] ?? DEFAULT_MAX_TOKENS
  return ALL_TOKEN_OPTIONS.filter(opt => opt.value === 0 || opt.value <= cap)
}

const EFFORT_LEVELS: { value: ReasoningEffort; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
]

export default function SettingsPage() {
  const router = useRouter()
  const { settings, loaded, updateSettings, updatePipelineStage, resetToDefaults } = useSettings()
  const [keyInput, setKeyInput] = useState('')
  const [keySaved, setKeySaved] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelsFetched, setModelsFetched] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)

  // Log replay state
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<ParsedLog | null>(null)
  const [replayError, setReplayError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  // Sync key input with loaded settings
  useEffect(() => {
    if (loaded && settings.apiKey) {
      setKeyInput(settings.apiKey)
      setKeySaved(true)
    }
  }, [loaded, settings.apiKey])

  // Fetch models when API key is available
  const fetchModels = useCallback(async (apiKey: string) => {
    if (!apiKey) return
    try {
      const res = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      })
      const data = await res.json()
      if (data.error) {
        setModelsError(data.error)
        setModels([])
      } else {
        setModels(data.models ?? [])
        setModelsError(null)
      }
    } catch {
      setModelsError('Failed to fetch models')
      setModels([])
    } finally {
      setModelsFetched(true)
    }
  }, [])

  useEffect(() => {
    if (loaded && settings.apiKey) fetchModels(settings.apiKey)
  }, [loaded, settings.apiKey, fetchModels])

  const handleSaveKey = () => {
    updateSettings({ apiKey: keyInput })
    setKeySaved(true)
    if (keyInput) fetchModels(keyInput)
  }

  // Log replay handlers
  const handleFile = useCallback((file: File) => {
    setReplayError(null)
    setParsed(null)

    if (!file.name.endsWith('.json')) {
      setReplayError('Please select a .json file.')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      try {
        const log = JSON.parse(reader.result as string) as RunLog
        if (!log.events || !Array.isArray(log.events)) {
          setReplayError('This file does not appear to be a valid run log (no events array).')
          return
        }
        setParsed({ log, fileName: file.name })
      } catch {
        setReplayError('Failed to parse JSON file.')
      }
    }
    reader.readAsText(file)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const handleLoadReplay = useCallback(() => {
    if (!parsed) return
    const result = extractReplayStages(parsed.log)
    if (!result.success) {
      setReplayError(result.error)
      return
    }
    setReplayData(result.stages, result.appName)
    router.push('/build/new')
  }, [parsed, router])

  const formatCost = (cost: number) => `$${cost.toFixed(4)}`
  const formatDate = (iso: string) => new Date(iso).toLocaleString()

  if (!loaded) return null

  return (
    <div className="min-h-screen bg-nova-void">
      {/* Header */}
      <header className="border-b border-nova-border px-6 py-3 flex items-center gap-4">
        <button
          onClick={() => router.back()}
          className="p-1.5 -ml-1.5 text-nova-text-secondary hover:text-nova-text transition-colors rounded-lg hover:bg-nova-surface"
        >
          <Icon icon={ciArrowLeft} width="20" height="20" />
        </button>
        <div className="cursor-pointer" onClick={() => router.push('/')}>
          <Logo size="sm" />
        </div>
        <div className="h-4 w-px bg-nova-border" />
        <span className="text-sm text-nova-text-secondary font-medium">Settings</span>
      </header>

      {/* Content */}
      <main className="max-w-2xl mx-auto px-6 py-10">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="space-y-6"
        >
          {/* ── API Key ──────────────────────────────────── */}
          <section className="rounded-xl border border-nova-border bg-nova-deep p-6">
            <h2 className="text-sm font-display font-semibold tracking-wide uppercase text-nova-text-secondary mb-1">API Key</h2>
            <p className="text-xs text-nova-text-muted mb-4">
              Your Anthropic API key. Stored locally in your browser.
            </p>
            <ApiKeyInput
              value={keyInput}
              onChange={(v) => { setKeyInput(v); setKeySaved(false) }}
              onSave={handleSaveKey}
              saved={keySaved}
            />
          </section>

          {/* ── Pipeline Models ──────────────────────────── */}
          <section className="rounded-xl border border-nova-border bg-nova-deep p-6">
            <h2 className="text-sm font-display font-semibold tracking-wide uppercase text-nova-text-secondary mb-1">Pipeline Configuration</h2>
            <p className="text-xs text-nova-text-muted mb-5">
              Model, token limit, and reasoning settings for each generation stage.
            </p>
            <div className="space-y-2.5">
              {STAGES.map((stage, i) => (
                <motion.div
                  key={stage.key}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: 0.05 * i, ease: [0.16, 1, 0.3, 1] }}
                  className="p-4 bg-nova-surface border border-nova-border rounded-lg"
                >
                  <div className="flex items-start justify-between gap-4 mb-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-medium text-nova-text">{stage.label}</h3>
                      <p className="text-xs text-nova-text-muted mt-0.5">{stage.description}</p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="text-[11px] text-nova-text-muted uppercase tracking-wider mb-1.5 block">
                        Model
                      </label>
                      {models.length > 0 ? (
                        <select
                          value={settings.pipeline[stage.key].model}
                          onChange={(e) => {
                            const newModel = e.target.value
                            const cap = MODEL_MAX_TOKENS[newModel] ?? DEFAULT_MAX_TOKENS
                            const currentTokens = settings.pipeline[stage.key].maxOutputTokens
                            const updates: Partial<typeof settings.pipeline[typeof stage.key]> = { model: newModel }
                            if (currentTokens > 0 && currentTokens > cap) updates.maxOutputTokens = cap
                            if (!modelSupportsReasoning(newModel)) updates.reasoning = false
                            updatePipelineStage(stage.key, updates)
                          }}
                          className="w-full px-3 py-2 bg-nova-void border border-nova-border rounded-lg text-sm text-nova-text focus:outline-none focus:border-nova-violet transition-colors appearance-none cursor-pointer"
                        >
                          {models.map(m => (
                            <option key={m.id} value={m.id}>{m.display_name}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={settings.pipeline[stage.key].model}
                          onChange={(e) => updatePipelineStage(stage.key, { model: e.target.value })}
                          placeholder={!settings.apiKey ? 'Enter API key first' : 'Model ID...'}
                          disabled={!settings.apiKey}
                          className="w-full px-3 py-2 bg-nova-void border border-nova-border rounded-lg text-sm text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:border-nova-violet transition-colors disabled:opacity-40"
                        />
                      )}
                    </div>
                    <div className="w-36">
                      <label className="text-[11px] text-nova-text-muted uppercase tracking-wider mb-1.5 block">
                        Max Tokens
                      </label>
                      <select
                        value={settings.pipeline[stage.key].maxOutputTokens}
                        onChange={(e) =>
                          updatePipelineStage(stage.key, {
                            maxOutputTokens: parseInt(e.target.value),
                          })
                        }
                        className="w-full px-3 py-2 bg-nova-void border border-nova-border rounded-lg text-sm text-nova-text focus:outline-none focus:border-nova-violet transition-colors appearance-none cursor-pointer"
                      >
                        {getTokenOptions(settings.pipeline[stage.key].model).map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {/* Reasoning row — only when API key is set and model supports it */}
                  {settings.apiKey && modelSupportsReasoning(settings.pipeline[stage.key].model) && (
                    <div className="flex items-center gap-3 mt-3 pt-3 border-t border-nova-border/40">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={settings.pipeline[stage.key].reasoning}
                        onClick={() => updatePipelineStage(stage.key, { reasoning: !settings.pipeline[stage.key].reasoning })}
                        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                          settings.pipeline[stage.key].reasoning
                            ? 'bg-nova-violet'
                            : 'bg-nova-border'
                        }`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                            settings.pipeline[stage.key].reasoning ? 'translate-x-[18px]' : 'translate-x-[3px]'
                          }`}
                        />
                      </button>
                      <span className="text-xs text-nova-text-secondary select-none">Reasoning</span>
                      {settings.pipeline[stage.key].reasoning && (
                        <div className="ml-auto flex items-center gap-1.5">
                          {EFFORT_LEVELS.map(({ value, label }) => (
                            <button
                              key={value}
                              type="button"
                              onClick={() => updatePipelineStage(stage.key, { reasoningEffort: value })}
                              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                                settings.pipeline[stage.key].reasoningEffort === value
                                  ? 'bg-nova-violet/20 text-nova-violet-bright border border-nova-violet/40'
                                  : 'text-nova-text-muted hover:text-nova-text-secondary hover:bg-nova-void border border-transparent'
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </motion.div>
              ))}
            </div>
            {modelsError && modelsFetched && (
              <p className="text-xs text-nova-rose mt-3">{modelsError}</p>
            )}
            {!settings.apiKey && (
              <p className="text-xs text-nova-text-muted mt-3">
                Enter an API key above to load available models.
              </p>
            )}
            {/* Reset — contextual action within pipeline config */}
            <div className="mt-5 pt-4 border-t border-nova-border/40 flex items-center justify-between">
              <span className="text-xs text-nova-text-muted">
                Restore all stages to defaults
              </span>
              <Button
                onClick={resetToDefaults}
                variant="ghost"
                size="sm"
              >
                <Icon icon={ciUndo} width="14" height="14" />
                Reset
              </Button>
            </div>
          </section>

          {/* ── Log Replay ───────────────────────────────── */}
          <section className="rounded-xl border border-nova-border bg-nova-deep p-6">
            <h2 className="text-sm font-display font-semibold tracking-wide uppercase text-nova-text-secondary mb-1">Log Replay</h2>
            <p className="text-xs text-nova-text-muted mb-4">
              Load a run log to replay generation stages without API calls.
            </p>

            {/* Drop zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`relative flex flex-col items-center justify-center gap-3 p-8 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${
                dragging
                  ? 'border-nova-violet bg-nova-violet/5'
                  : 'border-nova-border bg-nova-surface/50 hover:border-nova-border-bright'
              }`}
            >
              <Icon icon={ciFileUpload} width={32} height={32} className="text-nova-text-muted" />
              <span className="text-sm text-nova-text-secondary">
                Drop a log file or click to browse
              </span>
              <span className="text-xs text-nova-text-muted">.json files from .log/ directory</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleFile(file)
                }}
              />
            </div>

            {/* Error */}
            {replayError && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-4 px-4 py-3 bg-nova-rose/10 border border-nova-rose/20 rounded-lg text-sm text-rose-400"
              >
                {replayError}
              </motion.div>
            )}

            {/* Parsed log metadata */}
            {parsed && !replayError && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-4 p-4 bg-nova-surface border border-nova-border rounded-lg"
              >
                <div className="flex items-start gap-3">
                  <Icon icon={ciFileDocument} width={24} height={24} className="text-nova-violet-bright shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{parsed.log.app_name ?? parsed.fileName}</p>
                    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-nova-text-secondary">
                      <span>Date: {formatDate(parsed.log.started_at)}</span>
                      <span>Events: {parsed.log.events.length}</span>
                      <span>Cost: {formatCost(parsed.log.total_cost_estimate)}</span>
                      <span>{parsed.log.finished_at ? 'Completed' : 'Abandoned'}</span>
                    </div>
                  </div>
                </div>

                <Button
                  onClick={handleLoadReplay}
                  className="mt-4 w-full"
                  size="sm"
                >
                  Load Replay
                </Button>
              </motion.div>
            )}
          </section>
        </motion.div>
      </main>
    </div>
  )
}
