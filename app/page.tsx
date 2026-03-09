'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

export default function LandingPage() {
  const router = useRouter()
  const [apiKey, setApiKey] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem('nova-api-key')
    if (stored) {
      setApiKey(stored)
      setSaved(true)
    }
  }, [])

  const saveKey = () => {
    localStorage.setItem('nova-api-key', apiKey)
    setSaved(true)
  }

  const startBuilding = () => {
    if (!apiKey) return
    localStorage.setItem('nova-api-key', apiKey)
    router.push('/build/new')
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden">
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
          <div className="relative">
            <Input
              type="password"
              placeholder="sk-ant-..."
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setSaved(false) }}
              label="Anthropic API Key"
            />
            {saved && apiKey && (
              <div className="absolute right-3 top-[38px] text-nova-emerald text-xs flex items-center gap-1">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Saved
              </div>
            )}
          </div>

          <Button
            onClick={startBuilding}
            disabled={!apiKey}
            size="lg"
            className="w-full"
          >
            Start Building
          </Button>

          <p className="text-xs text-nova-text-muted text-center">
            Your API key stays in your browser. Never sent to our servers.
          </p>
        </motion.div>
      </motion.div>
    </div>
  )
}
