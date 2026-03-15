'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import { Icon } from '@iconify/react'
import ciArrowLeft from '@iconify-icons/ci/arrow-left-md'
import ciUndo from '@iconify-icons/ci/undo'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'
import { ApiKeyInput } from '@/components/ui/ApiKeyInput'
import { useSettings } from '@/hooks/useSettings'
import type { PipelineConfig } from '@/lib/types/settings'

interface ModelInfo {
  id: string
  display_name: string
  created_at: string
}

const STAGES: { key: keyof PipelineConfig; label: string; description: string }[] = [
  { key: 'pm', label: 'Product Manager', description: 'Conversational agent that gathers requirements' },
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

export default function SettingsPage() {
  const router = useRouter()
  const { settings, loaded, updateSettings, updatePipelineStage, resetToDefaults } = useSettings()
  const [keyInput, setKeyInput] = useState('')
  const [keySaved, setKeySaved] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelsFetched, setModelsFetched] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)

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
          className="space-y-10"
        >
          {/* ── API Key ──────────────────────────────────── */}
          <section>
            <h2 className="text-lg font-display font-semibold mb-1">API Key</h2>
            <p className="text-sm text-nova-text-muted mb-4">
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
          <section>
            <h2 className="text-lg font-display font-semibold mb-1">Pipeline Models</h2>
            <p className="text-sm text-nova-text-muted mb-5">
              Choose which model powers each stage of the generation pipeline.
            </p>
            <div className="space-y-3">
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
                            const updates: { model: string; maxOutputTokens?: number } = { model: newModel }
                            if (currentTokens > 0 && currentTokens > cap) updates.maxOutputTokens = cap
                            updatePipelineStage(stage.key, updates)
                          }}
                          className="w-full px-3 py-2 bg-nova-deep border border-nova-border rounded-lg text-sm text-nova-text focus:outline-none focus:border-nova-violet transition-colors appearance-none cursor-pointer"
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
                          className="w-full px-3 py-2 bg-nova-deep border border-nova-border rounded-lg text-sm text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:border-nova-violet transition-colors disabled:opacity-40"
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
                        className="w-full px-3 py-2 bg-nova-deep border border-nova-border rounded-lg text-sm text-nova-text focus:outline-none focus:border-nova-violet transition-colors appearance-none cursor-pointer"
                      >
                        {getTokenOptions(settings.pipeline[stage.key].model).map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
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
          </section>

          {/* ── Reset ────────────────────────────────────── */}
          <section className="pt-2 border-t border-nova-border">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-medium text-nova-text-secondary">Reset Pipeline Config</h2>
                <p className="text-xs text-nova-text-muted mt-0.5">
                  Restore all models and token limits to their defaults.
                </p>
              </div>
              <Button
                onClick={resetToDefaults}
                variant="ghost"
                size="sm"
              >
                <Icon icon={ciUndo} width="14" height="14" />
                Reset to Defaults
              </Button>
            </div>
          </section>
        </motion.div>
      </main>
    </div>
  )
}
