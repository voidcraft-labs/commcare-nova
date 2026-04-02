'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import { Icon } from '@iconify/react/offline'
import ciSettings from '@iconify-icons/ci/settings'
import ciArrowRight from '@iconify-icons/ci/arrow-right-md'
import Link from 'next/link'
import { Logo } from '@/components/ui/Logo'
import { useSettings } from '@/hooks/useSettings'
import { useAuth } from '@/hooks/useAuth'

/** Google "G" logo for the sign-in button. Inline SVG to avoid external dependencies. */
function GoogleLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  )
}

/**
 * Landing page client component — sign-in UI and BYOK entry.
 *
 * Server component already redirected authenticated users to /builds.
 * This handles: BYOK redirect (localStorage check), Google OAuth initiation,
 * and API key input.
 */
export function Landing() {
  const router = useRouter()
  const { settings, updateSettings } = useSettings()
  const { signIn } = useAuth()
  const [apiKey, setApiKey] = useState('')
  const [signingIn, setSigningIn] = useState(false)

  const hasByokKey = !!settings.apiKey

  /** BYOK entry — save key and navigate to builder. */
  const startWithKey = () => {
    if (!apiKey.trim()) return
    updateSettings({ apiKey: apiKey.trim() })
    router.push('/build/new')
  }

  /** Google OAuth entry — sign in and redirect to builder on success. */
  const signInWithGoogle = async () => {
    setSigningIn(true)
    await signIn()
  }

  /* BYOK users with a saved key go straight to the builder. */
  useEffect(() => {
    if (hasByokKey) router.replace('/build/new')
  }, [hasByokKey, router])

  /* Don't flash the landing UI while redirecting BYOK users. */
  if (hasByokKey) return null

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

        {/* ── Primary: Google sign-in ──────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.6 }}
          className="w-full space-y-6"
        >
          <button
            onClick={signInWithGoogle}
            disabled={signingIn}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-white text-gray-800 font-medium rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shadow-sm"
          >
            <GoogleLogo />
            {signingIn ? 'Redirecting...' : 'Sign in with Google'}
          </button>

          {/* ── Divider ────────────────────────────────────── */}
          <div className="flex items-center gap-4">
            <div className="flex-1 h-px bg-nova-border" />
            <span className="text-xs text-nova-text-muted uppercase tracking-wider">or use your own key</span>
            <div className="flex-1 h-px bg-nova-border" />
          </div>

          {/* ── Secondary: BYOK input ──────────────────────── */}
          <div>
            <div className="relative">
              <input
                type="password"
                placeholder="sk-ant-..."
                aria-label="Anthropic API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') startWithKey() }}
                autoComplete="off"
                data-1p-ignore
                className="w-full px-4 py-3 pr-14 bg-nova-deep border border-nova-border rounded-lg text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:border-nova-violet focus:shadow-[var(--nova-glow-violet)] transition-all duration-200"
              />
              <button
                onClick={startWithKey}
                disabled={!apiKey.trim()}
                aria-label="Start with API key"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-md bg-nova-violet text-white hover:bg-nova-violet-bright transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              >
                <Icon icon={ciArrowRight} width="18" height="18" />
              </button>
            </div>
            <p className="text-xs text-nova-text-muted text-center mt-2">
              Anthropic API key — stored locally in your browser, never sent to our servers.
            </p>
          </div>
        </motion.div>
      </motion.div>
    </div>
  )
}
