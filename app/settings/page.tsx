'use client'
import { useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import { Icon } from '@iconify/react'
import ciFileUpload from '@iconify-icons/ci/file-upload'
import ciFileDocument from '@iconify-icons/ci/file-document'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'
import { extractReplayStages, setReplayData } from '@/lib/services/logReplay'
import type { RunLog } from '@/lib/services/runLogger'

interface ParsedLog {
  log: RunLog
  fileName: string
}

export default function SettingsPage() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<ParsedLog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const handleFile = useCallback((file: File) => {
    setError(null)
    setParsed(null)

    if (!file.name.endsWith('.json')) {
      setError('Please select a .json file.')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      try {
        const log = JSON.parse(reader.result as string) as RunLog
        if (!log.events || !Array.isArray(log.events)) {
          setError('This file does not appear to be a valid run log (no events array).')
          return
        }
        setParsed({ log, fileName: file.name })
      } catch {
        setError('Failed to parse JSON file.')
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
      setError(result.error)
      return
    }
    setReplayData(result.stages, result.appName)
    router.push('/build/new')
  }, [parsed, router])

  const formatCost = (cost: number) => `$${cost.toFixed(4)}`
  const formatDate = (iso: string) => new Date(iso).toLocaleString()

  return (
    <div className="min-h-screen bg-nova-void">
      <header className="border-b border-nova-border px-6 py-4 flex items-center justify-between">
        <div className="cursor-pointer" onClick={() => router.push('/')}>
          <Logo size="sm" />
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-display font-semibold mb-8">Settings</h1>

        <section>
          <h2 className="text-lg font-medium mb-4">Log Replay</h2>
          <p className="text-sm text-nova-text-secondary mb-4">
            Load a run log to replay the generation stages in the builder UI without making API calls.
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
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4 px-4 py-3 bg-nova-rose/10 border border-nova-rose/20 rounded-lg text-sm text-rose-400"
            >
              {error}
            </motion.div>
          )}

          {/* Parsed log metadata */}
          {parsed && !error && (
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
      </main>
    </div>
  )
}
