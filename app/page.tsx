'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import { Icon } from '@iconify/react'
import ciSettings from '@iconify-icons/ci/settings'
import ciArrowRight from '@iconify-icons/ci/arrow-right-md'
import Link from 'next/link'
import { Logo } from '@/components/ui/Logo'
import { useSettings } from '@/hooks/useSettings'

export default function LandingPage() {
  const router = useRouter()
  const { settings, loaded, updateSettings } = useSettings()
  const [apiKey, setApiKey] = useState('')

  const startBuilding = () => {
    if (!apiKey.trim()) return
    updateSettings({ apiKey: apiKey.trim() })
    router.push('/build/new')
  }

  if (!loaded) return null
  if (settings.apiKey) { router.replace('/build/new'); return null }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden">
      <Link
        href="/settings"
        className="absolute top-4 right-4 z-20 p-1.5 text-nova-text-muted hover:text-nova-text transition-colors rounded-lg hover:bg-nova-surface"
        title="Settings"
      >
        <Icon icon={ciSettings} width="18" height="18" />
      </Link>

      {/* Cosmic background */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[800px] h-[800px] rounded-full bg-nova-violet/5 blur-[120px]" />
        <div className="absolute bottom-0 left-1/4 w-[600px] h-[600px] rounded-full bg-nova-cyan/3 blur-[100px]" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 flex flex-col items-center gap-8 max-w-md w-full px-6"
      >
        <Logo size="lg" />

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3, duration: 0.6 }}
          className="text-nova-text-secondary text-center text-lg font-light"
        >
          Build CommCare apps from conversation
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.6 }}
          className="w-full space-y-4"
        >
          <div>
            <label className="text-sm text-nova-text-secondary font-medium block mb-1.5">
              Anthropic API Key
            </label>
            <div className="relative">
              <input
                type="password"
                placeholder="sk-ant-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') startBuilding() }}
                className="w-full px-4 py-3 pr-14 bg-nova-deep border border-nova-border rounded-lg text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:border-nova-violet focus:shadow-[var(--nova-glow-violet)] transition-all duration-200"
              />
              <button
                onClick={startBuilding}
                disabled={!apiKey.trim()}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-md bg-nova-violet text-white hover:bg-nova-violet-bright transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              >
                <Icon icon={ciArrowRight} width="18" height="18" />
              </button>
            </div>
          </div>

          <p className="text-xs text-nova-text-muted text-center">
            Your API key stays in your browser. Never sent to our servers.
          </p>
        </motion.div>
      </motion.div>
    </div>
  )
}
