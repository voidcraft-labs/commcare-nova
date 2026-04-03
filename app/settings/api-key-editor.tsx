'use client'
import { useState } from 'react'
import { motion } from 'motion/react'
import { ApiKeyInput } from '@/components/ui/ApiKeyInput'
import { useSettings } from '@/hooks/useSettings'

interface ApiKeyEditorProps {
  /** Whether the user is authenticated — controls label text for the API key field. */
  isAuthenticated: boolean
}

/**
 * API key editor — manages the BYOK key input with localStorage persistence.
 *
 * Auth status is resolved server-side and passed as a prop to control the
 * label text ("API Key Override" for authenticated users, "API Key" for BYOK).
 * The header and page wrapper are owned by the server page component.
 */
export function ApiKeyEditor({ isAuthenticated }: ApiKeyEditorProps) {
  const { settings, updateSettings } = useSettings()
  const [editingKey, setEditingKey] = useState<string | undefined>(undefined)
  const keyInput = editingKey ?? settings.apiKey
  const keySaved = editingKey === undefined && !!settings.apiKey

  const handleSaveKey = () => {
    updateSettings({ apiKey: keyInput })
    setEditingKey(undefined)
  }

  return (
    <main className="max-w-2xl mx-auto px-6 py-10">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="space-y-6"
      >
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
      </motion.div>
    </main>
  )
}
