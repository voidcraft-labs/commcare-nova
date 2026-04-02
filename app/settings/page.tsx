'use client'
import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import { Icon } from '@iconify/react/offline'
import ciArrowLeft from '@iconify-icons/ci/arrow-left-md'
import ciUndo from '@iconify-icons/ci/undo'
import ciLogout from '@iconify-icons/ci/log-out'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'
import { ApiKeyInput } from '@/components/ui/ApiKeyInput'
import { useSettings } from '@/hooks/useSettings'
import { useAuth } from '@/hooks/useAuth'
import { StageCard, AGENT_STAGE } from '@/components/settings/StageCard'
import { LogReplaySection } from '@/components/settings/LogReplaySection'

interface ModelInfo {
  id: string
  display_name: string
  created_at: string
}

export default function SettingsPage() {
  const router = useRouter()
  const { settings, updateSettings, updatePipelineStage, resetToDefaults } = useSettings()
  const { user, isAuthenticated, isPending: authPending, signOut } = useAuth()
  const [editingKey, setEditingKey] = useState<string | undefined>(undefined)
  const keyInput = editingKey ?? settings.apiKey
  const keySaved = editingKey === undefined && !!settings.apiKey
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelsFetched, setModelsFetched] = useState(false)
  const [modelsError, setModelsError] = useState<string>()

  const fetchModels = useCallback(async (apiKey?: string) => {
    try {
      const res = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        /* Authenticated users don't need an apiKey — the server uses its own */
        body: JSON.stringify(apiKey ? { apiKey } : {}),
      })
      const data = await res.json()
      if (data.error) {
        setModelsError(data.error)
        setModels([])
      } else {
        setModels(data.models ?? [])
        setModelsError(undefined)
      }
    } catch {
      setModelsError('Failed to fetch models')
      setModels([])
    } finally {
      setModelsFetched(true)
    }
  }, [])

  /* Fetch models when API key is available or user is authenticated. */
  useEffect(() => {
    if (settings.apiKey) {
      fetchModels(settings.apiKey)
    } else if (isAuthenticated) {
      fetchModels()
    }
  }, [settings.apiKey, isAuthenticated, fetchModels])

  const handleSaveKey = () => {
    updateSettings({ apiKey: keyInput })
    setEditingKey(undefined)
    if (keyInput) fetchModels(keyInput)
  }

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
          {/* ── Account ─────────────────────────────────────── */}
          {isAuthenticated && user && (
            <section className="rounded-xl border border-nova-border bg-nova-deep p-6">
              <h2 className="text-sm font-display font-semibold tracking-wide uppercase text-nova-text-secondary mb-4">Account</h2>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {user.image && (
                    <img
                      src={user.image}
                      alt=""
                      referrerPolicy="no-referrer"
                      className="w-9 h-9 rounded-full border border-nova-border"
                    />
                  )}
                  <div>
                    <p className="text-sm font-medium text-nova-text">{user.name}</p>
                    <p className="text-xs text-nova-text-muted">{user.email}</p>
                  </div>
                </div>
                <Button onClick={signOut} variant="ghost" size="sm">
                  <Icon icon={ciLogout} width="14" height="14" />
                  Sign out
                </Button>
              </div>
            </section>
          )}

          {/* ── API Key ──────────────────────────────────── */}
          <section className="rounded-xl border border-nova-border bg-nova-deep p-6">
            <h2 className="text-sm font-display font-semibold tracking-wide uppercase text-nova-text-secondary mb-1">
              {isAuthenticated ? 'API Key Override' : 'API Key'}
            </h2>
            <p className="text-xs text-nova-text-muted mb-4">
              {isAuthenticated
                ? 'Optional — override the server key with your own Anthropic API key.'
                : 'Your Anthropic API key. Stored locally in your browser.'}
            </p>
            <ApiKeyInput
              value={keyInput}
              onChange={(v) => setEditingKey(v)}
              onSave={handleSaveKey}
              saved={keySaved}
            />
          </section>

          {/* ── Pipeline Models ──────────────────────────── */}
          <section className="rounded-xl border border-nova-border bg-nova-deep p-6">
            <h2 className="text-sm font-display font-semibold tracking-wide uppercase text-nova-text-secondary mb-1">Pipeline Configuration</h2>
            <p className="text-xs text-nova-text-muted mb-5">
              Model, token limit, and reasoning settings for each stage.
            </p>

            {/* Agent stage */}
            <div className="space-y-2.5">
              <StageCard stage={AGENT_STAGE} index={0} settings={settings} models={models} hasModelAccess={isAuthenticated || !!settings.apiKey} updatePipelineStage={updatePipelineStage} />
            </div>


{modelsError && modelsFetched && (
              <p className="text-xs text-nova-rose mt-3">{modelsError}</p>
            )}
            {!settings.apiKey && !isAuthenticated && (
              <p className="text-xs text-nova-text-muted mt-3">
                Sign in or enter an API key to load available models.
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
          <LogReplaySection />
        </motion.div>
      </main>
    </div>
  )
}
