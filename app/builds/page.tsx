'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'
import type { Build } from '@/lib/types'

export default function BuildsPage() {
  const router = useRouter()
  const [builds, setBuilds] = useState<Build[]>([])

  useEffect(() => {
    const stored = localStorage.getItem('nova-builds')
    if (stored) {
      try { setBuilds(JSON.parse(stored)) } catch { /* ignore */ }
    }
  }, [])

  return (
    <div className="min-h-screen bg-nova-void">
      <header className="border-b border-nova-border px-6 py-4 flex items-center justify-between">
        <div className="cursor-pointer" onClick={() => router.push('/')}>
          <Logo size="sm" />
        </div>
        <Button onClick={() => router.push('/build/new')} size="sm">
          New Build
        </Button>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-display font-semibold mb-8">Your Builds</h1>

        {builds.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-20"
          >
            <p className="text-nova-text-secondary mb-4">No builds yet</p>
            <Button onClick={() => router.push('/build/new')}>
              Create your first app
            </Button>
          </motion.div>
        ) : (
          <div className="grid gap-3">
            {builds.map((build, i) => (
              <motion.div
                key={build.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                onClick={() => router.push(`/build/${build.id}`)}
                className="p-4 bg-nova-surface border border-nova-border rounded-lg cursor-pointer hover:border-nova-border-bright transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-medium">{build.name}</h3>
                    <p className="text-sm text-nova-text-secondary mt-1">
                      {new Date(build.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded-md ${
                    build.phase === 'done' ? 'bg-nova-emerald/15 text-emerald-400' :
                    build.phase === 'error' ? 'bg-nova-rose/15 text-rose-400' :
                    'bg-nova-surface text-nova-text-secondary'
                  }`}>
                    {build.phase}
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
