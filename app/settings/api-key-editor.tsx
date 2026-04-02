'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { motion } from 'motion/react'
import { Icon } from '@iconify/react/offline'
import ciArrowLeft from '@iconify-icons/ci/arrow-left-md'
import { Logo } from '@/components/ui/Logo'
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
 */
export function ApiKeyEditor({ isAuthenticated }: ApiKeyEditorProps) {
  const router = useRouter()
  const { settings, updateSettings } = useSettings()
  const [editingKey, setEditingKey] = useState<string | undefined>(undefined)
  const keyInput = editingKey ?? settings.apiKey
  const keySaved = editingKey === undefined && !!settings.apiKey

  const handleSaveKey = () => {
    updateSettings({ apiKey: keyInput })
    setEditingKey(undefined)
  }

  return (
    <div className="min-h-screen bg-nova-void">
      {/* Header */}
      <header className="border-b border-nova-border px-6 py-3 flex items-center gap-4">
        <button
          onClick={() => router.back()}
          aria-label="Go back"
          className="p-1.5 -ml-1.5 text-nova-text-secondary hover:text-nova-text transition-colors rounded-lg hover:bg-nova-surface"
        >
          <Icon icon={ciArrowLeft} width="20" height="20" />
        </button>
        <Link href="/">
          <Logo size="sm" />
        </Link>
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
    </div>
  )
}
